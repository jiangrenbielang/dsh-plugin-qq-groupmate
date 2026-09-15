/**
 * B 站「求证」：群友说一个梗/说法，机器人能去 B 站找证据、给出处链接。
 *
 * **不用登录、不用 Key**（这是它值得移植的原因）。三条路：
 * 1. `suggest` 搜索建议接口——免登录免风控，用来判「这个词在 B 站是不是个梗」；
 * 2. 排行榜 / 热门视频——标题与简介里匹配，给出可点开的出处；
 * 3. 组装一个搜索页链接 `search.bilibili.com/all?keyword=…` 让人自己点进去。
 *
 * 坑（踩过）：
 * - B 站的**搜索接口**风控很严（412），不要碰；只走上面三条。
 * - `api.bilibili.com` 的排行/热门会对没有浏览器指纹 cookie 的请求返回 **-352**；
 *   自己编一套 `buvid3`/`buvid4`/`b_lsid` cookie 就能过（30 分钟复用一次），
 *   真被拦了就换一套新的重试一次。
 * - 搜不到是**正常结果**（`exists=false`），不是错误——别把「没这个梗」说成「查询失败」。
 */
import { stripHtmlTags } from "./safe-fetch.js";
/** 搜索建议接口（免登录）。 */
const SUGGEST_API = 'https://s.search.bilibili.com/main/suggest';
/** 排行榜。 */
const RANKING_API = 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all';
/** 热门。 */
const POPULAR_API = 'https://api.bilibili.com/x/web-interface/popular';
/** 浏览器 UA。 */
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
/** 指纹 cookie 复用时长。 */
const COOKIE_TTL_MS = 30 * 60_000;
/** 组装 B 站搜索页链接（给人点进去看）。 */
export function biliSearchUrl(term) {
    return `https://search.bilibili.com/all?keyword=${encodeURIComponent(term)}`;
}
/**
 * 去掉 HTML 标签与实体，压平空白。
 *
 * B 站搜索建议会把命中的关键词包成 `<em class="keyword">`，**这种行内标签必须直接删掉**：
 * 换成空格会把「梗名」拆成「梗 名」，后面按子串判断命中就永远对不上。
 */
