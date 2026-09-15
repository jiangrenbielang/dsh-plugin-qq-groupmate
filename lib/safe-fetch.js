/**
 * 联网抓取的安全底座：读网页正文、下载图片都从这里走。
 *
 * 为什么不能直接用 `fetch`：模型能决定抓哪个 URL（群友说「帮我看看这个链接」），
 * 而 `fetch` 会老老实实去连 `127.0.0.1`、`192.168.x.x`、云服务器的 `169.254.169.254`
 * 元数据接口——等于把内网和本机端口的探测能力交给了一个会被群友消息影响的东西。
 *
 * 三条防线（移植自 QQ-Agent 的 safe-fetch）：
 * 1. 只允许 http/https，且 URL 里不能带凭据（`user:pass@host`）；
 * 2. 域名先 DNS 解析，**逐条**检查解析结果，任何一条落到内网/环回/链路本地就拒绝；
 * 3. 真正连接时固定用「已校验的那个 IP」当 hostname，SNI 仍用原域名——
 *    这样 DNS 重绑定（解析时是公网 IP、连接时变内网）也挡得住。
 *
 * 另外：重定向**每一跳都重新校验**（不然一个公网 URL 可以 302 到内网），
 * 透传请求头时丢掉 host / cookie / authorization（不能让页面拿到机器人的凭据）。
 */
import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
/** 正文最多读多少字符（约 2 万字，与 QQ-Agent 一致）。 */
export const MAX_BODY_CHARS = 20_000;
/** 二进制最多读多少字节（图片下载用）。 */
export const MAX_BINARY_BYTES = 12 * 1024 * 1024;
/** 最多跟几次重定向。 */
export const MAX_REDIRECTS = 5;
/** 单次请求超时。 */
const REQUEST_TIMEOUT_MS = 20_000;
/** DNS 解析超时。 */
const DNS_TIMEOUT_MS = 5_000;
/**
 * 判断一个 IP 字面量是否属于内网/环回/保留段。
 * IPv4 与 IPv6 都判，IPv6 还会把内嵌的 IPv4（`::ffff:127.0.0.1`、NAT64 等）挖出来递归判。
 * @param ip - IP 字符串。
 * @returns true 表示禁止访问。
 */
export function isPrivateIp(ip) {
    const raw = ip.trim().toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '');
    if (raw === '')
        return true;
    if (isIP(raw) === 4)
        return isPrivateIpv4(raw);
    if (isIP(raw) === 6) {
        if (raw === '::' || raw === '::1')
            return true;
        // fc00::/7（唯一本地）、fe80::/10（链路本地）、ff00::/8（组播）
        if (/^f[cd]/u.test(raw))
            return true;
        if (/^fe[89ab]/u.test(raw))
            return true;
        if (/^fec|^fed|^fee|^fef/u.test(raw))
            return true;
        if (/^ff/u.test(raw))
            return true;
        // 文档用段
        if (raw.startsWith('2001:db8'))
            return true;
        if (raw.startsWith('2001:2:') || raw.startsWith('2001:10:') || raw.startsWith('2001:20:'))
            return true;
        // 6to4 / NAT64 / v4-mapped：把内嵌的 IPv4 挖出来递归判
        const embedded = parseEmbeddedIpv4(raw);
        if (embedded !== undefined)
            return isPrivateIp(embedded);
        return false;
    }
    return false;
}
/** IPv4 私有/保留段判定。 */
function isPrivateIpv4(ip) {
    const parts = ip.split('.').map(part => Number(part));
    if (parts.length !== 4 || parts.some(part => !Number.isFinite(part)))
        return true;
    const [a, b] = parts;
    if (a === 10)
        return true;
    if (a === 127)
        return true;
    if (a === 0)
        return true;
    if (a === 169 && b === 254)
        return true;
    if (a === 172 && b >= 16 && b <= 31)
        return true;
    if (a === 192 && b === 168)
        return true;
    if (a === 100 && b >= 64 && b <= 127)
        return true;
    if (a === 198 && (b === 18 || b === 19))
        return true;
    if (a === 192 && b === 0 && parts[2] === 0)
        return true;
    if (a >= 224)
        return true;
    return false;
}
/** 从 IPv6 地址里挖出内嵌的 IPv4（`::ffff:7f00:1`、`64:ff9b::…`、末尾点分十进制等）。 */
function parseEmbeddedIpv4(ip) {
    const value = ip.toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '');
    // 末尾直接写成点分十进制
    const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(value);
    if (dotted !== null)
        return dotted[1];
    // ::ffff:7f00:1 形态（两段 hex 拼成 32 位）
    const mapped = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(value);
    if (mapped !== null)
        return ipv4FromHexPair(mapped[1], mapped[2]);
    // ::ffff:… / ::… 取最后两段
    if (value.startsWith('::ffff:') || value.startsWith('::')) {
        const tail = value.split(':').filter(part => part !== '');
        if (tail.length >= 2)
            return ipv4FromHexPair(tail[tail.length - 2], tail[tail.length - 1]);
    }
    // NAT64 64:ff9b::
    if (value.startsWith('64:ff9b')) {
        const tail = value.split(':').filter(part => part !== '');
        if (tail.length >= 2)
            return ipv4FromHexPair(tail[tail.length - 2], tail[tail.length - 1]);
    }
    // 6to4 2002::/16：前缀后紧跟的两段 hex 就是内嵌的 IPv4（2002:7f00:1:: → 127.0.0.1）。
    if (value.startsWith('2002:')) {
        const groups = value.split(':');
        if (groups.length >= 3)
            return ipv4FromHexPair(groups[1], groups[2]);
    }
    return undefined;
}
/** 两段 4 位 hex → 点分十进制 IPv4。 */
function ipv4FromHexPair(high, low) {
    const a = Number.parseInt(high, 16);
    const b = Number.parseInt(low, 16);
    if (!Number.isFinite(a) || !Number.isFinite(b))
        return undefined;
    return `${String((a >> 8) & 0xff)}.${String(a & 0xff)}.${String((b >> 8) & 0xff)}.${String(b & 0xff)}`;
}
/** 校验失败时抛的错误（带用户可读中文文案）。 */
export class UnsafeUrlError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UnsafeUrlError';
    }
}
/**
 * 校验一个要抓取的 URL：协议、凭据、主机名、DNS 解析结果。
 * @param raw - 原始 URL。
 * @param options.allowPrivate - 是否允许内网地址（默认不允许；只有明确配置开启时才放行本机图床）。
 * @returns 已校验的 URL 与要连接的 IP。
 * @throws {UnsafeUrlError} 校验不通过。
 */
