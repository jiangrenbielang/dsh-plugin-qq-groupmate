/**
 * 生图：群友点名要图时画一张，画好把图片发出去。
 *
 * 主路是网页引擎（见 rphub-browser.js）：无头浏览器打开配置里的生图页面，
 * 由网页自己的生图流程出图，拿到出图地址后经 wsrv.nl 中转抢跑下载到本地再发。
 * 这条线路实测能把「出图→拿到图」压进十几~二十几秒（直连下载一张 1.8MB 要 70 秒以上：
 * 源站对这条线路限速 ~25KB/s 且不支持 Range 分片，中转线路 200~800KB/s）。
 *
 * 引擎不可用时退回直连接口兜底（旧链路，参数在 settings 里原样保留）：
 *   ① `GET /generate?nocache=0` 同步接口（命中服务端缓存秒回）
 *   ② `POST /api/jobs` → 轮询 → 下载
 *
 * 画风/模型/额度这套玩法移植自大佬的 AstrBot 插件 astrbot_plugin_nai2api：
 * 每次生成可以带一份 `ImageOverrides`（模型、画风、尺寸、种子、负面词），
 * 由 nai-presets.ts 解析画师串、nai-policy.ts 管 V5 的 24 小时额度。
 *
 * 生成慢，不能占着群里的回复锁：`ImageGenQueue` 后台排队，画好一张发一张，
 * 每个群有排队上限，免得被刷屏。
 */
import dns from 'node:dns';
import https from 'node:https';
import { RphubBrowserEngine } from "./rphub-browser.js";
import { V5_MODEL } from "./nai-presets.js";
/** 生图标记：`[生图:英文标签]`（也认「画图」「绘图」，全角冒号）。 */
const IMAGE_MARKER = /\[(?:生图|画图|绘图)[:：]\s*([^\]\n]+?)\s*\]/gu;
/**
 * 从回复里拆出「要画的图」和「剩下的文字」。
 * @param reply - 模型回复（可能带多个标记）。
 * @returns 去掉标记的文字，和按出现顺序排列的画面标签。
 */
export function parseImageRequests(reply) {
    const prompts = [];
    const text = reply
        .replace(IMAGE_MARKER, (_, prompt) => {
        const trimmed = prompt.trim();
        if (trimmed !== '')
            prompts.push(trimmed);
        return '';
    })
        .replace(/[ \t]+/gu, ' ')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
    return { text, prompts };
}
/** 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 2500;
/** 提交/下载失败后的重试间隔（毫秒）。 */
const SUBMIT_RETRY_DELAY_MS = 3000;
/** 轮询连续失败多少次算任务失败（服务端偶发 5xx 时先重试）。 */
const POLL_MAX_ERRORS = 6;
/** 提交/轮询/查账号这类小请求的超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * 下载出图的超时（毫秒）。出图是整张位图（一两 MB），
 * 弱网下比小请求慢得多，给足时间——默认发送方式是把地址交给协议端下载，
 * 走这条路只在「协议端下载不了」时才发生。
 */
