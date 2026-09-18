/**
 * 出站发送：把「往 QQ 发东西」的路径收拢在一起。
 * 负责违禁词过滤、发送失败的兜底、表情与生图发送，以及已发送消息 id 的记录
 * （有人回复机器人自己的消息时靠它判定）。
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverGroupText } from "./forward.js";
import { ImageGenQueue, parseImageRequests, renderImageInfo } from "./imagegen.js";
import { V4_MODEL, V5_MODEL, parseTagOptions } from "./nai-presets.js";
import { parseStickers } from "./stickers.js";
/**
 * 拆出 `[原声:关键词]` 标记：返回去掉标记之后的正文与关键词列表。
 * 与原声库的宽松匹配配合：模型漏写冒号、带空格或标点也能认出来。
 */
function parseNativeVoiceRequests(text) {
    const keys = [];
    const cleaned = text.replace(/\[原声\s*[:：]\s*([^\]\n]+)\]/gu, (_match, raw) => {
        const keyword = String(raw).trim();
        if (keyword !== '')
            keys.push(keyword);
        return '';
    });
    return { text: cleaned.replace(/[ \t]{2,}/gu, ' ').trim(), keys };
}
/** 已发送消息 id 的保留上限（回复判定只看最近这些）。 */
const MAX_TRACKED_SENT_IDS = 200;
/**
 * 发图时给协议端的等待时间。协议端收到图片地址后要先把整张位图下载下来
 * （一两 MB）再上传给 QQ，慢网下比文字消息久得多，用默认的 15 秒会把
 * 已经画好的图判成发送失败。
 */
