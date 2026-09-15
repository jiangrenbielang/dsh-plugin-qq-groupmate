/**
 * 联网搜索：让机器人能答「现在」的事（群友问「XX 是什么」「帮我查一下」）。
 *
 * 默认走 **Bing 网页抓取**——不需要任何 API Key，装好就能用，这是本模块的核心价值；
 * 需要更稳的结果时可以在设置页填一个自定义搜索接口（OpenAI 风格的 JSON）。
 *
 * 抓取方式是纯正则解析 Bing 的结果列表（`<li class="b_algo">` 分块 + 标题/链接/摘要），
 * 不做 DOM 解析：搜索结果页结构简单且长期稳定，抓错了顶多是没结果，不影响聊天。
 * 「搜不到」是正常结果，不是错误——这一点和 QQ-Agent 的处理一致。
 */
import { UnsafeUrlError, fetchPageText, stripHtmlTags } from "./safe-fetch.js";
/** 默认搜索页。 */
export const DEFAULT_SEARCH_URL = 'https://cn.bing.com/search';
/** Bing 抓取要伪装成正常浏览器，否则可能被丢到验证页。 */
const BING_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
/**
 * 清洗查询词：去掉 CQ 码、控制字符，压平空白，限长 120 字。
 * @param query - 原始查询词（可能来自模型，带乱七八糟的东西）。
 * @returns 可安全拼进 URL 的查询词。
 */
export function sanitizeQuery(query) {
    return String(query)
        .replace(/\[CQ:[^\]]*\]/giu, ' ')
        .replace(/[\u0000-\u001f\u007f]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 120);
}
/**
 * 抓 Bing 结果页并解析出前几条结果。
 * @param query - 已清洗的查询词。
 * @param settings - 搜索设置。
 * @param logger - 日志。
 * @returns 结果列表（可能为空）。
 */
export async function bingSearch(query, settings, logger) {
    const url = new URL(settings.searchUrl === '' ? DEFAULT_SEARCH_URL : settings.searchUrl);
    url.searchParams.set('q', query);
    const body = await fetchText(url.toString(), settings.timeoutMs, logger);
    const max = clampInt(settings.maxResults, 1, 10, 6);
    return parseBingResults(body, max);
}
/** Bing 结果页的解析规则（导出以便离线测试）。 */
/** 从 Bing 结果页 HTML 里解析结果块（导出以便离线测试）。 */
export function parseBingResults(html, max) {
    const results = [];
    for (const block of String(html).split('<li class="b_algo"').slice(1)) {
        if (results.length >= max)
            break;
        const href = /<a[^>]+href="(https?:\/\/[^"]+)"/iu.exec(block);
        const title = /<h2[^>]*>([\s\S]*?)<\/h2>/iu.exec(block);
        if (href === null || title === null)
            continue;
        const snippet = /<p[^>]*>([\s\S]*?)<\/p>/iu.exec(block);
        const url = href[1];
        const heading = stripHtmlTags(title[1]).trim();
        if (url === undefined || heading === '')
            continue;
        results.push({
            title: heading,
            url,
            snippet: snippet === null ? '' : stripHtmlTags(snippet[1]).trim(),
        });
    }
    return results;
}
/**
 * 统一的搜索入口：配了自定义接口就用它，否则抓 Bing。
 * @param query - 原始查询词。
 * @param settings - 搜索设置。
 * @param logger - 日志。
 * @returns 搜索结果；查询词为空时结果是空数组。
 * @throws {Error} 网络/接口失败时抛错（调用方压成一句人话给模型）。
 */