export async function validateFetchUrl(raw, options = {}) {
    const allowPrivate = options.allowPrivate === true;
    let url;
    try {
        url = new URL(String(raw).trim());
    }
    catch {
        throw new UnsafeUrlError('URL 无效');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new UnsafeUrlError('仅允许 http/https 地址');
    }
    if (url.username !== '' || url.password !== '') {
        throw new UnsafeUrlError('URL 不能包含账号密码');
    }
    const ip = await resolveSafeHost(url.hostname, { allowPrivate });
    return { url, ip };
}
/**
 * 把主机名解析成一个「已确认安全」的 IP。
 * @param hostname - 主机名。
 * @param options.allowPrivate - 允许内网时跳过检查（本机图床场景）。
 * @returns 用于连接的 IP 字面量。
 */
export async function resolveSafeHost(hostname, options = {}) {
    const allowPrivate = options.allowPrivate === true;
    const host = hostname.trim().toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '');
    if (host === '')
        throw new UnsafeUrlError('主机名为空');
    if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))) {
        throw new UnsafeUrlError('禁止访问内网/本机地址');
    }
    if (isIP(host) !== 0) {
        if (!allowPrivate && isPrivateIp(host))
            throw new UnsafeUrlError('禁止访问内网/本机地址');
        return host;
    }
    let addresses;
    try {
        addresses = await Promise.race([
            dns.lookup(host, { all: true, verbatim: true }),
            new Promise((_, reject) => {
                const timer = setTimeout(() => { reject(new UnsafeUrlError('DNS 解析超时')); }, DNS_TIMEOUT_MS);
                timer.unref?.();
            }),
        ]);
    }
    catch (error) {
        if (error instanceof UnsafeUrlError)
            throw error;
        throw new UnsafeUrlError(`域名解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (addresses.length === 0)
        throw new UnsafeUrlError('域名没有解析结果');
    // 逐条检查：只要有一条指向内网就整体拒绝（多 A 记录里混一条内网也算攻击）。
    for (const item of addresses) {
        if (!allowPrivate && isPrivateIp(item.address)) {
            throw new UnsafeUrlError('域名解析到内网/本机地址，已阻止');
        }
    }
    return addresses[0].address;
}
/**
 * 发一次 GET 请求。**连的是已校验的 IP**，SNI 与 Host 头仍用原域名。
 */
function requestOnce(url, ip, options) {
    return new Promise((resolve, reject) => {
        const isHttps = url.protocol === 'https:';
        const mod = isHttps ? https : http;
        const headers = {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qq-groupmate/1.0',
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/*;q=0.8,*/*;q=0.8',
            'accept-language': 'zh-CN,zh;q=0.9',
            'host': url.host,
        };
        // 透传的额外头做白名单：丢掉凭据类，值去掉换行、限长（防请求头注入）。
        for (const [key, value] of Object.entries(options.headers ?? {})) {
            const name = key.toLowerCase();
            if (name === 'host' || name === 'cookie' || name === 'authorization')
                continue;
            headers[name] = String(value).replace(/[\r\n]/gu, '').slice(0, 500);
        }
        const request = mod.request({
            hostname: ip,
            servername: url.hostname,
            port: url.port === '' ? (isHttps ? 443 : 80) : Number(url.port),
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            headers,
            rejectUnauthorized: isHttps,
            timeout: REQUEST_TIMEOUT_MS,
        }, (response) => {
            const status = response.statusCode ?? 0;
            if ([301, 302, 303, 307, 308].includes(status)) {
                response.resume();
                const location = response.headers.location;
                resolve({ statusCode: status, truncated: false, ...(location === undefined ? {} : { redirect: location }) });
                return;
            }
            readBounded(response, options.maxBytes, !options.asBinary)
                .then((read) => {
                resolve({
                    statusCode: status,
                    truncated: read.truncated,
                    ...(options.asBinary
                        ? { buffer: read.buffer ?? Buffer.alloc(0), contentType: String(response.headers['content-type'] ?? '') }
                        : { body: read.text ?? '' }),
                });
            })
                .catch(reject);
        });
        request.on('timeout', () => { request.destroy(new Error(`请求超时（${String(REQUEST_TIMEOUT_MS)}ms）`)); });
        request.on('error', reject);
        request.end();
    });
}
/** 限长读取响应体；超限就截断（文本按码点切，别把代理对切一半）。 */
function readBounded(response, maxBytes, asText) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const decoder = new StringDecoder('utf8');
        let text = '';
        let total = 0;
        let truncated = false;
        response.on('data', (chunk) => {
            if (truncated)
                return;
            // 只按累计**字节数**判超限：按字符数判会让多字节正文超长（原版的 bug）。
            total += chunk.length;
            if (asText)
                text += decoder.write(chunk);
            else
                chunks.push(chunk);
            if (total >= maxBytes) {
                truncated = true;
                response.destroy();
            }
        });
        response.on('end', () => {
            if (asText) {
                text += decoder.end();
                resolve({ text: truncated ? sliceByCodePoints(text, maxBytes) : text, truncated });
            }
            else {
                const buffer = Buffer.concat(chunks);
                resolve({ buffer: truncated ? buffer.subarray(0, maxBytes) : buffer, truncated });
            }
        });
        response.on('error', reject);
    });
}
/** 按码点切片，避免把 emoji 的代理对切一半。 */
function sliceByCodePoints(text, max) {
    return Array.from(text).slice(0, max).join('');
}
/**
 * 抓一个网页的正文（纯文本，最多 {@link MAX_BODY_CHARS} 字）。
 * 每一跳重定向都重新做 DNS 校验，防「公网地址 302 到内网」。
 * @param urlString - 要抓的地址。
 * @returns 抓取结果。
 */
export async function safeFetch(urlString) {
    let current = await validateFetchUrl(urlString);
    for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
        const result = await requestOnce(current.url, current.ip, { asBinary: false, maxBytes: MAX_BODY_CHARS });
        if (result.redirect === undefined) {
            const body = result.body ?? '';
            return {
                url: current.url.toString(),
                statusCode: result.statusCode,
                truncated: result.truncated || body.length >= MAX_BODY_CHARS,
                body,
            };
        }
        current = await validateFetchUrl(new URL(result.redirect, current.url).toString());
    }
    throw new UnsafeUrlError('重定向次数过多，已停止');
}
/**
 * 抓一段二进制（下载图片）。
 * @param urlString - 图片地址。
 * @param maxBytes - 大小上限，默认 {@link MAX_BINARY_BYTES}。
 * @param options - `headers` 用来带 referer/accept（图床防盗链）；`allowPrivateHosts` 放行内网地址。
 * @returns 二进制内容与 content-type；非 200 抛错。
 */
export async function safeFetchBinary(urlString, maxBytes = MAX_BINARY_BYTES, options = {}) {
    let current = await validateFetchUrl(urlString, { allowPrivate: options.allowPrivateHosts === true });
    for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
        const result = await requestOnce(current.url, current.ip, {
            asBinary: true,
            maxBytes,
            ...(options.headers === undefined ? {} : { headers: options.headers }),
        });
        if (result.redirect !== undefined) {
            current = await validateFetchUrl(new URL(result.redirect, current.url).toString(), {
                allowPrivate: options.allowPrivateHosts === true,
            });
            continue;
        }
        if (result.statusCode !== 200)
            throw new Error(`HTTP ${String(result.statusCode)}`);
        return { buffer: result.buffer ?? Buffer.alloc(0), contentType: result.contentType ?? '' };
    }
    throw new UnsafeUrlError('重定向次数过多，已停止');
}
/** 校验一个图片地址能不能给我们下载（不过 DNS 时用 allowPrivateHosts 直接放行）。 */
export async function validateImageUrl(raw, options = {}) {
    if (options.allowPrivateHosts === true) {
        let url;
        try {
            url = new URL(String(raw).trim());
        }
        catch {
            throw new UnsafeUrlError('URL 无效');
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            throw new UnsafeUrlError('仅允许 http/https 地址');
        return url.toString();
    }
    const checked = await validateFetchUrl(raw);
    return checked.url.toString();
}
/**
 * 抓网页并把 HTML 压成纯文本（去脚本/样式/标签，解 HTML 实体，限长）。
 * 给「模型想看这个链接」用的：不解析 DOM，只求正文可读。
 * @param url - 网页地址。
 * @returns 标题与正文；`title` 可能为空串。
 */
export async function fetchPageText(url) {
    const result = await safeFetch(url);
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(result.body);
    const title = titleMatch === null ? '' : decodeHtml(titleMatch[1]).trim();
    const text = htmlToText(result.body, MAX_BODY_CHARS);
    return { url: result.url, title, text, truncated: result.truncated };
}
/**
 * 去掉行内 HTML 标签、把块级标签当换行，压平空白。用于「标题 / 摘要」这类短文本。
 *
 * 这里是**直接删掉**行内标签而不是换成空格：B 站的搜索建议和高亮标题会把关键词
 * 包成 `<em>梗</em>名`，换成空格就变成「梗 名」，之后按子串判断命中永远对不上。
 */
export function stripHtmlTags(text) {
    return decodeHtml(String(text ?? '')
        .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/giu, '\n')
        .replace(/<[^>]*>/gu, ''))
        .split(/\r?\n/u)
        .map(line => line.replace(/[ \t\u00a0]+/gu, ' ').trim())
        .filter(line => line !== '')
        .join(' ');
}
/** HTML → 纯文本：去脚本样式、块级标签转换行、去剩余标签、解实体、压缩空白。 */
export function htmlToText(html, max = MAX_BODY_CHARS) {
    const stripped = String(html)
        .replace(/<script[\s\S]*?<\/script>/giu, ' ')
        .replace(/<style[\s\S]*?<\/style>/giu, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/giu, ' ')
        .replace(/<!--[\s\S]*?-->/gu, ' ')
        .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section)[^>]*>/giu, '\n')
        .replace(/<[^>]+>/gu, ' ');
    const decoded = decodeHtml(stripped);
    const lines = decoded
        .split(/\r?\n/u)
        .map(line => line.replace(/[ \t\u00a0]+/gu, ' ').trim())
        .filter(line => line !== '');
    return sliceByCodePoints(lines.join('\n'), max);
}
/** 解 HTML 实体（常见命名实体 + 数字实体）。 */
export function decodeHtml(text) {
    const named = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
        hellip: '…', mdash: '—', ndash: '–', middot: '·', times: '×',
        copy: '©', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
    };
    return String(text)
        .replace(/&#x([0-9a-f]+);/giu, (_, hex) => {
        const code = Number.parseInt(hex, 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
        .replace(/&#(\d+);/gu, (_, dec) => {
        const code = Number.parseInt(dec, 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
        .replace(/&([a-z]+);/giu, (whole, name) => named[name.toLowerCase()] ?? whole);
}
/** 抓取失败时把错误压成一句人话（给模型看的工具返回）。 */
export function describeFetchError(error, logger) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UnsafeUrlError)
        return message;
    logger?.debug?.('qq-groupmate: 抓取失败：%s', message);
    return `抓取失败：${message}`;
}