export function cleanBiliText(input) {
    return stripHtmlTags(input);
}
/** 命名实体表。 */
const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    hellip: '…', mdash: '—', ndash: '–', middot: '·', times: '×',
    copy: '©', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
};
/** 解 HTML 实体。 */
export function decodeEntities(text) {
    return String(text)
        .replace(/&#x([0-9a-f]+);/giu, (_, hex) => {
        const code = Number.parseInt(hex, 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
        .replace(/&#(\d+);/gu, (_, dec) => {
        const code = Number.parseInt(dec, 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
        .replace(/&([a-z]+);/giu, (whole, name) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}
/** 归一化用于比对：去掉空白与大小写差异。 */
export function normKey(text) {
    return String(text ?? '').replace(/\s+/gu, '').toLowerCase();
}
/** 生成一段随机 hex（大写，指纹 cookie 用）。 */
function randomHex(length) {
    let out = '';
    while (out.length < length) {
        out += Math.floor(Math.random() * 16).toString(16).toUpperCase();
    }
    return out.slice(0, length);
}
/**
 * 造一套浏览器指纹 cookie：B 站的排行/热门接口认这个，
 * 没有它会返回 `-352`（风控）。30 分钟内复用同一套。
 */
function newCookieJar(now = Date.now()) {
    const hex8 = () => randomHex(8);
    const hex4 = () => randomHex(4);
    const hex12 = () => randomHex(12);
    const buvid3 = `${hex8()}-${hex4()}-${hex4()}-${hex4()}-${hex12()}infoc`;
    const buvid4 = `${hex8()}-${hex4()}-${hex4()}-${hex4()}-${hex12()}-${String(now % 100000)}-0`;
    const bNut = Math.floor(now / 1000);
    const bLsid = `${hex8()}${now.toString(16).toUpperCase()}`;
    const uuid = `${hex4()}-${hex4()}-${hex4()}-${hex4()}-infoc`;
    return {
        at: now,
        cookie: [
            `buvid3=${buvid3}`,
            `buvid4=${buvid4}`,
            `b_nut=${String(bNut)}`,
            `b_lsid=${bLsid}`,
            `_uuid=${uuid}`,
        ].join('; '),
    };
}
/** 当前可用的指纹（到点自动换新的）。 */
let jar;
function currentCookie(now, fresh = false) {
    if (fresh || jar === undefined || now - jar.at > COOKIE_TTL_MS)
        jar = newCookieJar(now);
    return jar.cookie;
}
/** 请求 B 站 JSON 接口；`emptyCodes` 里的业务码视为「正常但没结果」。 */
async function fetchBiliJson(url, options) {
    const timeout = Math.max(5000, options.timeoutMs ?? 12_000);
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeout);
    timer.unref?.();
    try {
        const headers = {
            'user-agent': BILI_UA,
            'referer': 'https://www.bilibili.com/',
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'zh-CN,zh;q=0.9',
        };
        if (options.cookie !== undefined) {
            headers['cookie'] = options.cookie;
            headers['origin'] = 'https://www.bilibili.com';
        }
        const response = await fetch(url, { headers, signal: controller.signal });
        if (!response.ok)
            throw new Error(`B站${options.what}接口 HTTP ${String(response.status)}`);
        let data;
        try {
            data = await response.json();
        }
        catch {
            throw new Error(`B站${options.what}接口返回的不是合法 JSON`);
        }
        const code = Number(data.code ?? 0);
        if (code !== 0) {
            if ((options.emptyCodes ?? []).includes(code))
                return { code, data: [] };
            const error = new Error(`B站${options.what}接口返回 code=${String(code)}${data.message === undefined ? '' : `（${data.message}）`}`);
            error.biliCode = code;
            throw error;
        }
        return data;
    }
    catch (error) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
            throw new Error(`B站${options.what}接口超时（${String(timeout)}ms）`);
        }
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * 从 suggest 返回里取建议数组。
 *
 * 注意两个接口的**外层不一样**（真机对照过）：
 * - suggest：`{code, result:{tag:[…]}}` —— **没有 `data` 外层**；
 * - ranking/popular：`{code, data:{list:[…]}}` —— 有 `data`。
 * 这里两种都认，免得哪天接口统一了形状就取不到。
 */
function suggestionList(payload) {
    const root = (payload ?? {});
    const result = root.result ?? root.data?.result;
    const raw = Array.isArray(result)
        ? result
        : result?.tag;
    if (!Array.isArray(raw))
        return [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const row = item;
        // `value`/`term` 是纯文本；`name` 带 `<em>` 高亮标签，兜底时才用（会被 cleanBiliText 洗掉标签）。
        const value = cleanBiliText(row.value ?? row.term ?? row.name);
        if (value === '')
            continue;
        const key = normKey(value);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push({ value, ref: cleanBiliText(row.ref ?? row.term ?? '') });
    }
    return out.slice(0, 8);
}
/**
 * 问 B 站「这个词是不是个梗」。搜不到返回 `exists=false`（不是错误）。
 * @param term - 要查的词。
 * @param options.timeoutMs - 超时。
 * @returns 建议列表与是否命中。
 */
export async function biliSuggest(term, options = {}) {
    const query = String(term ?? '').trim();
    const url = new URL(SUGGEST_API);
    url.searchParams.set('term', query);
    url.searchParams.set('main_ver', 'v1');
    // code=3 表示「没建议」，属于正常返回。
    const payload = await fetchBiliJson(url.toString(), {
        what: '搜索建议',
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        emptyCodes: [3],
    });
    const suggestions = suggestionList(payload);
    const target = normKey(query);
    const exists = suggestions.some((item) => {
        const value = normKey(item.value);
        return value === target || value.includes(target) || target.includes(value);
    });
    return { ok: true, term: query, exists, suggestions };
}
/** 取热门/排行榜视频。遇 -352/-412 风控会换一套指纹 cookie 重试一次。 */
export async function biliHotVideos(options = {}) {
    const kind = options.kind ?? 'ranking';
    if (kind !== 'ranking' && kind !== 'popular')
        throw new Error('视频来源只能是 ranking 或 popular');
    const want = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 20)));
    const url = kind === 'popular'
        ? `${POPULAR_API}?ps=${String(Math.min(50, want))}&pn=1`
        : RANKING_API;
    const request = async (cookie) => await fetchBiliJson(url, {
        what: kind === 'ranking' ? '排行榜' : '热门',
        timeoutMs: options.timeoutMs ?? 15_000,
        cookie,
    });
    let payload;
    try {
        payload = await request(currentCookie(Date.now()));
    }
    catch (error) {
        // -352 / -412 是风控：换一套全新指纹再试一次（原版就是这个做法）。
        const code = error.biliCode;
        if (code !== -352 && code !== -412)
            throw error;
        await new Promise(resolve => setTimeout(resolve, 800));
        payload = await request(currentCookie(Date.now(), true));
    }
    const list = payload.data?.list;
    if (!Array.isArray(list))
        return [];
    return list.map(item => toVideo(item)).filter((video) => video !== undefined).slice(0, want);
}
/** 原始条目 → BiliVideo；没有 bvid 就丢掉。 */
function toVideo(raw) {
    if (raw === null || typeof raw !== 'object')
        return undefined;
    const item = raw;
    const bvid = String(item.bvid ?? '').trim();
    if (bvid === '')
        return undefined;
    return {
        bvid,
        title: cleanBiliText(item.title),
        author: cleanBiliText(item.owner?.name),
        view: Number(item.stat?.view ?? 0),
        like: Number(item.stat?.like ?? 0),
        url: `https://www.bilibili.com/video/${bvid}`,
    };
}
/**
 * 排行/热门：ranking 挂了退回 popular。
 * **「请求成功但列表为空」不算失败**——那只是当期没数据，不该让整个求证流程报错；
 * 只有两条路的请求都真出错才抛。
 */
async function hotVideosWithFallback(options) {
    const errors = [];
    for (const kind of ['ranking', 'popular']) {
        try {
            return await biliHotVideos({
                kind,
                ...(options.limit === undefined ? {} : { limit: options.limit }),
                ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            });
        }
        catch (error) {
            errors.push(`${kind}：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new Error(`B站热门视频获取失败（${errors.join('；')}）`);
}
/**
 * 完整求证流程：搜索建议 + 热门视频标题匹配 + 搜索页链接。
 * @param term - 要查的梗/说法。
 * @param options - 超时与视频条数。
 * @returns 证据、命中视频与可点链接。
 */
export async function lookupMemeOnBili(term, options = {}) {
    const query = String(term ?? '').trim();
    if (query === '')
        throw new Error('要查什么？给个词。');
    const suggest = await biliSuggest(query, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
    const videos = await hotVideosWithFallback({
        limit: 100,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    const target = normKey(query);
    const picked = [];
    const seen = new Set();
    for (const video of videos) {
        if (picked.length >= Math.max(1, options.videoLimit ?? 6))
            break;
        if (seen.has(video.bvid))
            continue;
        const hay = `${normKey(video.title)} ${normKey(video.author)}`;
        if (!hay.includes(target))
            continue;
        seen.add(video.bvid);
        picked.push({
            bvid: video.bvid,
            title: video.title,
            author: video.author,
            view: video.view,
            like: video.like,
            url: video.url,
        });
    }
    const exists = suggest.exists || picked.length > 0;
    const evidence = suggest.exists
        ? 'B站搜索建议命中'
        : picked.length > 0 ? 'B站热门视频标题命中' : '未在B站找到明确证据';
    return {
        term: query,
        exists,
        suggestions: suggest.suggestions,
        videos: picked,
        evidence,
        urls: [biliSearchUrl(query), ...picked.map(video => video.url)],
    };
}
/** 把求证结果渲染成给模型看的一段文字。 */
export function renderBiliLookup(result) {
    const lines = [`B站求证「${result.term}」：${result.evidence}`];
    if (result.suggestions.length > 0) {
        lines.push(`搜索建议：${result.suggestions.map(item => item.value).join('、')}`);
    }
    for (const video of result.videos) {
        lines.push(`视频：${video.title}（UP：${video.author}，播放 ${String(video.view)}）${video.url}`);
    }
    lines.push(`搜索页：${biliSearchUrl(result.term)}`);
    lines.push(result.exists
        ? '（有出处就把链接给群友；别把没核实的东西说成事实。）'
        : '（B 站上没找到明确出处。可以老实说「没查到」，别硬编。）');
    return lines.join('\n');
}
/** 把求证失败压成一句话。 */
export function describeBiliError(error, logger) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.debug?.('qq-groupmate: B站求证失败：%s', message);
    return `B站查不了：${message}`;
}
