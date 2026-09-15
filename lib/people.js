/**
 * 「群友档案」：跨群的长期印象 + 遗忘曲线 + 表层记忆。
 *
 * 为什么需要它：插件原本只有**按会话隔离**的历史与总结——同一个 QQ 号在 A 群聊过的事，
 * 到 B 群就不认识了；私聊交代一句「我明天考试」，在群里也不会自然接上。
 * 这个模块按 **QQ 号**（不是按群）存印象，于是「同一个人换群不用重新认识」。
 *
 * 四层（移植自 QQ-Agent 的四层记忆）：
 * 1. **表层记忆**（surface）：某人刚在别处说的原话，默认 10 分钟过期，只用来接话茬；
 * 2. **本会话印象**（fact.sources 指向 chatKey）：这个人在本群的表现；
 * 3. **跨群档案**（同一个 fact 被多个 chatKey 引用）：别处学到的画像；
 * 4. **长期事件**（event）：约定 / 梗 / 恩怨 / 稳定偏好，用**遗忘曲线**管寿命。
 *
 * 遗忘曲线（**只在读取时实时折算，不做定时扣分**）：
 * ```
 * halfLifeDays = 30 × (1 + (importance - 1) × 0.75)     // 重要度 1→30 天，5→120 天
 * effectiveWeight = clamp(weight × 0.5 ^ (闲置天数 / halfLifeDays), 0, 1)
 * score = effectiveWeight × 0.65 + (importance / 5) × 0.35
 * ```
 * 「经常被提到」会加权重（+0.25），所以常聊的事记得牢；`pinned` 恒为 1 永不衰减。
 *
 * **可见性闸门**（`visible`）决定跨会话能不能看见：默认同会话永远可见，
 * 别的群/私聊之间需要 `crossGroupEnabled`，且可以按会话排除（`crossGroupExclude`）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safeChatKey, safeUserId } from "./history.js";
const DAY_MS = 86_400_000;
/** 落盘防抖：群消息高频触发写入，合并成一次（毫秒）。 */
const WRITE_DEBOUNCE_MS = 1500;
/** 原型污染防护：这几个键不能当 chatKey 用。 */
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** 长期事件的类别。 */
export const EVENT_KINDS = ['event', 'topic', 'promise', 'joke', 'grudge', 'preference'];
/** 默认档案设置。 */
export function defaultPeopleSettings() {
    return {
        enabled: true,
        crossGroupEnabled: true,
        privateToGroup: true,
        crossGroupExclude: [],
        peopleMaxInject: 6,
        eventsMaxInject: 6,
        maxChars: 1400,
        factsPerPersonInject: 3,
        decayHalfLifeDays: 30,
        decayMinWeight: 0.08,
        decayMinAgeDays: 7,
        keepImportance: 4,
        maxFactsPerPerson: 12,
        maxEventsPerChat: 150,
        maxEventsTotal: 400,
        surfaceEnabled: true,
        surfaceTtlMs: 10 * 60_000,
        surfaceMaxPerPerson: 50,
        surfaceMaxInject: 6,
    };
}
/** 会话键的显示名：`private:123` → 「私聊 123」，群号 → 「群 456」。 */
export function chatLabel(chatKey) {
    if (chatKey.startsWith('private:'))
        return `私聊 ${chatKey.slice('private:'.length)}`;
    return `群 ${chatKey}`;
}
/** 归一化文本：小写、去空白、去标点，用于去重比对。 */
export function normText(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[\s\u3000]+/gu, '')
        .replace(/[，。！？、,.!?;:：；"'“”‘’（）()\[\]【】~～…—-]/gu, '')
        .slice(0, 400);
}
/** 半衰期：重要度越高衰减越慢。 */
export function halfLifeDays(importance, baseDays = 30) {
    const level = clampInt(importance ?? 3, 1, 5, 3);
    return baseDays * (1 + (level - 1) * 0.75);
}
/**
 * 折算一条记录的当前权重（遗忘曲线）。
 * @param entry - 有 `weight`/`importance`/`pinned` 与时间戳的记录。
 * @param now - 当前时间。
 * @param baseDays - 基准半衰期。
 * @returns 0~1 的有效权重；`pinned` 恒为 1。
 */
export function effectiveWeight(entry, now = Date.now(), baseDays = 30) {
    if (entry === undefined)
        return 0;
    if (entry.pinned === true)
        return 1;
    const base = entry.weight === undefined ? 1 : clamp(entry.weight, 0, 1);
    const touched = entry.lastTouchedAt ?? entry.updatedAt ?? entry.createdAt ?? now;
    const ageDays = Math.max(0, (now - touched) / DAY_MS);
    return clamp(base * Math.pow(0.5, ageDays / halfLifeDays(entry.importance, baseDays)), 0, 1);
}
/** 综合分：权重 65% + 重要度 35%。 */
export function scoreOf(entry, now = Date.now(), baseDays = 30) {
    const weight = effectiveWeight(entry, now, baseDays);
    const importance = clampInt(entry?.importance ?? 3, 1, 5, 3) / 5;
    return weight * 0.65 + importance * 0.35;
}
/** 分词：拉丁词 + 中文二元组（比单字准、比整句松）。 */
export function tokenize(text) {
    const value = String(text ?? '').toLowerCase();
    const tokens = [];
    for (const word of value.match(/[a-z0-9_]{2,}/gu) ?? [])
        tokens.push(word);
    const cjk = value.replace(/[^\u4e00-\u9fff]/gu, '');
    if (cjk.length === 1)
        tokens.push(cjk);
    for (let i = 0; i + 2 <= cjk.length; i += 1)
        tokens.push(cjk.slice(i, i + 2));
    return [...new Set(tokens)];
}
/** 命中率：命中的 token 数 / token 总数。 */
export function matchScore(tokens, haystack) {
    if (tokens.length === 0)
        return 0;
    const hay = String(haystack ?? '').toLowerCase();
    let hit = 0;
    for (const token of tokens) {
        if (hay.includes(token))
            hit += 1;
    }
    return hit / tokens.length;
}
/** 时间的人话描述。 */
function formatAgo(at, now) {
    const diff = now - at;
    if (diff < 60_000)
        return '刚刚';
    const minutes = Math.round(diff / 60_000);
    if (minutes < 60)
        return `${String(minutes)} 分钟前`;
    const hours = Math.round(minutes / 60);
    if (hours < 24)
        return `${String(hours)} 小时前`;
    return `${String(Math.round(hours / 24))} 天前`;
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num))
        return fallback;
    return Math.min(max, Math.max(min, Math.trunc(num)));
}
/**
 * 群友档案仓库。
 *
 * 目录布局（`<数据目录>/people/`）：
 *   people.json   按 QQ 号的档案
 *   events.json   长期事件
 *   surface.json  表层记忆
 */
