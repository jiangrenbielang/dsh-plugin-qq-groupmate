/**
 * 识图：把 QQ 消息里的图片取下来，转成 `data:` URL 交给视觉模型。
 *
 * 取图有两条路：消息段里自带 `url` 就直接下；没有就调 OneBot 的 `get_image` 换一个地址。
 * 单张超过上限、或者取不到，就跳过这张（记一条日志），不影响这条消息的其它内容。
 */
/**
 * 视觉模型明确拒绝过的图片格式（比如有的中转站不收 GIF）。
 * 记下来之后同类图片就不再往请求里塞，省一次注定失败的调用。
 */
const rejectedMimes = new Set();
/** 从失败信息里认出「不支持哪种图片格式」并记住它。 */
export function noteImageRejection(message, logger) {
    const match = /Unsupported MIME type:\s*([\w/+.-]+)/iu.exec(message);
    if (match === null)
        return;
    const mime = (match[1] ?? '').toLowerCase();
    if (mime === '' || rejectedMimes.has(mime))
        return;
    rejectedMimes.add(mime);
    logger.warn('qq-groupmate: 视觉模型不支持 %s，以后这类图不再带过去', mime);
}
/** 从消息段里挑出图片。 */
export function collectImages(segments) {
    const images = [];
    for (const segment of segments) {
        if (segment.type !== 'image')
            continue;
        const data = segment.data;
        const file = typeof data.file === 'string' ? data.file : undefined;
        const url = typeof data.url === 'string' ? data.url : undefined;
        if (file !== undefined || url !== undefined)
            images.push({ file, url });
    }
    return images;
}
/** 下载一张图（取不到或超限返回 undefined）。 */
export async function downloadImage(client, image, maxBytes, logger) {
    let url = image.url;
    if (url === undefined && image.file !== undefined) {
        try {
            const info = await client.call('get_image', { file: image.file });
            url = typeof info?.url === 'string' && info.url !== '' ? info.url : undefined;
        }
        catch (error) {
            logger.warn('qq-groupmate: get_image 取图失败：%s', String(error));
        }
    }
    if (url === undefined) {
        logger.warn('qq-groupmate: 图片既没有 url 也拿不到地址，跳过这张');
        return undefined;
    }
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) {
            logger.warn('qq-groupmate: 下载图片失败（HTTP %s）', String(response.status));
            return undefined;
        }
        // 先看 content-length，明显超限就别把响应体读进内存。
        const declared = Number(response.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > maxBytes) {
            logger.warn('qq-groupmate: 图片声明 %s 字节，超过上限 %s，跳过', String(declared), String(maxBytes));
            return undefined;
        }
        // 流式读取并在超限时立刻取消：不信任 content-length（可能缺失或虚报）。
        if (response.body === null) {
            logger.warn('qq-groupmate: 图片响应没有正文，跳过');
            return undefined;
        }
        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;
        let overflow = false;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                received += value.byteLength;
                if (received > maxBytes) {
                    overflow = true;
                    await reader.cancel().catch(() => { });
                    break;
                }
                chunks.push(Buffer.from(value));
            }
        }
        finally {
            reader.releaseLock();
        }
        if (overflow) {
            logger.warn('qq-groupmate: 图片超过上限 %s 字节，已取消下载', String(maxBytes));
            return undefined;
        }
        const buffer = Buffer.concat(chunks);
        const mime = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
        return { buffer, mime: mime.startsWith('image/') ? mime : 'image/jpeg' };
    }
    catch (error) {
        logger.warn('qq-groupmate: 下载图片异常：%s', String(error));
        return undefined;
    }
}
/** 取一批图片（最多 maxImages 张），返回可直接塞进请求的 `data:` URL。 */
export async function fetchImages(client, segments, settings, logger) {
    const images = collectImages(segments).slice(0, Math.max(1, settings.maxImages));
    const result = [];
    for (const image of images) {
        const downloaded = await downloadImage(client, image, settings.maxBytes, logger);
        if (downloaded === undefined)
            continue;
        if (rejectedMimes.has(downloaded.mime.toLowerCase())) {
            logger.info('qq-groupmate: 跳过一张 %s（视觉模型不认这个格式）', downloaded.mime);
            continue;
        }
        result.push(`data:${downloaded.mime};base64,${downloaded.buffer.toString('base64')}`);
    }
    return result;
}