export async function webSearch(query, settings, logger) {
    const cleaned = sanitizeQuery(query);
    if (cleaned === '')
        return { query: '', results: [], provider: 'bing' };
    const custom = settings.custom;
    if (custom !== undefined && custom.baseUrl.trim() !== '') {
        const results = await customSearch(cleaned, settings, custom, logger);
        return { query: cleaned, results, provider: 'custom' };
    }
    const results = await bingSearch(cleaned, settings, logger);
    return { query: cleaned, results, provider: 'bing' };
}
/** 自定义 JSON 接口：POST `{ query, count }`，从若干常见字段名里捞出结果数组。 */
async function customSearch(query, settings, custom, logger) {
    const timeout = Math.max(10_000, settings.timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeout);
    timer.unref?.();
    try {
        const response = await fetch(custom.baseUrl.trim(), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'user-agent': BING_UA,
                ...(custom.apiKey.trim() === '' ? {} : { authorization: `Bearer ${custom.apiKey.trim()}` }),
            },
            body: JSON.stringify({ query, q: query, count: clampInt(settings.maxResults, 1, 10, 6), top_k: clampInt(settings.maxResults, 1, 10, 6) }),
            signal: controller.signal,
        });
        if (!response.ok)
            throw new Error(`搜索接口 HTTP ${String(response.status)}`);
        const data = await response.json();
        const results = normalizeCustomResults(data, clampInt(settings.maxResults, 1, 10, 6));
        if (results.length === 0) {
            logger?.debug?.('qq-groupmate: 自定义搜索接口没返回可识别的结果字段，返回结构：%s', JSON.stringify(data).slice(0, 200));
        }
        return results;
    }
    finally {
        clearTimeout(timer);
    }
}
/** 把各家自定义接口的返回统一成 SearchResult[]（兜底数组顺序与 QQ-Agent 一致）。 */
export function normalizeCustomResults(data, max) {
    const root = (data ?? {});
    const candidates = [];
    const push = (value) => {
        if (Array.isArray(value))
            candidates.push(...value);
    };
    push(root.results);
    push(root.data);
    push(root.sources);
    push(root.references);
    const webPages = root.data;
    if (webPages !== undefined && !Array.isArray(root.data))
        push(webPages.webPages?.value);
    const out = [];
    for (const item of candidates) {
        if (out.length >= max)
            break;
        if (item === null || typeof item !== 'object')
            continue;
        const row = item;
        const url = String(row.url ?? row.link ?? '').trim();
        if (url === '')
            continue;
        out.push({
            title: String(row.title ?? row.name ?? '（无标题）').trim(),
            url,
            snippet: String(row.snippet ?? row.summary ?? row.content ?? '').trim(),
        });
    }
    return out;
}
/** 抓一段文本（带 UA 与超时），非 2xx 抛错。 */
async function fetchText(url, timeoutMs, logger) {
    const timeout = Math.max(10_000, timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeout);
    timer.unref?.();
    try {
        const response = await fetch(url, {
            headers: { 'user-agent': BING_UA, 'accept-language': 'zh-CN,zh;q=0.9' },
            signal: controller.signal,
        });
        if (!response.ok)
            throw new Error(`搜索服务 HTTP ${String(response.status)}`);
        return await response.text();
    }
    catch (error) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
            throw new Error(`搜索超时（${String(timeout)}ms）`);
        }
        logger?.debug?.('qq-groupmate: 搜索请求失败：%s', String(error));
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
/** 夹取整数，非法值用兜底。 */
function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num))
        return fallback;
    return Math.min(max, Math.max(min, Math.trunc(num)));
}
/** 把搜索结果渲染成给模型看的一段文字（工具返回）。 */
export function renderSearchResults(response, maxChars = 1800) {
    if (response.query === '')
        return '查询词为空。';
    if (response.results.length === 0) {
        return `没搜到「${response.query}」的结果（来源：${response.provider}）。可以换个说法再试，或直接说不知道。`;
    }
    const lines = [`搜索「${response.query}」（来源：${response.provider}，共 ${String(response.results.length)} 条）：`];
    for (const [index, item] of response.results.entries()) {
        lines.push(`${String(index + 1)}. ${item.title}`);
        lines.push(`   链接：${item.url}`);
        if (item.snippet !== '')
            lines.push(`   摘要：${item.snippet}`);
    }
    lines.push('（这些是网页上的说法，用你自己的话讲，别整段照抄；不确定的就说不确定。）');
    const text = lines.join('\n');
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
/** 把抓取错误压成给模型看的一句话。 */
export function describeSearchError(error) {
    if (error instanceof UnsafeUrlError)
        return error.message;
    return `联网失败：${error instanceof Error ? error.message : String(error)}`;
}
/** 抓一个网页的正文（走 SSRF 防护），渲染成给模型看的一段文字。 */
export async function renderFetchedPage(url, maxChars = 4000) {
    const page = await fetchPageText(url);
    const body = truncateLocal(page.text, maxChars);
    const head = page.title === '' ? `网页内容（${page.url}）：` : `网页「${page.title}」（${page.url}）：`;
    const tail = page.truncated ? '\n（内容过长，已截断。）' : '';
    return `${head}\n${body}${tail}`;
}
/** 超长截断（按码点，别切坏 emoji）。 */
function truncateLocal(text, max) {
    const chars = Array.from(text);
    return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}