export class PeopleStore {
    dir;
    settings;
    logger;
    people = new Map();
    events = [];
    surface = [];
    surfaceLoaded = false;
    lastDecayAt = 0;
    /** 待落盘的文件名（防抖合并写；见 markDirty）。 */
    dirty = new Set();
    flushTimer;
    constructor(options) {
        this.dir = options.dir;
        this.settings = options.settings;
        this.logger = options.logger;
        this.load();
    }
    /** 从磁盘加载档案与事件。 */
    load() {
        this.people.clear();
        this.events = [];
        const peopleFile = this.file('people.json');
        if (existsSync(peopleFile)) {
            try {
                const raw = JSON.parse(readFileSync(peopleFile, 'utf8'));
                const list = Array.isArray(raw) ? raw : (raw.people ?? []);
                for (const item of list) {
                    const clean = this.sanitizePerson(item);
                    if (clean !== undefined)
                        this.people.set(clean.userId, clean);
                }
            }
            catch (error) {
                this.logger.warn('qq-groupmate: 群友档案文件损坏，已当空库处理：%s', String(error));
            }
        }
        const eventsFile = this.file('events.json');
        if (existsSync(eventsFile)) {
            try {
                const raw = JSON.parse(readFileSync(eventsFile, 'utf8'));
                const list = Array.isArray(raw) ? raw : (raw.events ?? []);
                for (const item of list) {
                    const clean = this.sanitizeEvent(item);
                    if (clean !== undefined)
                        this.events.push(clean);
                }
            }
            catch (error) {
                this.logger.warn('qq-groupmate: 长期记忆文件损坏，已当空库处理：%s', String(error));
            }
        }
    }
    /** 读表层记忆（懒加载：这一层寿命很短，不必每次启动都读）。 */
    ensureSurface() {
        if (this.surfaceLoaded)
            return;
        this.surfaceLoaded = true;
        const file = this.file('surface.json');
        if (!existsSync(file))
            return;
        try {
            const raw = JSON.parse(readFileSync(file, 'utf8'));
            const list = Array.isArray(raw) ? raw : (raw.items ?? []);
            const now = Date.now();
            this.surface = list.filter(item => item !== null && typeof item === 'object' && String(item.text ?? '').trim() !== '' && Number(item.expiresAt) > now);
        }
        catch {
            this.surface = [];
        }
    }
    file(name) {
        return join(this.dir, name);
    }
    /**
     * 落盘。
     *
     * **必须是防抖的**：档案的写入触发点里有「每条群消息」（记名字、留表层记忆），
     * 群高峰 40 条/分钟就是每分钟上百次全量 JSON 同步写，会卡住事件循环
     * （用户那台 2 核 2G 云服务器尤其明显）。这里只登记「哪个文件脏了」，
     * 由定时器合并成一次写；进程退出前用 {@link flush} 兜底。
     */
    markDirty(name) {
        this.dirty.add(name);
        if (this.flushTimer !== undefined)
            return;
        this.flushTimer = setTimeout(() => { this.flush(); }, WRITE_DEBOUNCE_MS);
        this.flushTimer.unref?.();
    }
    /** 立即把所有脏文件落盘（dispose / 测试断言前调用）。 */
    flush() {
        if (this.flushTimer !== undefined) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
        if (this.dirty.size === 0)
            return;
        const names = [...this.dirty];
        this.dirty.clear();
        for (const name of names) {
            try {
                if (name === 'people.json') {
                    this.write(name, { version: 1, updatedAt: Date.now(), people: [...this.people.values()] });
                }
                else if (name === 'events.json') {
                    this.write(name, { version: 1, updatedAt: Date.now(), events: this.events });
                }
                else {
                    this.write(name, { version: 1, updatedAt: Date.now(), items: this.surface });
                }
            }
            catch (error) {
                // 写失败就丢掉这批脏标记（下一次改动会重新标脏），不能让它无限重试。
                this.logger.warn('qq-groupmate: 群友档案落盘 %s 失败：%s', name, String(error));
            }
        }
    }
    write(name, value) {
        mkdirSync(dirname(this.file(name)), { recursive: true });
        const temp = `${this.file(name)}.tmp`;
        writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        renameSync(temp, this.file(name));
    }
    savePeople() {
        this.markDirty('people.json');
    }
    saveEvents() {
        this.markDirty('events.json');
    }
    saveSurface() {
        this.markDirty('surface.json');
    }
    /** 清洗一个人。 */
    sanitizePerson(raw) {
        if (raw === null || typeof raw !== 'object')
            return undefined;
        const item = raw;
        const userId = safeUserId(item.userId);
        if (userId === '')
            return undefined;
        const names = {};
        for (const [key, value] of Object.entries(item.names ?? {})) {
            if (BAD_KEYS.has(key))
                continue;
            if (!/^(?:\d{1,15}|private:\d{1,15})$/u.test(key))
                continue;
            names[key] = String(value).slice(0, 60);
        }
        const now = Date.now();
        const facts = [];
        for (const fact of item.facts ?? []) {
            const content = String(fact?.content ?? '').trim().slice(0, 300);
            if (content === '')
                continue;
            facts.push({
                id: String(fact.id ?? newFactId()),
                content,
                importance: clampInt(fact.importance ?? 3, 1, 5, 3),
                weight: clamp(Number(fact.weight ?? 1), 0, 1),
                pinned: fact.pinned === true,
                hits: Number(fact.hits ?? 0),
                createdAt: Number(fact.createdAt ?? now),
                updatedAt: Number(fact.updatedAt ?? now),
                lastTouchedAt: Number(fact.lastTouchedAt ?? now),
                sources: (fact.sources ?? [])
                    .filter(source => /^(?:\d{1,15}|private:\d{1,15})$/u.test(String(source?.chatKey ?? '')))
                    .slice(-12)
                    .map(source => ({ chatKey: String(source.chatKey), at: Number(source.at ?? now) })),
            });
        }
        return {
            userId,
            primaryName: String(item.primaryName ?? '').slice(0, 60),
            names,
            tags: (item.tags ?? []).map(tag => String(tag).slice(0, 20)).slice(0, 12),
            facts,
            firstSeenAt: Number(item.firstSeenAt ?? now),
            lastSeenAt: Number(item.lastSeenAt ?? now),
            updatedAt: Number(item.updatedAt ?? now),
            pinned: item.pinned === true,
        };
    }
    /** 清洗一条事件。 */
    sanitizeEvent(raw) {
        if (raw === null || typeof raw !== 'object')
            return undefined;
        const item = raw;
        const text = String(item.text ?? '').trim().slice(0, 300);
        if (text === '')
            return undefined;
        const scope = item.scope === 'global' ? 'global' : 'chat';
        const chatKey = String(item.chatKey ?? '');
        if (scope === 'chat' && safeChatKey(chatKey) === '')
            return undefined;
        const kind = EVENT_KINDS.find(value => value === item.kind) ?? 'event';
        const now = Date.now();
        return {
            id: String(item.id ?? newEventId()),
            text,
            kind,
            scope,
            chatKey: scope === 'global' ? '' : chatKey,
            participants: (item.participants ?? []).filter(user => safeUserId(user) !== '').slice(0, 20),
            importance: clampInt(item.importance ?? 3, 1, 5, 3),
            weight: clamp(Number(item.weight ?? 1), 0, 1),
            pinned: item.pinned === true,
            hits: Number(item.hits ?? 0),
            createdAt: Number(item.createdAt ?? now),
            updatedAt: Number(item.updatedAt ?? now),
            lastTouchedAt: Number(item.lastTouchedAt ?? now),
            lastMentionAt: Number(item.lastMentionAt ?? 0),
            expiresAt: Number(item.expiresAt ?? 0),
            resolved: item.resolved === true,
            origin: String(item.origin ?? ''),
        };
    }
    /** 配置里排除的会话（预计算成 Set，比对次数多）。 */
    get excluded() {
        return new Set(this.settings.crossGroupExclude.map(key => key.trim()).filter(key => key !== ''));
    }
    /**
     * 可见性闸门：来源会话 `srcChatKey` 的记忆，能不能在 `targetChatKey` 里用。
     * @returns true 表示可见。
     */
    visible(srcChatKey, targetChatKey, options = {}) {
        const src = safeChatKey(srcChatKey);
        const target = safeChatKey(targetChatKey);
        if (src === '' || target === '')
            return false;
        if (src === target)
            return true;
        if (!this.settings.crossGroupEnabled)
            return false;
        const excluded = this.excluded;
        if (excluded.has(src) || excluded.has(target))
            return false;
        // 私聊 → 群：单独一个开关（默认允许，群友私下交代的事可以在群里自然转达）。
        if (src.startsWith('private:') && !target.startsWith('private:')) {
            return options.surface === true ? this.settings.privateToGroup : this.settings.privateToGroup;
        }
        return true;
    }
    /**
     * 记一次「见过这个人」（每条群消息都可以调，内部很轻）。
     * @param userId - QQ 号。
     * @param options - 昵称、会话、时间。
     */
    touchPerson(userId, options = {}) {
        if (!this.settings.enabled)
            return undefined;
        const id = safeUserId(userId);
        if (id === '')
            return undefined;
        const now = options.at ?? Date.now();
        let person = this.people.get(id);
        if (person === undefined) {
            person = {
                userId: id,
                primaryName: '',
                names: {},
                tags: [],
                facts: [],
                firstSeenAt: now,
                lastSeenAt: now,
                updatedAt: now,
                pinned: false,
            };
            this.people.set(id, person);
        }
        const name = String(options.name ?? '').trim().slice(0, 60);
        if (name !== '') {
            person.primaryName = name;
            const chatKey = safeChatKey(options.chatKey);
            if (chatKey !== '' && !BAD_KEYS.has(chatKey))
                person.names[chatKey] = name;
        }
        person.lastSeenAt = Math.max(person.lastSeenAt, now);
        person.updatedAt = Math.max(person.updatedAt, now);
        this.savePeople();
        return person;
    }
    /** 取一个人（深拷贝，外面改不到内部状态）。 */
    getPerson(userId) {
        const person = this.people.get(safeUserId(userId));
        return person === undefined ? undefined : structuredClone(person);
    }
    /** 列出所有人的摘要。 */
    listPeople() {
        return [...this.people.values()].map(person => structuredClone(person));
    }
    /**
     * 记一条对某人的印象；内容重复时算「又提到了一次」（加权重、加重要度）。
     * @returns 是新建还是强化。
     */
    rememberFact(userId, content, options = {}) {
        if (!this.settings.enabled)
            return 'skipped';
        const text = String(content ?? '').trim().slice(0, 300);
        if (text === '')
            return 'skipped';
        const person = this.touchPerson(userId, options);
        if (person === undefined)
            return 'skipped';
        const now = options.at ?? Date.now();
        const key = normText(text);
        const hit = person.facts.find(fact => normText(fact.content) === key);
        if (hit !== undefined) {
            hit.weight = clamp(hit.weight + 0.25, 0, 1);
            hit.hits += 1;
            hit.updatedAt = now;
            hit.lastTouchedAt = now;
            hit.importance = Math.max(hit.importance, clampInt(options.importance ?? 3, 1, 5, 3));
            if (options.pinned === true)
                hit.pinned = true;
            const chatKey = safeChatKey(options.chatKey);
            if (chatKey !== '' && !hit.sources.some(source => source.chatKey === chatKey)) {
                hit.sources.push({ chatKey, at: now });
                hit.sources = hit.sources.slice(-12);
            }
            this.enforceFactCap(person);
            this.savePeople();
            return 'reinforced';
        }
        person.facts.push({
            id: newFactId(),
            content: text,
            importance: clampInt(options.importance ?? 3, 1, 5, 3),
            weight: 1,
            pinned: options.pinned === true,
            hits: 0,
            createdAt: now,
            updatedAt: now,
            lastTouchedAt: now,
            sources: safeChatKey(options.chatKey) === ''
                ? []
                : [{ chatKey: safeChatKey(options.chatKey), at: now }],
        });
        this.enforceFactCap(person);
        this.savePeople();
        return 'added';
    }
    /** 印象超上限时按「钉住的优先 + 综合分」淘汰。 */
    enforceFactCap(person) {
        const cap = Math.max(1, this.settings.maxFactsPerPerson);
        if (person.facts.length <= cap)
            return;
        const now = Date.now();
        person.facts = [...person.facts]
            .sort((a, b) => {
            if (a.pinned !== b.pinned)
                return a.pinned ? -1 : 1;
            const diff = scoreOf(b, now, this.settings.decayHalfLifeDays) - scoreOf(a, now, this.settings.decayHalfLifeDays);
            if (Math.abs(diff) > 1e-9)
                return diff;
            // 同分时新的优先：否则「刚学到的印象」会在满额时被立刻挤掉，
            // 档案会永远停在最早那批印象上。
            return (b.lastTouchedAt || b.createdAt) - (a.lastTouchedAt || a.createdAt);
        })
            .slice(0, cap);
    }
    /** 删一条印象（内容或 id 命中）。 */
    forgetFact(userId, target) {
        const person = this.people.get(safeUserId(userId));
        if (person === undefined)
            return false;
        const key = target.content === undefined ? '' : normText(target.content);
        const before = person.facts.length;
        person.facts = person.facts.filter((fact) => !(target.factId !== undefined && fact.id === target.factId)
            && !(key !== '' && normText(fact.content) === key));
        if (person.facts.length === before)
            return false;
        this.savePeople();
        return true;
    }
    /**
     * 同步某人在**本会话**的印象快照：`contents` 是「现在承认的全部印象」。
     * 1. 不再承认的：从 sources 里拿掉本会话；如果它只来自本会话就整条删掉；
     * 2. 新增/强化的：补 sources、加权重、取更高的重要度。
     *
     * 语义上「快照」很重要——模型每次看到的是完整印象列表，不这么写就会出现
     * 「模型已经不这么认为了，但旧印象还挂在档案里」。
     */
    syncChatFacts(userId, contents, options) {
        const result = { added: 0, reinforced: 0, removed: 0 };
        if (!this.settings.enabled)
            return result;
        const chatKey = safeChatKey(options.chatKey);
        if (chatKey === '')
            return result;
        const person = this.touchPerson(userId, options);
        if (person === undefined)
            return result;
        const now = options.at ?? Date.now();
        const wanted = new Map();
        for (const raw of contents) {
            const text = String(raw ?? '').trim().slice(0, 300);
            if (text === '')
                continue;
            wanted.set(normText(text), text);
        }
        // ① 收回事
        const kept = [];
        for (const fact of person.facts) {
            const key = normText(fact.content);
            if (wanted.has(key)) {
                kept.push(fact);
                continue;
            }
            const hasThis = fact.sources.some(source => source.chatKey === chatKey);
            if (!hasThis) {
                kept.push(fact);
                continue;
            }
            const sources = fact.sources.filter(source => source.chatKey !== chatKey);
            // 只来自本会话的印象：这条不再被承认就等于没有了，整条删掉。
            if (sources.length === 0) {
                result.removed += 1;
                continue;
            }
            fact.sources = sources;
            kept.push(fact);
        }
        person.facts = kept;
        // ② 新增/强化
        for (const [key, text] of wanted) {
            const hit = person.facts.find(fact => normText(fact.content) === key);
            if (hit !== undefined) {
                hit.weight = clamp(hit.weight + 0.25, 0, 1);
                hit.hits += 1;
                hit.updatedAt = now;
                hit.lastTouchedAt = now;
                hit.importance = Math.max(hit.importance, clampInt(options.importance ?? 3, 1, 5, 3));
                if (!hit.sources.some(source => source.chatKey === chatKey))
                    hit.sources.push({ chatKey, at: now });
                hit.sources = hit.sources.slice(-12);
                result.reinforced += 1;
                continue;
            }
            person.facts.push({
                id: newFactId(),
                content: text,
                importance: clampInt(options.importance ?? 3, 1, 5, 3),
                weight: 1,
                pinned: false,
                hits: 0,
                createdAt: now,
                updatedAt: now,
                lastTouchedAt: now,
                sources: [{ chatKey, at: now }],
            });
            result.added += 1;
        }
        this.enforceFactCap(person);
        this.savePeople();
        return result;
    }
    /**
     * 记一条长期事件（约定 / 梗 / 恩怨 / 稳定偏好）。同 scope+会话里内容重复算「又提到」。
     * @returns 事件 id；开关关着返回空串。
     */
    noteEvent(input) {
        if (!this.settings.enabled)
            return '';
        const text = String(input.text ?? '').trim().slice(0, 300);
        if (text === '')
            return '';
        const scope = input.scope === 'global' ? 'global' : 'chat';
        const chatKey = safeChatKey(input.chatKey);
        if (scope === 'chat' && chatKey === '')
            return '';
        const now = input.at ?? Date.now();
        const key = normText(text);
        const hit = this.events.find(event => event.scope === scope
            && (scope === 'global' || event.chatKey === chatKey)
            && normText(event.text) === key);
        if (hit !== undefined) {
            hit.weight = clamp(hit.weight + 0.25, 0, 1);
            hit.hits += 1;
            hit.updatedAt = now;
            hit.lastTouchedAt = now;
            hit.lastMentionAt = now;
            hit.importance = Math.max(hit.importance, clampInt(input.importance ?? 3, 1, 5, 3));
            hit.resolved = false;
            for (const user of input.participants ?? []) {
                const id = safeUserId(user);
                if (id !== '' && !hit.participants.includes(id) && hit.participants.length < 20)
                    hit.participants.push(id);
            }
            this.enforceEventCaps();
            this.saveEvents();
            return hit.id;
        }
        const event = {
            id: newEventId(),
            text,
            kind: EVENT_KINDS.find(value => value === input.kind) ?? 'event',
            scope,
            chatKey: scope === 'global' ? '' : chatKey,
            participants: (input.participants ?? []).map(user => safeUserId(user)).filter(user => user !== '').slice(0, 20),
            importance: clampInt(input.importance ?? 3, 1, 5, 3),
            weight: 1,
            pinned: input.pinned === true,
            hits: 0,
            createdAt: now,
            updatedAt: now,
            lastTouchedAt: now,
            lastMentionAt: now,
            expiresAt: Number(input.expiresAt ?? 0),
            resolved: false,
            origin: scope === 'global' ? chatKey : '',
        };
        this.events.push(event);
        // 事件里提到的人顺手建档，这样「这人在别的群聊过」才串得起来。
        for (const user of event.participants)
            this.touchPerson(user, { chatKey });
        this.enforceEventCaps();
        this.saveEvents();
        return event.id;
    }
    /** 事件超上限时按会话分桶淘汰（global 单独一桶）。 */
    enforceEventCaps() {
        const now = Date.now();
        const perChat = new Map();
        for (const event of this.events) {
            const key = event.scope === 'global' ? '__global__' : event.chatKey;
            const bucket = perChat.get(key);
            if (bucket === undefined)
                perChat.set(key, [event]);
            else
                bucket.push(event);
        }
        const keep = new Set();
        for (const [key, bucket] of perChat) {
            const cap = key === '__global__'
                ? Math.max(20, this.settings.maxEventsTotal)
                : Math.max(10, this.settings.maxEventsPerChat);
            const sorted = [...bucket].sort((a, b) => {
                if (a.pinned !== b.pinned)
                    return a.pinned ? -1 : 1;
                return scoreOf(b, now, this.settings.decayHalfLifeDays) - scoreOf(a, now, this.settings.decayHalfLifeDays);
            });
            for (const event of sorted.slice(0, cap))
                keep.add(event.id);
        }
        let result = this.events.filter(event => keep.has(event.id));
        const total = Math.max(20, this.settings.maxEventsTotal);
        if (result.length > total) {
            result = [...result]
                .sort((a, b) => {
                if (a.pinned !== b.pinned)
                    return a.pinned ? -1 : 1;
                return scoreOf(b, now, this.settings.decayHalfLifeDays) - scoreOf(a, now, this.settings.decayHalfLifeDays);
            })
                .slice(0, total);
        }
        this.events = result;
    }
    /** 查事件（按综合分降序，走可见性闸门）。 */
    listEvents(options = {}) {
        const now = options.now ?? Date.now();
        const chatKey = safeChatKey(options.chatKey);
        const result = this.events.filter((event) => {
            if (!options.includeExpired && event.expiresAt > 0 && now > event.expiresAt)
                return false;
            if (options.scope !== undefined && event.scope !== options.scope)
                return false;
            if (options.kinds !== undefined && options.kinds.length > 0 && !options.kinds.includes(event.kind))
                return false;
            if (options.userId !== undefined && options.userId !== '' && !event.participants.includes(safeUserId(options.userId)))
                return false;
            if (event.scope === 'chat') {
                if (chatKey === '')
                    return false;
                if (event.chatKey !== chatKey && !this.visible(event.chatKey, chatKey))
                    return false;
            }
            else if (!this.visible(event.origin, chatKey))
                return false;
            return true;
        });
        const sorted = [...result].sort((a, b) => scoreOf(b, now, this.settings.decayHalfLifeDays) - scoreOf(a, now, this.settings.decayHalfLifeDays));
        return options.limit === undefined ? sorted : sorted.slice(0, Math.max(1, options.limit));
    }
    /** 标记一条事件已翻篇。 */
    resolveEvent(eventId, now = Date.now()) {
        const event = this.events.find(item => item.id === eventId);
        if (event === undefined)
            return false;
        event.resolved = true;
        event.updatedAt = now;
        this.saveEvents();
        return true;
    }
    /** 删一条事件。 */
    forgetEvent(eventId) {
        const before = this.events.length;
        this.events = this.events.filter(event => event.id !== eventId);
        if (this.events.length === before)
            return false;
        this.saveEvents();
        return true;
    }
    /**
     * 记一句「刚在别处说的话」（表层记忆）。内容重复时「置顶变新」，不堆条。
     */
    addSurface(input) {
        if (!this.settings.enabled || !this.settings.surfaceEnabled)
            return;
        const userId = safeUserId(input.userId);
        const chatKey = safeChatKey(input.chatKey);
        const text = String(input.text ?? '').trim().slice(0, 500);
        if (userId === '' || chatKey === '' || text === '')
            return;
        this.ensureSurface();
        const now = input.at ?? Date.now();
        const key = normText(text);
        const hit = this.surface.find(item => item.userId === userId && normText(item.text) === key);
        if (hit !== undefined) {
            hit.at = now;
            hit.expiresAt = now + Math.max(60_000, this.settings.surfaceTtlMs);
            hit.chatKey = chatKey;
            if (input.name !== undefined && input.name.trim() !== '')
                hit.name = input.name.trim().slice(0, 60);
        }
        else {
            this.surface.push({
                id: newSurfaceId(),
                userId,
                name: String(input.name ?? '').trim().slice(0, 60),
                chatKey,
                text,
                at: now,
                expiresAt: now + Math.max(60_000, this.settings.surfaceTtlMs),
                promotedAt: 0,
            });
        }
        // 每人限量：超了丢最旧的。
        const mine = this.surface.filter(item => item.userId === userId).sort((a, b) => b.at - a.at);
        const cap = Math.max(1, this.settings.surfaceMaxPerPerson);
        if (mine.length > cap) {
            const drop = new Set(mine.slice(cap).map(item => item.id));
            this.surface = this.surface.filter(item => !drop.has(item.id));
        }
        this.pruneSurface(now);
        this.saveSurface();
    }
    /** 清掉过期的表层记忆。 */
    pruneSurface(now = Date.now()) {
        this.ensureSurface();
        const before = this.surface.length;
        this.surface = this.surface.filter(item => item.expiresAt > now);
        return before - this.surface.length;
    }
    /** 列出某人在别处的表层记忆（过可见性闸门）。 */
    listSurface(options) {
        if (!this.settings.surfaceEnabled)
            return [];
        this.ensureSurface();
        const now = options.now ?? Date.now();
        const chatKey = safeChatKey(options.chatKey);
        const userId = options.userId === undefined ? '' : safeUserId(options.userId);
        const result = this.surface.filter((item) => {
            if (item.expiresAt <= now)
                return false;
            if (userId !== '' && item.userId !== userId)
                return false;
            if (options.otherChatsOnly === true && item.chatKey === chatKey)
                return false;
            return this.visible(item.chatKey, chatKey, { surface: true });
        });
        const sorted = [...result].sort((a, b) => b.at - a.at);
        return options.limit === undefined ? sorted : sorted.slice(0, Math.max(1, options.limit));
    }
    /**
     * 把一条表层记忆升级成长期记忆（「这事值得记着」）。
     * @param as - `fact` 记成对这个人的印象；`event` 记成长期事件。
     */
    promoteSurface(id, options = {}) {
        this.ensureSurface();
        const item = this.surface.find(entry => entry.id === id);
        if (item === undefined)
            return false;
        const now = options.now ?? Date.now();
        if (options.as === 'fact') {
            this.rememberFact(item.userId, item.text, {
                ...(item.name === '' ? {} : { name: item.name }),
                chatKey: item.chatKey,
                at: now,
                ...(options.importance === undefined ? {} : { importance: options.importance }),
            });
        }
        else {
            // 私聊来源升级成跨会话事件，别的群里也能接上。
            const isPrivate = item.chatKey.startsWith('private:');
            this.noteEvent({
                text: item.text,
                ...(options.kind === undefined ? {} : { kind: options.kind }),
                scope: isPrivate ? 'global' : 'chat',
                chatKey: item.chatKey,
                participants: [item.userId],
                at: now,
                ...(options.importance === undefined ? {} : { importance: options.importance }),
            });
        }
        item.promotedAt = now;
        this.surface = this.surface.filter(entry => entry.id !== id);
        this.saveSurface();
        return true;
    }
    /** 统一检索：跨群记忆 + 长期事件（给「回忆一下」用）。 */
    search(options) {
        const now = options.now ?? Date.now();
        const tokens = tokenize(options.query);
        const chatKey = safeChatKey(options.chatKey);
        const limit = Math.max(1, options.limit ?? 12);
        const since = options.days === undefined || options.days <= 0 ? 0 : now - options.days * DAY_MS;
        const people = [];
        for (const person of this.people.values()) {
            if (options.userId !== undefined && options.userId !== '' && person.userId !== safeUserId(options.userId))
                continue;
            // 印象的可见性：没有 source 的算公共；有 source 的必须至少一个可见。
            const facts = person.facts.filter(fact => chatKey === ''
                || fact.sources.length === 0
                || fact.sources.some(source => this.visible(source.chatKey, chatKey)));
            if (facts.length === 0)
                continue;
            const hay = [
                // QQ 号也进检索池：直接拿号码当查询词时能命中（`[查档案:10001]`）。
                person.userId,
                person.primaryName,
                ...Object.values(person.names),
                ...person.tags,
                ...facts.map(fact => fact.content),
            ].join(' ');
            const score = matchScore(tokens, hay);
            if (tokens.length > 0 && score <= 0)
                continue;
            const relevance = Math.max(0, ...facts.map(fact => scoreOf(fact, now, this.settings.decayHalfLifeDays)));
            const total = tokens.length > 0 ? score * 0.7 + relevance * 0.3 : relevance;
            if (total <= 0)
                continue;
            const top = [...facts]
                .sort((a, b) => (b.weight * b.importance) - (a.weight * a.importance))
                .slice(0, 8)
                .map(fact => ({
                content: fact.content,
                source: fact.sources.length === 0 ? '本群' : chatLabel(fact.sources[fact.sources.length - 1].chatKey),
            }));
            people.push({ userId: person.userId, name: person.primaryName, facts: top });
        }
        const events = [];
        for (const event of this.events) {
            if (event.resolved)
                continue;
            if (event.expiresAt > 0 && now > event.expiresAt)
                continue;
            if (options.kinds !== undefined && options.kinds.length > 0 && !options.kinds.includes(event.kind))
                continue;
            if (since > 0 && event.createdAt < since)
                continue;
            if (options.userId !== undefined && options.userId !== ''
                && !event.participants.includes(safeUserId(options.userId)))
                continue;
            if (event.scope === 'chat') {
                if (chatKey === '' && event.chatKey === '')
                    continue;
                if (chatKey !== '' && event.chatKey !== chatKey && !this.visible(event.chatKey, chatKey))
                    continue;
            }
            else if (chatKey !== '' && !this.visible(event.origin, chatKey))
                continue;
            const relevance = scoreOf(event, now, this.settings.decayHalfLifeDays);
            const score = matchScore(tokens, event.text);
            if (tokens.length > 0 && score <= 0)
                continue;
            const total = tokens.length > 0 ? score * 0.7 + relevance * 0.3 : relevance;
            if (total <= 0)
                continue;
            events.push({
                text: event.text,
                kind: event.kind,
                from: event.scope === 'global' ? `跨群（来自 ${chatLabel(event.origin)}）` : chatLabel(event.chatKey),
            });
        }
        return { query: String(options.query ?? ''), people: people.slice(0, limit), events: events.slice(0, limit) };
    }
    /**
     * 组装提示词要注入的三段：表层记忆 + 跨群档案 + 长期记忆。
     *
     * 跨群档案只放「在别的会话也学过」的印象——同一句话在本群已经知道的，
     * 不必再以「档案」的口吻说一遍。
     */
    formatForPrompt(chatKey, options = {}) {
        const empty = { surface: '', archive: '' };
        if (!this.settings.enabled)
            return empty;
        const key = safeChatKey(chatKey);
        if (key === '')
            return empty;
        const now = options.now ?? Date.now();
        const budget = Math.max(300, options.maxChars ?? this.settings.maxChars);
        return {
            surface: this.renderSurface(key, budget, now, options.userIds),
            archive: this.renderArchive(key, budget, now, options.userIds),
        };
    }
    /** 【刚刚在别处提到】一节。 */
    renderSurface(chatKey, budget, now, userIds) {
        if (!this.settings.surfaceEnabled || this.settings.surfaceMaxInject <= 0)
            return '';
        const wanted = (userIds ?? []).map(user => safeUserId(user)).filter(user => user !== '');
        const candidates = wanted.length === 0
            ? this.listSurface({ chatKey, otherChatsOnly: true, now })
            : wanted.flatMap(user => this.listSurface({ userId: user, chatKey, otherChatsOnly: true, now }));
        if (candidates.length === 0)
            return '';
        const picked = [...candidates].sort((a, b) => b.at - a.at).slice(0, this.settings.surfaceMaxInject);
        const head = '【刚刚在别处提到】下面几句是不久前在别的会话（可能是私聊）里说的。'
            + '如果是这次相关的人或事，可以自然接上；不相关就当没看见，别硬提：';
        const lines = [];
        let used = head.length;
        for (const item of picked) {
            const who = item.name === '' ? `QQ ${item.userId}` : `${item.name}（QQ ${item.userId}）`;
            const line = `- ${who}在${chatLabel(item.chatKey)}${formatAgo(item.at, now)}说：「${item.text}」`;
            if (used + line.length > budget)
                break;
            lines.push(line);
            used += line.length;
        }
        return lines.length === 0 ? '' : `${head}\n${lines.join('\n')}`;
    }
    /** 【跨群档案】+【长期记忆】两节。 */
    renderArchive(chatKey, budget, now, userIds) {
        const base = Math.max(30, this.settings.decayHalfLifeDays);
        const parts = [];
        let used = 0;
        // ① 跨群档案：只看「在别的会话也学过」的印象。
        const wanted = (userIds ?? []).map(user => safeUserId(user)).filter(user => user !== '');
        const candidates = [];
        for (const person of this.people.values()) {
            if (wanted.length > 0 && !wanted.includes(person.userId))
                continue;
            const crossFacts = person.facts.filter(fact => fact.sources.some(source => source.chatKey !== chatKey && this.visible(source.chatKey, chatKey)));
            if (crossFacts.length === 0)
                continue;
            candidates.push({ person, facts: crossFacts });
        }
        candidates.sort((a, b) => Math.max(...b.facts.map(fact => scoreOf(fact, now, base)))
            - Math.max(...a.facts.map(fact => scoreOf(fact, now, base))));
        const pickedPeople = candidates.slice(0, Math.max(0, this.settings.peopleMaxInject));
        if (pickedPeople.length > 0) {
            const head = '【跨群档案】同一个 QQ 号在不同群里是同一个人。下面这些人你以前在别的会话接触过，别当成陌生人：';
            const lines = [];
            for (const { person, facts } of pickedPeople) {
                const localName = person.names[chatKey];
                const others = [...new Set(facts
                        .flatMap(fact => fact.sources.map(source => source.chatKey))
                        .filter(source => source !== chatKey))]
                    .map(chatLabel);
                const bits = [
                    `- ${person.primaryName === '' ? `QQ ${person.userId}` : `${person.primaryName}（QQ ${person.userId}）`}`,
                    ...(localName === undefined ? [] : [`，本群叫「${localName}」`]),
                    ...(others.length === 0 ? [] : [`；另见于 ${others.join('、')}`]),
                ];
                const top = [...facts]
                    .sort((a, b) => scoreOf(b, now, base) - scoreOf(a, now, base))
                    .slice(0, Math.max(1, this.settings.factsPerPersonInject));
                const line = [bits.join(''), ...top.map(fact => `\n  · ${fact.content}`)].join('');
                if (used + line.length > budget)
                    break;
                lines.push(line);
                used += line.length;
            }
            if (lines.length > 0)
                parts.push(`${head}\n${lines.join('\n')}`);
        }
        // ② 长期记忆：本会话的事件 + 可见的跨群事件。
        const events = this.listEvents({ chatKey, includeExpired: false, now })
            .filter(event => event.scope === 'chat' || event.origin !== chatKey)
            .slice(0, Math.max(0, this.settings.eventsMaxInject));
        if (events.length > 0) {
            const head = '【长期记忆】长期有效的事（不是临时闲聊，可以自然引用，别当成刚发生）：';
            const labels = {
                event: '事件', topic: '话题', promise: '约定', joke: '梗', grudge: '恩怨', preference: '偏好',
            };
            const lines = [];
            for (const event of events) {
                const who = event.participants.length === 0 ? '' : `；涉及 ${event.participants.join('、')}`;
                const line = `- [${labels[event.kind]}] ${event.text}（${formatAgo(event.lastMentionAt || event.createdAt, now)}${who}）`;
                if (used + line.length > budget)
                    break;
                lines.push(line);
                used += line.length;
            }
            if (lines.length > 0)
                parts.push(`${head}\n${lines.join('\n')}`);
        }
        return parts.join('\n\n');
    }
    /**
     * 遗忘维护：淘汰弱到不值得留的印象与事件（`dryRun` 只看不动）。
     * 过期的事件、只留了个名字却很久没出现的档案一并清掉。
     */
    decay(options = {}) {
        const now = options.now ?? Date.now();
        const dryRun = options.dryRun === true;
        const base = Math.max(1, this.settings.decayHalfLifeDays);
        const keepImportance = clampInt(this.settings.keepImportance, 1, 5, 4);
        const minAge = Math.max(0, this.settings.decayMinAgeDays);
        const minWeight = clamp(this.settings.decayMinWeight, 0, 1);
        const factAlive = (fact) => {
            if (fact.pinned)
                return true;
            if (fact.importance >= keepImportance)
                return true;
            if ((now - (fact.lastTouchedAt || fact.createdAt)) / DAY_MS < minAge)
                return true;
            return effectiveWeight(fact, now, base) >= minWeight;
        };
        const eventAlive = (event) => {
            if (event.pinned)
                return true;
            if (event.expiresAt > 0 && now > event.expiresAt)
                return false;
            if (event.importance >= keepImportance)
                return true;
            if ((now - (event.lastTouchedAt || event.createdAt)) / DAY_MS < minAge)
                return true;
            return effectiveWeight(event, now, base) >= minWeight;
        };
        let facts = 0;
        let events = 0;
        let peopleRemoved = 0;
        let surface = 0;
        for (const [userId, person] of this.people) {
            const kept = person.facts.filter(factAlive);
            facts += person.facts.length - kept.length;
            if (!dryRun)
                person.facts = kept;
            // 没有任何印象、没有名字、很久没出现的空档案直接删掉。
            const stale = Object.keys(person.names).length === 0 && person.primaryName === '';
            if (stale && (now - person.lastSeenAt) / DAY_MS > Math.max(30, minAge * 4) && person.facts.length === 0) {
                peopleRemoved += 1;
                if (!dryRun)
                    this.people.delete(userId);
            }
        }
        const keptEvents = this.events.filter(eventAlive);
        events = this.events.length - keptEvents.length;
        if (!dryRun) {
            this.events = keptEvents;
            this.lastDecayAt = now;
            surface = this.pruneSurface(now);
            this.savePeople();
            this.saveEvents();
            this.saveSurface();
            // 维护任务是低频的，直接落盘（不然要等到下一次防抖窗口才写）。
            this.flush();
        }
        return { facts, events, peopleRemoved, surface, dryRun };
    }
    /** 统计。 */
    stats(now = Date.now()) {
        this.ensureSurface();
        const facts = [...this.people.values()].flatMap(person => person.facts);
        const chats = new Set();
        for (const person of this.people.values()) {
            for (const key of Object.keys(person.names))
                chats.add(key);
            for (const fact of person.facts)
                for (const source of fact.sources)
                    chats.add(source.chatKey);
        }
        return {
            people: this.people.size,
            facts: facts.length,
            events: this.events.length,
            surface: this.surface.filter(item => item.expiresAt > now).length,
            chats: chats.size,
            lastDecayAt: this.lastDecayAt,
            weakestWeight: facts.length === 0
                ? 0
                : Math.min(...facts.map(fact => effectiveWeight(fact, now, Math.max(1, this.settings.decayHalfLifeDays)))),
        };
    }
}
/** 生成 fact id。 */
function newFactId() {
    return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
/** 生成 event id。 */
function newEventId() {
    return `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
/** 生成 surface id。 */
function newSurfaceId() {
    return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