const IMAGE_SEND_TIMEOUT_MS = 300_000;
/** 出站发送器。 */
export class OutboundSender {
    client;
    logger;
    outboundFilter;
    stickers;
    imageGenClient;
    nativeVoice;
    imageGen;
    presets;
    policy;
    senderName;
    sentMessageIds = new Map();
    constructor(deps) {
        this.client = deps.client;
        this.logger = deps.logger;
        this.outboundFilter = deps.outboundFilter;
        this.stickers = deps.stickers;
        this.imageGenClient = deps.imageGenClient;
        this.nativeVoice = deps.nativeVoice;
        this.presets = deps.presets;
        this.policy = deps.policy;
        this.senderName = deps.senderName;
        this.imageGen = deps.imageGenClient === undefined
            ? undefined
            : new ImageGenQueue({
                client: deps.imageGenClient,
                logger: deps.logger,
                send: async (target, image, info) => await this.sendGeneratedImage(target, image, info),
                notify: async (target, text) => {
                    await ('groupId' in target
                        ? this.sendTextToGroup(target.groupId, text)
                        : this.sendTextToPrivate(target.userId, text));
                },
            });
    }
    /**
     * 只过滤不发送：通过返回过滤后的文本，被拦下返回 undefined。
     * say() 需要「被拦下就抛错」的语义，用它拿判定后自己决定怎么处理。
     */
    filterText(text, scopeKey) {
        // 注意不能写 `?? text`：apply 返回 undefined 表示「拦下」，会被兜回原文。
        return this.outboundFilter === undefined ? text : this.outboundFilter.apply(text, scopeKey);
    }
    /** 记下一条自己发出的消息 id。 */
    rememberSentId(scopeKey, messageId) {
        let ids = this.sentMessageIds.get(scopeKey);
        if (ids === undefined) {
            ids = [];
            this.sentMessageIds.set(scopeKey, ids);
        }
        ids.push(messageId);
        if (ids.length > MAX_TRACKED_SENT_IDS)
            ids.splice(0, ids.length - MAX_TRACKED_SENT_IDS);
    }
    /** 这条消息是不是自己发的（回复自己消息的判定用）。 */
    hasSentId(scopeKey, messageId) {
        return this.sentMessageIds.get(scopeKey)?.includes(messageId) ?? false;
    }
    /**
     * 发送群文字消息；被过滤拦下或发送失败返回 false（调用方据此决定是否记历史/冷却）。
     * 长回复（画风清单这类十几行的）走合并转发，群里只占一条。
     */
    async sendTextToGroup(groupId, text) {
        const filtered = this.filterText(text, groupId);
        if (filtered === undefined || filtered.trim() === '')
            return false;
        try {
            const delivered = await deliverGroupText(this.client, groupId, filtered, {
                ...(this.client.self === undefined ? {} : { selfId: this.client.self }),
                ...(this.senderName === undefined ? {} : { nickname: this.senderName(groupId) }),
            }, this.logger);
            if (delivered.messageId !== undefined)
                this.rememberSentId(groupId, delivered.messageId);
            return true;
        }
        catch (error) {
            this.logger.error('qq-groupmate: 发送群 %s 消息失败: %s', groupId, String(error));
            return false;
        }
    }
    /**
     * 发送私聊文字消息；被过滤拦下返回 false。
     * 过滤 scope 用 `private:<id>`；发送失败照旧抛出，由调用方统一兜错。
     */
    async sendTextToPrivate(userId, text) {
        const scopeKey = `private:${String(userId)}`;
        const filtered = this.filterText(text, scopeKey);
        if (filtered === undefined || filtered.trim() === '') {
            this.logger.info('qq-groupmate: 私聊 %s 的回复被违禁词过滤，未发送', String(userId));
            return false;
        }
        const result = await this.client.sendPrivateMessage(userId, [{ type: 'text', data: { text: filtered } }]);
        this.rememberSentId(scopeKey, result.message_id);
        return true;
    }
    /**
     * 发一条带自定义消息段的群消息（提醒到点要 @ 某人这类需要段结构的场景）。
     * 段里的文本照旧过违禁词；被拦下整条不发（与纯文本路径口径一致）。
     */
    async sendSegmentsToGroup(groupId, segments) {
        const textParts = segments
            .filter(segment => segment.type === 'text')
            .map(segment => String(segment.data.text ?? ''))
            .join('');
        if (textParts.trim() !== '' && this.filterText(textParts, groupId) === undefined)
            return false;
        try {
            const result = await this.client.sendGroupMessage(groupId, segments);
            if (result.message_id !== undefined)
                this.rememberSentId(groupId, result.message_id);
            return true;
        }
        catch (error) {
            this.logger.error('qq-groupmate: 发送群 %s 消息段失败: %s', groupId, String(error));
            return false;
        }
    }
    /**
     * 发送一条模型回复：回复里可能带 `[表情:名字]` 和 `[生图:标签]`，
     * 文字先发、表情跟着发，图交给后台队列画好再发（生成慢，不阻塞这条回复）。
     * 返回是否发出过（或确定会发出）东西，调用方据此决定是否记历史/置冷却。
     * @param target - 群或私聊。
     * @param reply - 模型回复原文。
     * @param imageOverrides - 生图覆盖（发起人的 QQ、画风名等）。
     */
    async sendReply(target, reply, imageOverrides = {}) {
        const parsed = parseStickers(reply);
        const images = parseImageRequests(parsed.text);
        // 原声台词：模型写了 `[原声:关键词]` 就把那条原声（游戏配音 / 补音包）发出去，
        // 群友听到的是她本人的声音，而不是当场合成的。
        const native = parseNativeVoiceRequests(images.text);
        let sentAnything = false;
        if (native.text !== '') {
            // 发送失败/被过滤拦截时返回 false：别把没送达的话记成「已回复」。
            sentAnything = 'groupId' in target
                ? await this.sendTextToGroup(target.groupId, native.text)
                : await this.sendTextToPrivate(target.userId, native.text);
        }
        for (const keyword of native.keys) {
            const entry = this.nativeVoice?.find(keyword);
            if (entry === undefined) {
                this.logger.debug?.('qq-groupmate: 原声库里没有「%s」，跳过', keyword);
                continue;
            }
            try {
                const wav = readFileSync(entry.path);
                const ok = await this.sendVoice(target, wav);
                if (ok)
                    sentAnything = true;
                this.logger.info('qq-groupmate: 已发送原声「%s」（%s）', keyword, entry.file);
            }
            catch (error) {
                this.logger.warn('qq-groupmate: 发送原声「%s」失败：%s', keyword, String(error));
            }
        }
        for (const name of parsed.stickers) {
            const sent = 'groupId' in target
                ? await this.sendStickerToGroup(target.groupId, name)
                : await this.sendStickerToPrivate(target.userId, name);
            if (sent)
                sentAnything = true;
        }
        if (images.prompts.length > 0 && this.imageGen?.enabled === true) {
            for (const raw of images.prompts) {
                const resolved = this.resolveOverrides(raw, imageOverrides);
                if (resolved.error !== undefined) {
                    // 画风不存在、V5 额度用完这类：直接把原因说出来，别让群友干等。
                    await this.notifyTarget(target, resolved.error);
                    sentAnything = true;
                    continue;
                }
                this.imageGen.enqueue(target, [resolved.tag], resolved.overrides);
                sentAnything = true;
            }
        }
        if (await this.maybeSendSticker(target, parsed.stickers.length))
            sentAnything = true;
        return sentAnything;
    }
    /**
     * 把一条生图标签（可能带 `-p 画风名 --seed 42`）折算成实际请求参数。
     *
     * 模型优先级：调用方指定 > 标签里的画风属于 V5 则用 V5 > 这个人的当前模型。
     * 画师串优先级：`--artist` 覆盖 `-p` 画风；都没给就用配置里的默认画师串。
     * V5 走之前先占额度；额度不够直接给群友一句话，不进队列。
     *
     * **画风名没在库里时照样画**（2026-09-14 修正）：模型可能写一个库里没有的风格
     * （「女神异闻录3风格」），以前这里直接拒绝——群里表现为「不画了」。作者的原版
     * 遇到这种情况是手搓提示词继续画，我们照做：把风格名当普通标签留给模型自己发挥，
     * 用兜底画师串出图，不再拦。
     */
    resolveOverrides(raw, base) {
        const parsed = parseTagOptions(raw);
        const tag = parsed.tag === '' ? raw.trim() : parsed.tag;
        const overrides = { ...base };
        if (parsed.size !== undefined)
            overrides.size = parsed.size;
        if (parsed.seed !== undefined)
            overrides.seed = parsed.seed;
        if (parsed.negative !== undefined)
            overrides.negative = parsed.negative;
        if (parsed.artist !== undefined)
            overrides.artist = parsed.artist;
        // 画风名两个来源：标签里的 `-p 名字`（模型显式写的），或 base.preset
        // （群友在消息里直接报了画风名，group.ts 先识别好传进来）；标签里的优先。
        const styleName = parsed.preset ?? overrides.preset ?? '';
        delete overrides.preset;
        const userId = overrides.userId;
        // 没配预设库（或没开模型策略）时退化成老行为：只用配置里的默认画师串。
        const presets = this.presets;
        const policy = this.policy;
        if (presets === undefined) {
            overrides.resolved = {
                model: overrides.model ?? this.imageGenClient?.settings.model ?? V4_MODEL,
                artist: parsed.artist ?? this.imageGenClient?.settings.artist ?? '',
                styleName: styleName === '' ? '默认' : styleName,
            };
            return { tag, overrides };
        }
        // 画风属于哪个模型：只有**V5 专属**的名字（7 个内置画风那种，只在 V5 表里）
        // 才据此切到 V5；两套表共用的画师预设（裸画师名）不切，跟随这个人当前的模型——
        // 否则 V4.5 的人 `-p aka_kan` 会被悄悄切到 V5（5 点/张还吃 24 小时额度）。
        // 库外名字同样不切（免得「xxx游戏风格」里的「游戏风」把模型带走）。
        let model = overrides.model;
        if (model === undefined) {
            const v5Only = styleName !== '' && presets.has(V5_MODEL, styleName) && !presets.has(V4_MODEL, styleName);
            if (v5Only)
                model = V5_MODEL;
            else if (userId !== undefined && policy !== undefined) {
                const configured = this.imageGenClient?.settings.model;
                model = policy.modelOf(userId, configured === V5_MODEL ? V5_MODEL : V4_MODEL);
            }
            else
                model = this.imageGenClient?.settings.model ?? V4_MODEL;
        }
        // 画风在库里：用它自己的画师串。不在库里：不拦，退回兜底画师串继续画。
        const known = styleName !== '' && presets.has(model, styleName);
        const style = known ? presets.resolve(model, styleName) : undefined;
        if (styleName !== '' && !known) {
            this.logger.info('qq-groupmate: 画风「%s」不在 %s 画风库里，按普通标签继续画（用兜底画师串）', styleName, model === V5_MODEL ? 'V5' : 'V4.5');
        }
        const artist = parsed.artist
            ?? (style !== undefined && style.artist !== '' ? style.artist : (this.imageGenClient?.settings.artist ?? ''));
        // V5 先占额度：并发下也不会两个人同时通过检查。
        let quotaToken;
        if (model === V5_MODEL && userId !== undefined && policy !== undefined) {
            try {
                quotaToken = policy.reserve(userId);
            }
            catch (error) {
                return { tag, overrides, error: String(error instanceof Error ? error.message : error) };
            }
        }
        overrides.resolved = {
            model,
            artist,
            styleName: styleName === '' ? '默认' : styleName,
            ...(quotaToken === undefined ? {} : { quotaToken }),
        };
        return { tag, overrides };
    }
    /** 给某个目标发一句提示（额度不足、画风不存在等）。 */
    async notifyTarget(target, text) {
        await ('groupId' in target
            ? this.sendTextToGroup(target.groupId, text)
            : this.sendTextToPrivate(target.userId, text)).catch(() => { });
    }
    /** 生图能力是否可用（提示词里要不要教模型用 `[生图:标签]`）。 */
    get imageGenEnabled() {
        return this.imageGen?.enabled === true;
    }
    /**
     * 发一条 QQ 语音（record 段，base64）。语音是文字回复的附加输出：
     * 发送失败只记日志、不抛错——文字已经发出去了，别让语音把回复判成失败。
     */
    async sendVoice(target, wav) {
        const segment = { type: 'record', data: { file: `base64://${wav.toString('base64')}` } };
        const scopeKey = 'groupId' in target ? target.groupId : `private:${String(target.userId)}`;
        try {
            const result = 'groupId' in target
                ? await this.client.sendGroupMessage(target.groupId, [segment])
                : await this.client.sendPrivateMessage(target.userId, [segment]);
            this.rememberSentId(scopeKey, result.message_id);
            return true;
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 语音发送失败（协议端可能不支持 record 段或转换失败）：%s', String(error));
            return false;
        }
    }
    /** 发一张本地图片（截图等）；成功返回 true，失败只记日志。 */
    async sendLocalImage(target, filePath) {
        const segment = { type: 'image', data: { file: `file:///${filePath.replace(/\\/gu, '/')}` } };
        try {
            const result = 'groupId' in target
                ? await this.client.sendGroupMessage(target.groupId, [segment], IMAGE_SEND_TIMEOUT_MS)
                : await this.client.sendPrivateMessage(target.userId, [segment], IMAGE_SEND_TIMEOUT_MS);
            const scopeKey = 'groupId' in target ? target.groupId : `private:${String(target.userId)}`;
            this.rememberSentId(scopeKey, result.message_id);
            return true;
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 本地图片发送失败：%s', String(error));
            return false;
        }
    }
    /**
     * 主动让生图队列画一张（群内 `.生图` 命令用）。
     * @param target - 发到哪。
     * @param prompt - 画面标签（可带 `-p 画风名` 等参数）。
     * @param overrides - 发起人 QQ 等上下文。
     * @returns `queued=false` 且带 `error` 时表示画不了（画风不存在、V5 额度用完）。
     */
    requestImage(target, prompt, overrides = {}) {
        if (this.imageGen?.enabled !== true)
            return { queued: false };
        const resolved = this.resolveOverrides(prompt, overrides);
        if (resolved.error !== undefined)
            return { queued: false, error: resolved.error };
        this.imageGen.enqueue(target, [resolved.tag], resolved.overrides);
        return { queued: true };
    }
    /** 查一个人当前的生图模型与 V5 额度说明（`.生图额度` 命令用）。 */
    describeQuota(userId) {
        if (this.policy === undefined)
            return undefined;
        // 没显式切过模型的人，报设置页配的默认模型（否则会跟他看到的配置对不上）。
        const configured = this.imageGenClient?.settings.model;
        return this.policy.describe(userId, configured === V5_MODEL ? V5_MODEL : V4_MODEL);
    }
    /** 卸载：清掉还在排队的生图任务。 */
    dispose() {
        this.imageGen?.dispose();
    }
    /**
     * 发一张画好的图。按配置的发送方式先试一种，失败自动换下一种：
     * `url` = 把出图地址交给协议端下载（省一次本机中转）；
     * `base64` = 插件下载好的字节直接发（能吃上抢跑加速）；
     * 最后落盘走本地文件路径兜底（协议端与插件同机时可用）。
     *
     * 图发成功后跟着发一行信息标签（模型 | 画风 | 耗时），照搬作者插件的做法。
     */
    async sendGeneratedImage(target, image, info) {
        const scopeKey = 'groupId' in target ? target.groupId : `private:${String(target.userId)}`;
        const push = async (segment) => {
            const result = 'groupId' in target
                ? await this.client.sendGroupMessage(target.groupId, [segment], IMAGE_SEND_TIMEOUT_MS)
                : await this.client.sendPrivateMessage(target.userId, [segment], IMAGE_SEND_TIMEOUT_MS);
            return result.message_id;
        };
        const preferUrl = image.url !== undefined && this.imageGenClient?.settings.sendMode !== 'base64';
        const modes = preferUrl ? ['url', 'base64'] : ['base64'];
        if (image.url !== undefined && !modes.includes('url'))
            modes.push('url');
        for (const mode of modes) {
            const segment = mode === 'url'
                ? { type: 'image', data: { file: image.url } }
                : { type: 'image', data: { file: `base64://${image.buffer.toString('base64')}` } };
            try {
                this.rememberSentId(scopeKey, await push(segment));
                await this.followWithInfoTag(target, info);
                return true;
            }
            catch (error) {
                this.logger.warn('qq-groupmate: 用%s发送失败（%s），换下一种方式', mode === 'url' ? '图片地址' : 'base64', String(error));
            }
        }
        // base64 / 地址都不认：落盘走 file:// 路径（表情包同款兜底）。
        const file = this.saveTempSegment(image);
        if (file !== undefined) {
            try {
                this.rememberSentId(scopeKey, await push(file));
                rmSync(String(file.data.file).slice('file://'.length), { force: true });
                await this.followWithInfoTag(target, info);
                return true;
            }
            catch (error) {
                this.logger.warn('qq-groupmate: 用本地文件路径发送也失败：%s', String(error));
            }
        }
        this.logger.warn('qq-groupmate: 图片三种方式都没发出去');
        return false;
    }
    /**
     * 图片发出去之后跟一行信息标签（`V5 | 绝区零游戏风 | 耗时37秒`）。
     * 标签发不出去不影响图片本身——群友已经拿到图了，别把整次发送判成失败。
     */
    async followWithInfoTag(target, info) {
        if (info === undefined || this.imageGenClient?.settings.showImageInfo !== true)
            return;
        await this.notifyTarget(target, renderImageInfo(info)).catch(() => { });
    }
    /** 把图片字节落到临时目录，换成本地 file:// 图片段；落盘失败返回 undefined。 */
    saveTempSegment(image) {
        try {
            const extension = image.mime.includes('jpeg') || image.mime.includes('jpg')
                ? '.jpg'
                : image.mime.includes('webp') ? '.webp' : image.mime.includes('gif') ? '.gif' : '.png';
            const path = join(tmpdir(), `qq-groupmate-${Date.now()}-${Math.floor(Math.random() * 100000)}${extension}`);
            writeFileSync(path, image.buffer);
            return { type: 'image', data: { file: `file://${path.split('\\').join('/')}` } };
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 图片落盘失败：%s', String(error));
            return undefined;
        }
    }
    /** 往群里发一个本地表情；成功返回 true。base64 不被支持时自动换成本地文件路径。 */
    async sendStickerToGroup(groupId, name) {
        const base64 = this.stickers?.segmentOf(name);
        if (base64 === undefined) {
            this.logger.warn('qq-groupmate: 没有表情「%s」，跳过', name);
            return false;
        }
        try {
            const result = await this.client.sendGroupMessage(groupId, [base64]);
            this.rememberSentId(groupId, result.message_id);
            return true;
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 表情「%s」用 base64 发送失败（%s），改用文件路径重试', name, String(error));
        }
        const file = this.stickers?.segmentOf(name, 'file');
        if (file === undefined)
            return false;
        try {
            const result = await this.client.sendGroupMessage(groupId, [file]);
            this.rememberSentId(groupId, result.message_id);
            return true;
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 发送表情「%s」失败：%s', name, String(error));
            return false;
        }
    }
    /** 往私聊发一个本地表情；成功返回 true。base64 不被支持时自动换成本地文件路径。 */
    async sendStickerToPrivate(userId, name) {
        const base64 = this.stickers?.segmentOf(name);
        if (base64 === undefined) {
            this.logger.warn('qq-groupmate: 没有表情「%s」，跳过', name);
            return false;
        }
        try {
            await this.client.sendPrivateMessage(userId, [base64]);
            return true;
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 表情「%s」用 base64 发送失败（%s），改用文件路径重试', name, String(error));
        }
        const file = this.stickers?.segmentOf(name, 'file');
        if (file === undefined)
            return false;
        try {
            await this.client.sendPrivateMessage(userId, [file]);
            return true;
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 发送表情「%s」失败：%s', name, String(error));
            return false;
        }
    }
    /**
     * 模型自己没发表情时，按配置概率顺手补一张（让它在日常对话里更像真人）。
     * @param target - 群或私聊。
     * @param alreadySent - 这条回复里模型自己已经发了几张表情；大于 0 就不再补。
     */
    async maybeSendSticker(target, alreadySent) {
        const library = this.stickers;
        if (library?.available !== true || alreadySent > 0)
            return false;
        if (Math.random() >= library.probability)
            return false;
        const name = library.pick();
        if (name === undefined)
            return false;
        this.logger.debug?.('qq-groupmate: 顺手补一张表情「%s」', name);
        return 'groupId' in target
            ? await this.sendStickerToGroup(target.groupId, name)
            : await this.sendStickerToPrivate(target.userId, name);
    }
}