const DOWNLOAD_TIMEOUT_MS = 600_000;
/** 下载出图的字节上限。 */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
/** 睡一会儿；定时器不占住事件循环。 */
function sleep(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}
/** 任务被服务端明确拒绝（额度不足、密钥无效、参数不对）：同步兜底也不会成功，直接抛。 */
class JobRejectedError extends Error {
}
/** 任务超时：同步兜底要再等一整轮超时，群友等不起，直接抛。 */
class JobTimeoutError extends Error {
}
/** V5 额度用尽：不该退回直连重试（会白扣一张），直接把原因告诉群友。 */
export class V5QuotaError extends Error {
    constructor(message) {
        super(message);
        this.name = 'V5QuotaError';
    }
}
/** 按尺寸估算一次生成的点数：普通 1 点，2K 15 点，4K 25 点（跟服务端一致）。 */
export function defaultImageCostForSize(size) {
    if (size.startsWith('4K'))
        return 25;
    if (size.startsWith('2K'))
        return 15;
    return 1;
}
/** 数字字段宽松解析：不是有限数字就当没给。 */
function toNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
/** 下载出图走的中转（它到源站的线路比直连快一个数量级，实测 2~14 秒拉完一张）。 */
const RELAY_BASE = 'https://wsrv.nl/?url=';
/** 把出图地址折算成中转地址；`n=-1` 让它别对动图做逐帧处理。 */
export function relayUrlOf(url) {
    return `${RELAY_BASE}${encodeURIComponent(url)}&n=-1`;
}
/** 候选的 Cloudflare 边缘 IP：实测从国内宽带走得比较顺的几个段。 */
const EDGE_CANDIDATES = [
    '104.18.0.1',
    '104.16.0.1',
    '104.19.0.1',
    '104.17.0.1',
    '104.20.0.1',
    '172.66.0.1',
    '162.159.0.1',
];
/** 单个候选节点的探测超时（毫秒）。 */
const PROBE_TIMEOUT_MS = 3500;
/** 把这次连接的解析固定到指定 IP（lookup 是连接级选项，不动全局解析）。 */
function pinnedLookup(ip) {
    return (_hostname, options, callback) => {
        // Node 开着 autoSelectFamily 时会用 all: true 来问，这种必须回数组。
        const wantsAll = typeof options === 'object' && options !== null && options.all === true;
        if (wantsAll)
            callback(null, [{ address: ip, family: 4 }]);
        else
            callback(null, ip, 4);
    };
}
/**
 * 单发一个探测请求，返回耗时；失败或超时返回 Infinity。
 * @param url - 探测地址。
 * @param ip - 指定边缘 IP；不给就走系统 DNS。
 * @param timeoutMs - 超时（毫秒）。
 */
function probeDelay(url, ip, timeoutMs) {
    return new Promise((resolve) => {
        const target = new URL(url);
        const started = Date.now();
        const options = {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port === '' ? 443 : Number(target.port),
            path: target.pathname + target.search,
            method: 'GET',
            headers: { 'user-agent': 'qq-groupmate/link-pick' },
        };
        if (ip !== undefined)
            options.lookup = pinnedLookup(ip);
        const request = https.request(options, (response) => {
            const status = response.statusCode ?? 0;
            response.resume();
            response.on('end', () => {
                // 只有目标域名真的答了才算数：有些 CF 段并不代理它，会飞快地回 403。
                resolve(status === 200 ? Date.now() - started : Number.POSITIVE_INFINITY);
            });
            response.on('error', () => { resolve(Number.POSITIVE_INFINITY); });
        });
        request.setTimeout(timeoutMs, () => {
            request.destroy();
            resolve(Number.POSITIVE_INFINITY);
        });
        request.on('error', () => { resolve(Number.POSITIVE_INFINITY); });
        request.end();
    });
}
/** 当前生效的优选器（模块级：插件重载时只换实例，不重复套钩子）。 */
const linkPickBox = { current: undefined };
let linkHookInstalled = false;
/** 把优选器接到 dns.lookup 上；整个进程只装一次。 */
function installLinkPick(pick) {
    linkPickBox.current = pick;
    if (linkHookInstalled)
        return;
    linkHookInstalled = true;
    const original = dns.lookup;
    const patched = function patchedLookup(hostname, options, callback) {
        const active = linkPickBox.current;
        const done = (typeof options === 'function' ? options : callback);
        if (active === undefined || done === undefined || !active.handles(hostname)) {
            original.call(dns, hostname, options, callback);
            return;
        }
        const address = active.address();
        const wantsAll = typeof options === 'object' && options !== null && options.all === true;
        process.nextTick(() => {
            if (wantsAll)
                done(null, [{ address, family: 4 }]);
            else
                done(null, address, 4);
        });
    };
    const box = dns;
    box.lookup = patched;
}
/**
 * 生图域名的链路优选：把域名固定到跑得最快的 Cloudflare 边缘节点。
 *
 * 起因：某些宽带上，域名解析到的特定 CF 边缘 IP 会被劣化——实测同一张 1.4MB 的图，
 * 系统 DNS 给的 IP 只有 30~50KB/s（最差整条连接干等 839 秒），换个 CF 节点就是 800KB/s。
 * 换 DNS 解决不了（国内公共 DoH 返回的是同一批 IP），改 hosts 又要管理员权限，
 * 所以在进程内改 dns.lookup，且只拦这一个域名。
 *
 * 开箱即用、自适应：第一次下载前并发探一遍候选节点，谁快固定谁；
 * 系统 DNS 本来就最快就不动它——网络正常的机器上等于没装。
 */
