/**
 * 分层记忆：归档 + 本地索引 + 按需检索。
 *
 * 设计取自 qq-agent 的 conversation-memory：**记忆平常不进提示词，问旧事才检索**。
 * 以前这台插件把历史压成摘要、每一轮都塞进上下文（实测每轮 6500 字左右），代价是：
 *   ① 每轮都花 token；
 *   ② 上下文块每轮都在变 → 请求前缀跟着变 → 上游的前缀缓存命中率被拖垮。
 * 现在拆成三层，各管一段：
 *   归档层：消息按小时切块写盘，**不注入**；
 *   索引层：本地倒排索引（关键词 → 块），纯本地计算、不调模型、不花钱；
 *   取用层：模型写 `[回忆:关键词]` 时才检索，命中片段回灌给这一轮。
 *
 * 磁盘布局（都在 <数据目录>/memory/ 下）：
 *   chunks/<scope>/<YYYY-MM-DD-HH>.json   一小时一个块，块内按时间正序
 *   chunks/<scope>/_index.json            该会话的倒排索引（词 → 块 → 次数）
 * state.json 由调用方持有归档进度，本模块只写块与索引。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** 一个块里最多留多少行（一小时的消息通常远小于这个数，兜底防爆）。 */
const MAX_LINES_PER_CHUNK = 4000;
/** 索引里最多保留多少个词（按出现次数保留高频的，防止索引无限膨胀）。 */
const MAX_INDEX_WORDS = 20000;
/** 检索返回的片段上限。 */
const MAX_SNIPPETS = 12;
/** 中文按 2 字切（n-gram）——中文没有空格，二元组是最省事又够用的切法。 */
function tokenize(text) {
    const out = new Set();
    const value = String(text ?? '').toLowerCase();
    // 英文单词 / 数字
    for (const word of value.match(/[a-z0-9_]{2,}/gu) ?? [])
        out.add(word);
    // 连续汉字：整词 + 二元组
    for (const run of value.match(/[\u4e00-\u9fff]+/gu) ?? []) {
        if (run.length >= 2 && run.length <= 6)
            out.add(run);
        for (let i = 0; i + 2 <= run.length; i += 1)
            out.add(run.slice(i, i + 2));
    }
    return [...out];
}
/** 会话键转成安全的目录名。 */
function scopeDir(scope) {
    return String(scope).replace(/[^a-zA-Z0-9_:-]/gu, '_');
}
/** 某个时间点所属的小时块名（本地时间）。 */
function chunkName(time) {
    const d = new Date(time);
    const pad = (n) => String(n).padStart(2, '0');
    return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}`;
}
/**
 * 归档 + 检索。
 *
 * 写入走内存缓冲（一分钟内的消息合成一次落盘），检索直接读磁盘上的块。
 */
export class RecallStore {
    root;
    logger;
    settings;
    /** scope -> Map(blockName -> 待落盘的行)。 */
    buffers = new Map();
    /** scope -> 倒排索引（内存副本，落盘时同步写 _index.json）。 */
    indexes = new Map();
    /** scope -> 已归档的最大 seq（重放/重启后不重复写入）。 */
    archivedThrough = new Map();
    flushTimer = null;
    disposed = false;
    constructor(dataDir, logger, settings = {}) {
        this.root = join(dataDir, 'memory', 'chunks');
        this.logger = logger;
        this.settings = settings;
        mkdirSync(this.root, { recursive: true });
    }
    get enabled() {
        return this.settings.enabled !== false;
    }
    dirOf(scope) {
        return join(this.root, scopeDir(scope));
    }
    /**
     * 归档一条历史（在 appendHistory 时顺手调用）。
     * @param scope - 群号或 `private:<QQ>`。
     * @param entry - `{ seq, speaker, userId, text, time }`。
     */
    append(scope, entry) {
        if (!this.enabled || this.disposed)
            return;
        const text = String(entry?.text ?? '').trim();
        if (text === '')
            return;
        const seq = Number(entry?.seq ?? 0);
        const seen = this.archivedThrough.get(scope) ?? -1;
        if (seq > 0 && seq <= seen)
            return;
        const at = Number(entry?.time ?? Date.now());
        const block = chunkName(at);
        let blocks = this.buffers.get(scope);
        if (blocks === undefined) {
            blocks = new Map();
            this.buffers.set(scope, blocks);
        }
        let lines = blocks.get(block);
        if (lines === undefined) {
            lines = [];
            blocks.set(block, lines);
        }
        if (lines.length >= MAX_LINES_PER_CHUNK)
            return;
        lines.push({
            seq,
            at,
            speaker: String(entry?.speaker ?? ''),
            userId: String(entry?.userId ?? ''),
            role: entry?.role === 'assistant' ? 'assistant' : 'user',
            text: text.slice(0, 500),
        });
        if (seq > 0)
            this.archivedThrough.set(scope, seq);
        this.scheduleFlush();
    }
    /** 一分钟防抖落盘：群里刷屏时不至于每来一条都写文件。 */
    scheduleFlush() {
        if (this.flushTimer !== null)
            return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, 60_000);
        this.flushTimer.unref?.();
    }
    /** 把内存缓冲写进块文件与索引。 */
    flush(scope) {
        const scopes = scope === undefined ? [...this.buffers.keys()] : [scope];
        for (const key of scopes) {
            const blocks = this.buffers.get(key);
            if (blocks === undefined || blocks.size === 0)
                continue;
            const dir = this.dirOf(key);
            mkdirSync(dir, { recursive: true });
            for (const [block, lines] of blocks) {
                if (lines.length === 0)
                    continue;
                const file = join(dir, `${block}.json`);
                let existing = [];
                if (existsSync(file)) {
                    try {
                        const parsed = JSON.parse(readFileSync(file, 'utf8'));
                        if (Array.isArray(parsed?.lines))
                            existing = parsed.lines;
                    }
                    catch {
                        // 坏文件直接覆盖，别让它一直卡住归档
                    }
                }
                const merged = existing.concat(lines).slice(-MAX_LINES_PER_CHUNK);
                const tmp = `${file}.tmp`;
                writeFileSync(tmp, JSON.stringify({ block, lines: merged }), 'utf8');
                renameSync(tmp, file);
            }
            blocks.clear();
            this.rebuildIndex(key);
        }
    }
    /** 重建某个会话的倒排索引（词 → 块 → 次数）。纯本地，块不多时毫秒级。 */
    rebuildIndex(scope) {
        if (!this.enabled)
            return;
        const dir = this.dirOf(scope);
        if (!existsSync(dir))
            return;
        const index = new Map();
        for (const name of readdirSync(dir)) {
            if (!name.endsWith('.json') || name.startsWith('_'))
                continue;
            let lines = [];
            try {
                const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
                lines = Array.isArray(parsed?.lines) ? parsed.lines : [];
            }
            catch {
                continue;
            }
            for (const line of lines) {
                for (const word of tokenize(line.text)) {
                    let perBlock = index.get(word);
                    if (perBlock === undefined) {
                        perBlock = new Map();
                        index.set(word, perBlock);
                    }
                    perBlock.set(name, (perBlock.get(name) ?? 0) + 1);
                }
            }
        }
        // 只留高频词，防止索引比数据还大。
        const trimmed = [...index.entries()]
            .map(([word, perBlock]) => [word, perBlock, [...perBlock.values()].reduce((a, b) => a + b, 0)])
            .sort((a, b) => b[2] - a[2])
            .slice(0, MAX_INDEX_WORDS);
        const plain = {};
        for (const [word, perBlock] of trimmed)
            plain[word] = Object.fromEntries(perBlock);
        this.indexes.set(scope, plain);
        try {
            const tmp = join(dir, '_index.json.tmp');
            writeFileSync(tmp, JSON.stringify(plain), 'utf8');
            renameSync(tmp, join(dir, '_index.json'));
        }
        catch (error) {
            this.logger?.warn('qq-groupmate: 记忆索引落盘失败（%s）：%s', scope, String(error));
        }
    }
    /** 读索引（内存 → 磁盘 → 现场重建）。 */
    indexOf(scope) {
        const cached = this.indexes.get(scope);
        if (cached !== undefined)
            return cached;
        const file = join(this.dirOf(scope), '_index.json');
        if (existsSync(file)) {
            try {
                const parsed = JSON.parse(readFileSync(file, 'utf8'));
                this.indexes.set(scope, parsed);
                return parsed;
            }
            catch {
                // 坏索引：重建一次
            }
        }
        this.rebuildIndex(scope);
        return this.indexes.get(scope) ?? {};
    }
    /**
     * 检索旧事。
     * @param scope - 群号或 `private:<QQ>`。
     * @param query - 模型给的关键词。
     * @param limit - 最多返回几条片段。
     * @returns 命中的片段（时间正序），没有就返回空数组。
     */
    search(scope, query, limit = MAX_SNIPPETS) {
        if (!this.enabled)
            return [];
        this.flush(scope);
        const words = tokenize(query);
        if (words.length === 0)
            return [];
        const index = this.indexOf(scope);
        const scores = new Map();
        for (const word of words) {
            const perBlock = index[word];
            if (perBlock === undefined)
                continue;
            for (const [block, count] of Object.entries(perBlock)) {
                // 词越少见的块越可疑？不——命中词数相同就按出现次数排，够用了。
                scores.set(block, (scores.get(block) ?? 0) + Number(count));
            }
        }
        if (scores.size === 0)
            return [];
        const wanted = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
        const out = [];
        for (const [block] of wanted) {
            const file = join(this.dirOf(scope), block);
            if (!existsSync(file))
                continue;
            let lines = [];
            try {
                const parsed = JSON.parse(readFileSync(file, 'utf8'));
                lines = Array.isArray(parsed?.lines) ? parsed.lines : [];
            }
            catch {
                continue;
            }
            for (const line of lines) {
                if (words.some(word => line.text.toLowerCase().includes(word)))
                    out.push(line);
            }
        }
        return out.sort((a, b) => a.at - b.at).slice(-Math.max(1, limit));
    }
    /** 归档进度（重启后接着写，不重复归档）。 */
    markArchived(scope, seq) {
        if (seq > (this.archivedThrough.get(scope) ?? -1))
            this.archivedThrough.set(scope, seq);
    }
    /** 该会话归档了多少块、多少条。 */
    stats(scope) {
        const dir = this.dirOf(scope);
        if (!existsSync(dir))
            return { blocks: 0, lines: 0 };
        let blocks = 0;
        let lines = 0;
        for (const name of readdirSync(dir)) {
            if (!name.endsWith('.json') || name.startsWith('_'))
                continue;
            blocks += 1;
            try {
                const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
                lines += Array.isArray(parsed?.lines) ? parsed.lines.length : 0;
            }
            catch {
                // 坏块跳过
            }
        }
        return { blocks, lines };
    }
    /** 清理超过保留天数的块（默认 120 天）。 */
    prune(daysToKeep = 120) {
        if (!this.enabled)
            return 0;
        const cutoff = Date.now() - Math.max(1, daysToKeep) * 86400_000;
        let removed = 0;
        if (!existsSync(this.root))
            return 0;
        for (const scope of readdirSync(this.root)) {
            const dir = join(this.root, scope);
            let touched = false;
            try {
                for (const name of readdirSync(dir)) {
                    const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.json$/u.exec(name);
                    if (m === null)
                        continue;
                    const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4])).getTime();
                    if (at >= cutoff)
                        continue;
                    rmSync(join(dir, name), { force: true });
                    removed += 1;
                    touched = true;
                }
            }
            catch {
                continue;
            }
            if (touched)
                this.rebuildIndex(scope);
        }
        return removed;
    }
    /** 卸载：把缓冲落盘并停掉定时器。 */
    dispose() {
        this.disposed = true;
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.flush();
    }
}
