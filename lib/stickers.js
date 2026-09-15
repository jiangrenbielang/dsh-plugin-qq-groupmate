/**
 * 表情包：本地放一个图片文件夹，模型想发的时候输出 `[表情:名字]`，
 * 插件把它换成真正的图片消息发出去（OneBot image 段，base64 传输）。
 *
 * 文件夹里认这些后缀：png / jpg / jpeg / gif / webp / bmp；文件名（去掉后缀）就是表情名。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
const STICKER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
/** MIME → 文件后缀。 */
function extensionOf(mime) {
    switch (mime.toLowerCase()) {
        case 'image/jpeg':
        case 'image/jpg':
            return '.jpg';
        case 'image/gif':
            return '.gif';
        case 'image/webp':
            return '.webp';
        case 'image/bmp':
            return '.bmp';
        default:
            return '.png';
    }
}
/** `收藏-MMDD-HHmmss` 形式的默认名字。 */
function timestamp() {
    const pad = (value) => (value < 10 ? `0${String(value)}` : String(value));
    const now = new Date();
    return `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
/** 从回复里拆出「要发的表情」和「剩下的文字」。 */
export function parseStickers(reply) {
    const stickers = [];
    const text = reply
        .replace(/\[表情[:：]\s*([^\]\n]+?)\s*\]/gu, (_, name) => {
        const trimmed = name.trim();
        if (trimmed !== '')
            stickers.push(trimmed);
        return '';
    })
        .replace(/[ \t]+/gu, ' ')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
    return { text, stickers: stickers.slice(0, 3) };
}
/** 本地表情库：扫目录、查名字、转成消息段。 */
export class StickerLibrary {
    settings;
    logger;
    files = new Map();
    /** 上次扫描时目录的修改时间，用来发现「用户刚往里丢了图」。 */
    lastScan = -1;
    constructor(settings, logger) {
        this.settings = settings;
        this.logger = logger;
        this.refresh();
    }
    /** 目录有变动就重新扫描，这样往文件夹里丢图片不用重启。 */
    refreshIfChanged() {
        if (!this.settings.enabled)
            return;
        try {
            if (statSync(this.settings.dir).mtimeMs === this.lastScan)
                return;
        }
        catch {
            return;
        }
        this.refresh();
    }
    /** 重新扫描目录（换表情不用重启）。名字统一按小写存，查询大小写不敏感。 */
    refresh() {
        this.files.clear();
        try {
            this.lastScan = statSync(this.settings.dir).mtimeMs;
        }
        catch {
            this.lastScan = -1;
        }
        if (!this.settings.enabled || !existsSync(this.settings.dir))
            return;
        try {
            for (const entry of readdirSync(this.settings.dir)) {
                const extension = extname(entry).toLowerCase();
                if (!STICKER_EXTENSIONS.has(extension))
                    continue;
                const name = basename(entry, extname(entry)).trim().toLowerCase();
                if (name === '' || this.files.has(name))
                    continue;
                this.files.set(name, join(this.settings.dir, entry));
            }
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 扫描表情目录失败：%s', String(error));
        }
        if (this.files.size > 0) {
            this.logger.info('qq-groupmate: 已加载 %s 个表情：%s', String(this.files.size), [...this.files.keys()].join('、'));
        }
    }
    /** 是否启用（不要求库里已经有表情）。 */
    get enabled() {
        return this.settings.enabled;
    }
    /** 表情目录。 */
    get directory() {
        return this.settings.dir;
    }
    /** 当前表情数量。 */
    get count() {
        this.refreshIfChanged();
        return this.files.size;
    }
    /**
     * 存一张图进表情库（同名会替换掉旧文件），返回最终表情名。
     * @param name - 想要的名称；空字符串则用时间戳命名。
     * @param data - 图片字节。
     * @param mime - 图片 MIME，用来决定后缀。
     */
    save(name, data, mime) {
        const fallback = `收藏-${timestamp()}`;
        const clean = name.replace(/[\\/:*?"<>|]/gu, '_').replace(/\s+/gu, ' ').trim().slice(0, 40) || fallback;
        const extension = extensionOf(mime);
        try {
            mkdirSync(this.settings.dir, { recursive: true });
            // 同名（不分大小写）不同后缀的旧文件先删掉，避免一个名字对应多张图。
            const lowerClean = clean.toLowerCase();
            for (const entry of readdirSync(this.settings.dir)) {
                if (basename(entry, extname(entry)).trim().toLowerCase() === lowerClean)
                    rmSync(join(this.settings.dir, entry), { force: true });
            }
            writeFileSync(join(this.settings.dir, `${clean}${extension}`), data);
            this.refresh();
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 收藏表情失败：%s', String(error));
        }
        return clean;
    }
    /** 顺手补一张表情的概率。 */
    get probability() {
        return Math.max(0, Math.min(1, this.settings.probability));
    }
    /** 随机挑一个表情名（库空时返回 undefined）。 */
    pick() {
        this.refreshIfChanged();
        const names = [...this.files.keys()];
        if (names.length === 0)
            return undefined;
        return names[Math.floor(Math.random() * names.length)];
    }
    /** 是否可用。 */
    get available() {
        this.refreshIfChanged();
        return this.settings.enabled && this.files.size > 0;
    }
    /** 提示词里列出的表情名（按名字排序，截断）。 */
    names() {
        this.refreshIfChanged();
        return [...this.files.keys()].sort().slice(0, Math.max(1, this.settings.maxListed));
    }
    /** 名字 → 文件路径（大小写不敏感）。 */
    pathOf(name) {
        this.refreshIfChanged();
        return this.files.get(name.trim().toLowerCase());
    }
    /**
     * 读成 OneBot 图片段。
     * @param name - 表情名。
     * @param format - `base64`（默认，兼容性最好）或 `file`（协议端不认 base64 时的兜底）。
     */
    segmentOf(name, format = 'base64') {
        const path = this.pathOf(name);
        if (path === undefined)
            return undefined;
        if (format === 'file') {
            return { type: 'image', data: { file: `file://${path.split('\\').join('/')}` } };
        }
        try {
            const data = readFileSync(path);
            return { type: 'image', data: { file: `base64://${data.toString('base64')}` } };
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 读取表情「%s」失败：%s', name, String(error));
            return undefined;
        }
    }
}