class LinkPick {
    host;
    probeUrl;
    logger;
    /** 当前固定的 IP；空串表示不干预解析。 */
    chosen = '';
    /** 候选节点，按探测耗时排序（换节点时按这个顺序走）。 */
    candidates = [];
    /** 选定之后才让钩子生效。 */
    ready = false;
    constructor(host, probeUrl, logger) {
        this.host = host;
        this.probeUrl = probeUrl;
        this.logger = logger;
    }
    /** 给一个服务地址造优选器；地址不合法就返回 undefined（等于不启用）。 */
    static forBaseUrl(baseUrl, token, logger) {
        let parsed;
        try {
            parsed = new URL(baseUrl);
        }
        catch {
            return undefined;
        }
        if (parsed.hostname === '')
            return undefined;
        const probeUrl = parsed.origin + '/api/me?token=' + encodeURIComponent(token);
        return new LinkPick(parsed.hostname, probeUrl, logger);
    }
    /** 探一遍候选节点，固定最快的那个。 */
    async pick() {
        const results = await Promise.all([
            probeDelay(this.probeUrl, undefined, PROBE_TIMEOUT_MS).then((ms) => ({ ip: '', ms })),
            ...EDGE_CANDIDATES.map((ip) => probeDelay(this.probeUrl, ip, PROBE_TIMEOUT_MS).then((ms) => ({ ip, ms }))),
        ]);
        const usable = results
            .filter((item) => Number.isFinite(item.ms))
            .sort((left, right) => left.ms - right.ms);
        const best = usable[0];
        if (best === undefined) {
            this.logger.warn('qq-groupmate: 生图链路探测全部超时，继续用系统 DNS');
            return;
        }
        const system = results[0]?.ms ?? Number.POSITIVE_INFINITY;
        if (best.ip === '') {
            if (!usable.some((item) => item.ip !== '')) {
                this.logger.warn('qq-groupmate: 生图链路探测：%s 个候选节点全都没通，继续用系统 DNS', String(EDGE_CANDIDATES.length));
            }
            this.logger.info('qq-groupmate: 生图链路探测：系统 DNS 最快（%s ms），不干预解析', String(best.ms));
            return;
        }
        this.candidates = usable.filter((item) => item.ip !== '').map((item) => item.ip);
        this.chosen = best.ip;
        this.ready = true;
        installLinkPick(this);
        this.logger.info('qq-groupmate: 生图链路探测：固定到 %s（%s ms；系统 DNS %s），备选 %s 个', best.ip, String(best.ms), Number.isFinite(system) ? String(system) + ' ms' : '超时', String(this.candidates.length));
    }
    /** 换下一个候选节点（当前链路走不通时用）。 */
    rotate() {
        if (this.candidates.length <= 1)
            return;
        const index = this.candidates.indexOf(this.chosen);
        const next = this.candidates[(index + 1) % this.candidates.length] ?? '';
        if (next === '' || next === this.chosen)
            return;
        this.chosen = next;
        this.logger.warn('qq-groupmate: 生图下载换用备用节点 %s', next);
    }
    /** 这个域名现在归它管吗。 */
    handles(hostname) {
        return this.ready && hostname === this.host && this.chosen !== '';
    }
    /** 此刻要用的 IP。 */
    address() {
        return this.chosen;
    }
}
/** Nai2API 任务式生图客户端。 */
export class ImageGenClient {
    settings;
    logger;
    policy;
    browserEngine = null;
    /** 上一次浏览器引擎用的参数指纹：变了就要重建（引擎把参数写进页面 settings）。 */
    browserKey = '';
    /** 链路优选：第一次下载前探一遍候选节点，见 LinkPick。 */
    link;
    /** 优选只探一次，多条并发下载共用同一个 promise。 */
    linkReady;
    constructor(settings, logger, 
    /** 模型策略：查/切模型、V5 额度。没给就不做限额。 */
    policy) {
        this.settings = settings;
        this.logger = logger;
        this.policy = policy;
        this.link = LinkPick.forBaseUrl(settings.baseUrl, settings.token, logger);
    }
    /** 是否可用：开关打开且填了密钥。 */
    get enabled() {
        return this.settings.enabled && this.settings.token.trim() !== '';
    }
    /**
     * 查一次账号：密钥是否有效、还剩多少点数。
     * @returns 账号信息；网络失败或响应异常时返回 `undefined`。
     */
    async checkAccount() {
        try {
            const response = await this.request(`${this.base()}/api/me?token=${encodeURIComponent(this.settings.token)}`);
            if (!response.ok) {
                this.logger.warn('qq-groupmate: 生图密钥校验失败（HTTP %s），请检查密钥', String(response.status));
                return undefined;
            }
            const data = await response.json();
            return {
                balance: toNumber(data.balance) ?? 0,
                enabled: data.enabled === true,
                note: typeof data.note === 'string' ? data.note : '',
            };
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 查生图账号失败：%s', String(error));
            return undefined;
        }
    }
    async generate(prompt, overrides = {}) {
        if (!this.enabled)
            throw new Error('生图未启用或没填密钥');
        // 顺手把链路探测挂到后台（不 await）：等出完图要下载时，它多半已经探好了。
        void this.ensureLink();
        const settings = this.effectiveSettings(overrides);
        const started = Date.now();
        if (settings.browserEnabled) {
            try {
                return await this.generateViaBrowser(prompt, overrides, settings);
            }
            catch (error) {
                // 额度类错误不是引擎的问题，别退回直连（会白扣一张）。
                if (error instanceof V5QuotaError)
                    throw error;
                this.logger.warn('qq-groupmate: 网页引擎失败（%s），退回直连接口', String(error).split('\n')[0]);
                await this.disposeBrowser().catch(() => { });
            }
        }
        // 引擎失败退回直连时会再占一次额度：先把上一次占的还回去，避免白扣。
        this.refundQuota(overrides);
        try {
            const image = await this.generateViaSync(prompt, overrides, settings);
            this.logger.info('qq-groupmate: 出图成功（%s 秒）', ((Date.now() - started) / 1000).toFixed(1));
            return image;
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 同步接口失败（%s），退回任务式接口', String(error).split('\n')[0]);
        }
        return await this.generateViaJobs(prompt, overrides, settings);
    }
    /** 这次生成实际用的设置：覆盖项优先，其余用配置值。 */
    effectiveSettings(overrides) {
        const size = overrides.size !== undefined && overrides.size.trim() !== '' ? overrides.size.trim() : this.settings.size;
        const model = overrides.resolved?.model ?? overrides.model ?? this.settings.model;
        const artist = overrides.resolved !== undefined
            ? overrides.resolved.artist
            : (overrides.artist ?? this.settings.artist);
        const negative = overrides.negative !== undefined && overrides.negative.trim() !== ''
            ? overrides.negative.trim()
            : this.settings.negative;
        return {
            ...this.settings,
            size,
            model,
            artist,
            negative,
            cost: overrides.size !== undefined && overrides.size.trim() !== '' ? defaultImageCostForSize(size) : this.settings.cost,
        };
    }
    /** 把额度占位还回去（调用方已占、生成又失败时用）。 */
    refundQuota(overrides) {
        const resolved = overrides.resolved;
        if (resolved === undefined || resolved.quotaToken === undefined)
            return;
        const userId = overrides.userId;
        if (userId === undefined || this.policy === undefined)
            return;
        this.policy.release(userId, resolved.quotaToken);
        // 还过一次就把凭据抹掉，避免重复释放。
        resolved.quotaToken = undefined;
    }
    /**
     * 网页引擎主路：页面出图拿地址 → 中转抢跑下载（失败退直连）。
     * 返回的 url 用中转地址：协议端若自己下载（sendMode=url），走中转也比直连快得多。
     */
    async generateViaBrowser(prompt, overrides, settings) {
        const engine = this.ensureBrowserEngine(settings);
        const { imageUrl } = await engine.generateImageUrl(prompt, {
            ...(overrides.seed === undefined ? {} : { seed: overrides.seed }),
            // 网页模板里画师串/尺寸写死在 settings，重建引擎时才变；这里只传能覆盖的。
        });
        void overrides;
        this.logger.info('qq-groupmate: 网页出图完成（%s），开始下载', imageUrl.slice(0, 90));
        const relayed = settings.relayEnabled ? await this.downloadViaRelay(imageUrl) : undefined;
        const image = relayed ?? await this.downloadWithRetry(imageUrl);
        return { buffer: image.buffer, mime: image.mime, url: relayed?.relayUrl ?? imageUrl };
    }
    /**
     * 拿（必要时重建）浏览器引擎。
     *
     * 引擎把 token/模型/画师串/尺寸写进网页 settings，只有重建才会生效——
     * 所以按这几个参数做指纹，换了模型或画风就重建一次；同一套参数反复画图只起一次浏览器。
     */
    ensureBrowserEngine(settings) {
        const key = JSON.stringify({
            token: settings.token,
            model: settings.model,
            artist: settings.artist,
            size: settings.size,
            browserPath: settings.browserPath,
            browserPort: settings.browserPort,
            pageUrl: settings.pageUrl,
        });
        if (this.browserEngine !== null && this.browserKey === key)
            return this.browserEngine;
        if (this.browserEngine !== null) {
            const stale = this.browserEngine;
            this.browserEngine = null;
            void stale.dispose().catch(() => { });
            this.logger.info('qq-groupmate: 生图参数变了，重建生图浏览器');
        }
        this.browserKey = key;
        this.browserEngine = new RphubBrowserEngine({
            browserPath: settings.browserPath,
            browserPort: settings.browserPort,
            pageUrl: settings.pageUrl,
            timeoutMs: settings.timeoutSeconds * 1000 + DOWNLOAD_TIMEOUT_MS,
        }, {
            token: settings.token,
            model: settings.model,
            style: settings.artist === '' ? undefined : 'custom',
            customArtists: settings.artist === '' ? undefined : settings.artist,
            size: settings.size,
        }, this.logger);
        return this.browserEngine;
    }
    /** 停掉浏览器引擎（配置重载/卸载时调用；幂等）。 */
    async disposeBrowser() {
        const engine = this.browserEngine;
        this.browserEngine = null;
        this.browserKey = '';
        if (engine !== null)
            await engine.dispose();
    }
    /**
     * 中转抢跑下载：同一地址经 wsrv.nl 拉 N 条，谁先完成用谁。
     * 它到源站的线路质量远好于直连（实测 200~800KB/s，直连 20~25KB/s），
     * 而且它有 CDN 缓存——同图第二次起直接边缘秒回。
     */
    async downloadViaRelay(url) {
        const relayUrl = relayUrlOf(url);
        const connections = Math.max(1, Math.floor(this.settings.relayConnections ?? 6));
        try {
            const image = await this.downloadRacing(relayUrl, connections);
            this.logger.info('qq-groupmate: 中转下载完成（%sKB，%s 条连接）', String(Math.round(image.buffer.length / 1024)), String(connections));
            return { ...image, relayUrl };
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 中转下载失败（%s），退回直连', String(error).split('\n')[0]);
            return undefined;
        }
    }
    /** 任务式主路：提交（带重试）→ 轮询 → 抢跑下载（带重试）。 */
    async generateViaJobs(prompt, overrides, settings) {
        const deadline = Date.now() + settings.timeoutSeconds * 1000;
        let job = await this.submitWithRetry(prompt, overrides, settings);
        this.logger.info('qq-groupmate: 生图任务已提交（%s，排队第 %s / %s）', job.id, String(job.queuePosition ?? 0), String(job.queuedCount ?? 0));
        let errors = 0;
        while (true) {
            if (job.status === 'done') {
                const url = this.absolute(job.imageUrl);
                if (url === undefined)
                    throw new Error('生图完成但没有拿到图片地址');
                const image = await this.downloadWithRetry(url);
                return { buffer: image.buffer, mime: image.mime, url };
            }
            if (job.status === 'failed') {
                const reason = job.error === undefined || job.error === '' ? '服务端没给原因' : job.error;
                throw new JobRejectedError(`生图失败：${reason}`);
            }
            if (Date.now() >= deadline) {
                throw new JobTimeoutError(`生图超时（${String(settings.timeoutSeconds)} 秒还没画完，任务 ${job.id}）`);
            }
            await sleep(POLL_INTERVAL_MS);
            try {
                job = await this.poll(job.id);
                errors = 0;
            }
            catch (error) {
                errors += 1;
                if (errors >= POLL_MAX_ERRORS) {
                    throw new Error(`生图轮询连续失败 ${String(errors)} 次：${String(error)}`);
                }
                this.logger.warn('qq-groupmate: 生图轮询第 %s 次失败，稍后重试：%s', String(errors), String(error));
            }
        }
    }
    /**
     * 提交任务，失败自动重试。
     * nocache=0 时重试是安全的：上一次若其实已经建成任务，重试会命中服务端缓存秒回，
     * 不会重复扣点。
     */
    async submitWithRetry(prompt, overrides, settings) {
        const attempts = 3;
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                return await this.submit(prompt, overrides, settings);
            }
            catch (error) {
                lastError = error;
                this.logger.warn('qq-groupmate: 生图任务提交第 %s 次失败：%s', String(attempt), String(error).split('\n')[0]);
                if (attempt < attempts)
                    await sleep(SUBMIT_RETRY_DELAY_MS);
            }
        }
        throw lastError;
    }
    /** 下载出图，抢跑全挂时歇一下再来一轮。 */
    async downloadWithRetry(url) {
        const attempts = 2;
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            const image = await this.download(url);
            if (image !== undefined)
                return image;
            lastError = new Error('下载失败');
            if (attempt < attempts) {
                // 这条链路走不通了：换一个边缘节点再试，别在同一个 IP 上耗两轮。
                this.link?.rotate();
                await sleep(SUBMIT_RETRY_DELAY_MS);
            }
        }
        throw lastError;
    }
    /**
     * 网页引擎同款的同步接口：`GET /generate?nocache=0`，响应体就是整张图。
     * 命中服务端缓存时立刻返回；没命中则挂着连接等排队和生成（给足超时）。
     */
    async generateViaSync(prompt, overrides, settings) {
        const params = new URLSearchParams({
            tag: prompt,
            token: settings.token,
            model: settings.model,
            artist: settings.artist,
            size: settings.size,
            steps: String(settings.steps),
            scale: String(settings.scale),
            cfg: '0',
            sampler: settings.sampler,
            negative: settings.negative,
            nocache: '0',
            noise_schedule: 'karras',
        });
        if (overrides.seed !== undefined)
            params.set('seed', String(overrides.seed));
        const url = `${this.base()}/generate?${params.toString()}`;
        // 两次机会：若服务端其实已画完只是连接断了，重试会命中缓存秒回。
        // 超时 = 配置的出画等待 + 下载余量：这一条连接要包办排队、生成和整张图的传输。
        let lastError;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                return await this.downloadOnce(url, undefined, settings.timeoutSeconds * 1000 + DOWNLOAD_TIMEOUT_MS);
            }
            catch (error) {
                lastError = error;
                this.logger.warn('qq-groupmate: 同步接口第 %s 次失败：%s', String(attempt), String(error).split('\n')[0]);
                if (attempt < 2)
                    await sleep(SUBMIT_RETRY_DELAY_MS);
            }
        }
        throw lastError;
    }
    /**
     * 下载出图字节（协议端不认 URL，或要求插件自己下载时用）。
     *
     * 服务端对每条连接限速（实测 5~45 KB/s，晚高峰更低），但允许并发——
     * 多条连接抢跑（谁先下完用谁，其余中止）实测能快 2~3 倍。
     * 服务端不支持 Range 分片，所以只能整份抢，抢输的那几条白下。
     *
     * @param url - 出图地址。
     * @returns 图片字节与 MIME；取不到或不是位图时返回 `undefined`。
     */
    async download(url) {
        const connections = Math.max(1, Math.floor(this.settings.downloadConnections ?? 2));
        if (connections > 1) {
            try {
                return await this.downloadRacing(url, connections);
            }
            catch (error) {
                // 全部抢跑失败（可能整站过载）：退回单连接，把失败原因留在日志里。
                this.logger.warn('qq-groupmate: %s 条抢跑连接全部失败（%s），退回单连接重试', String(connections), String(error).split('\n')[0]);
            }
        }
        try {
            return await this.downloadOnce(url);
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 下载生成的图片失败：%s', String(error).split('\n')[0]);
            return undefined;
        }
    }
    /** 并发 N 条整份下载，取最先完成且校验通过的那份；其余立即中止。 */
    async downloadRacing(url, connections) {
        const controller = new AbortController();
        try {
            // Promise.any 对每条都挂了处理器：抢先兑现后，其余的中止拒绝会被吸收，不会变成未处理拒绝。
            return await Promise.any(Array.from({ length: connections }, () => this.downloadOnce(url, controller.signal)));
        }
        finally {
            controller.abort();
        }
    }
    /**
     * 单条连接下载并校验（必须是位图、不超上限）；失败抛错，由调用方决定怎么兜。
     * 也用于同步 /generate：那个地址的响应体就是整张图，给足超时即可。
     */
    async downloadOnce(url, signal, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
        await this.ensureLink();
        const response = await this.request(url, signal === undefined ? undefined : { signal }, timeoutMs);
        if (!response.ok)
            throw new Error(`HTTP ${String(response.status)}`);
        const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
        // 服务端出错时会返回一张 SVG 错误图（HTTP 200），不能当成品发出去。
        if (!mime.startsWith('image/') || mime.includes('svg')) {
            throw new Error(`返回的不是位图（${mime === '' ? '未知类型' : mime}）`);
        }
        const declared = toNumber(response.headers.get('content-length'));
        if (declared !== undefined && declared > MAX_IMAGE_BYTES) {
            throw new Error(`图片声明 ${String(declared)} 字节，超过上限`);
        }
        if (response.body === null)
            throw new Error('响应没有正文');
        // 流式读取并在超限时立刻取消：不信任 content-length（可能缺失或虚报）。
        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                received += value.byteLength;
                if (received > MAX_IMAGE_BYTES) {
                    await reader.cancel().catch(() => { });
                    throw new Error(`图片超过上限 ${String(MAX_IMAGE_BYTES)} 字节`);
                }
                chunks.push(Buffer.from(value));
            }
        }
        finally {
            reader.releaseLock();
        }
        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0)
            throw new Error('图片是空文件');
        return { buffer, mime };
    }
    /** 提交一个生成任务。 */
    async submit(prompt, overrides, settings) {
        const response = await this.request(`${this.base()}/api/jobs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                token: settings.token,
                tag: prompt,
                model: settings.model,
                artist: settings.artist,
                size: settings.size,
                cost: settings.cost,
                steps: settings.steps,
                scale: settings.scale,
                cfg: 0,
                sampler: settings.sampler,
                negative: settings.negative,
                ...(overrides.seed === undefined ? {} : { seed: overrides.seed }),
                // 0 = 允许命中服务端缓存：完全相同的参数直接秒回同一张图，不重新排队生成，
                // 也不扣点（实测 durationMs=0、余额不变）。默认就是 0。
                nocache: '0',
                noise_schedule: 'karras',
            }),
        });
        return this.jobOf(await this.readJson(response), response.status);
    }
    /** 查一次任务状态。 */
    async poll(id) {
        const url = `${this.base()}/api/jobs/${encodeURIComponent(id)}?token=${encodeURIComponent(this.settings.token)}`;
        const response = await this.request(url);
        return this.jobOf(await this.readJson(response), response.status);
    }
    /** 读 JSON；HTTP 不成功时尽量把服务端的说明带进错误里。 */
    async readJson(response) {
        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        }
        catch {
            data = undefined;
        }
        if (!response.ok) {
            const record = data !== null && typeof data === 'object' ? data : {};
            const detail = String(record.error ?? record.message ?? '').trim();
            throw new Error(`生图服务返回 HTTP ${String(response.status)}${detail === '' ? '' : `：${detail}`}`);
        }
        if (data === null || typeof data !== 'object')
            throw new Error('生图服务返回的不是 JSON');
        return data;
    }
    /** 把任务接口的响应折算成 ImageJob。 */
    jobOf(data, status) {
        const id = typeof data.id === 'string' ? data.id : '';
        if (id === '')
            throw new Error(`生图服务没有返回任务 id（HTTP ${String(status)}）`);
        const progress = data.generationProgress;
        const percent = progress !== null && typeof progress === 'object'
            ? toNumber(progress.percent)
            : undefined;
        return {
            id,
            status: typeof data.status === 'string' ? data.status : '',
            imageUrl: typeof data.imageUrl === 'string' ? data.imageUrl : undefined,
            error: typeof data.error === 'string' ? data.error : undefined,
            queuePosition: toNumber(data.queuePosition),
            queuedCount: toNumber(data.queuedCount),
            percent,
        };
    }
    /** 相对地址补成绝对地址；空值或解析失败返回 `undefined`。 */
    absolute(path) {
        if (path === undefined || path.trim() === '')
            return undefined;
        try {
            return new URL(path, `${this.base()}/`).href;
        }
        catch {
            return undefined;
        }
    }
    /** 服务地址去掉尾部斜杠。 */
    base() {
        return this.settings.baseUrl.replace(/\/+$/u, '');
    }
    /** 第一次下载前做一次链路优选；只做一次，探测失败也不耽误出图。 */
    async ensureLink() {
        if (this.link === undefined)
            return;
        this.linkReady ??= this.link.pick().catch(() => { });
        await this.linkReady;
    }
    /** 发请求；外部 signal 与超时信号合并，任一触发都中止。 */
    request(url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
        const timeout = AbortSignal.timeout(timeoutMs);
        const external = init?.signal instanceof AbortSignal ? init.signal : undefined;
        const signal = external === undefined ? timeout : AbortSignal.any([external, timeout]);
        return fetch(url, { ...init, signal });
    }
}
/**
 * 渲染图片下面那行信息标签（移植作者插件的 `V5 | 绝区零游戏风 | 耗时37秒`）。
 * @param info - 模型、画风、耗时。
 * @param quotaNote - 追加的额度说明；空串不加。
 */
export function renderImageInfo(info, quotaNote = '') {
    const base = `${info.modelLabel} | ${info.styleName} | 耗时${String(info.elapsedSeconds)}秒`;
    return quotaNote === '' ? base : `${base}\n${quotaNote}`;
}
/**
 * 生图队列：生成要等好几分钟，不能占着群里的回复锁，
 * 所以后台排队慢慢画，画好一张发一张。
 */
export class ImageGenQueue {
    deps;
    pending = [];
    running = false;
    disposed = false;
    constructor(deps) {
        this.deps = deps;
    }
    /** 是否可用。 */
    get enabled() {
        return this.deps.client.enabled;
    }
    /** 还在排队的张数（不含正在画的那张）。 */
    get size() {
        return this.pending.length;
    }
    /**
     * 排队画图；不阻塞调用方，画好自己发出去。
     * @param target - 发到哪个群/私聊。
     * @param prompts - 画面标签，按顺序画；超过上限的张数丢掉。
     * @param overrides - 本次的画风/模型等覆盖；队列里每张都用它。
     */
    enqueue(target, prompts, overrides = {}) {
        if (!this.enabled || this.disposed)
            return;
        const settings = this.deps.client.settings;
        const scope = scopeOf(target);
        const limit = Math.max(1, settings.maxQueue);
        let room = limit - this.pending.filter(item => item.scope === scope).length;
        for (const prompt of prompts.slice(0, Math.max(1, settings.maxPerReply))) {
            if (room <= 0) {
                this.deps.logger.warn('qq-groupmate: %s 排队的图太多（上限 %s 张），「%s」这张先不画了', scope, String(limit), prompt);
                continue;
            }
            this.pending.push({ target, scope, prompt, overrides });
            room -= 1;
        }
        void this.pump();
    }
    /** 卸载：清空排队，正在画的那张画完也不再发。 */
    dispose() {
        this.disposed = true;
        this.pending.length = 0;
    }
    /** 依次画完队列里的每一张。 */
    async pump() {
        if (this.running || this.disposed)
            return;
        this.running = true;
        try {
            while (!this.disposed) {
                const item = this.pending.shift();
                if (item === undefined)
                    break;
                const started = Date.now();
                try {
                    const image = await this.deps.client.generate(item.prompt, item.overrides);
                    if (this.disposed) {
                        // 已卸载：把占的额度还回去，别白扣。
                        this.deps.client.refundQuota(item.overrides);
                        return;
                    }
                    const elapsed = (Date.now() - started) / 1000;
                    this.deps.logger.info('qq-groupmate: 生图完成（%s 秒），正在发送', elapsed.toFixed(1));
                    await this.deps.send(item.target, image, {
                        modelLabel: item.overrides.resolved?.model === V5_MODEL ? 'V5' : 'V4.5',
                        styleName: item.overrides.resolved?.styleName ?? '默认',
                        elapsedSeconds: Math.round(elapsed),
                    });
                }
                catch (error) {
                    // 画失败：把 V5 额度还回去，让群友能重试。
                    this.deps.client.refundQuota(item.overrides);
                    this.deps.logger.warn('qq-groupmate: 生图失败（%s）：%s', item.prompt, String(error));
                    if (this.deps.client.settings.notifyOnFailure && this.deps.notify !== undefined) {
                        const reason = error instanceof V5QuotaError ? String(error.message) : '这张没画出来，等下再让我试试';
                        await this.deps.notify(item.target, reason).catch(() => { });
                    }
                }
            }
        }
        finally {
            this.running = false;
        }
    }
}
/** 队列按目标分组用的键。 */
function scopeOf(target) {
    return 'groupId' in target ? `群 ${target.groupId}` : `私聊 ${String(target.userId)}`;
}
