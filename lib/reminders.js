/**
 * 定时提醒：群友说「明天九点提醒我交作业」「半小时后提醒我关火」，到点机器人主动开口。
 *
 * 关键设计（都是踩过的坑，移植自 QQ-Agent 的 reminders）：
 * - **迟到补偿**：dsh 关掉了、电脑睡了，到点的提醒不会凭空消失——启动后扫一遍，
 *   在 `catchUpMinutes` 窗口内的补发（并把「迟到」这件事自然地说出来），超窗口的标记 missed。
 * - **先占位再执行**：`claim` 把 pending 改成 running 并**立刻落盘**，跑完才 `markFired`。
 *   这样执行到一半重启，下次启动看到 running 会当僵尸回收重试，而不是当成功丢掉。
 * - **相对时间的单位要认全**：「半小时后」「3 天后」「2h」都得解，中文「后/之后/以后」可有可无。
 * - **周期提醒的基准取 max(实际触发时间, 原定时间)**：不然每次晚几秒，天天累积着漂。
 *
 * 时间是**本地时区**的自然语言时间（「明天 9 点」= 本机时区的 9 点）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeChatKey, safeUserId } from "./history.js";
/** 一天毫秒数。 */
const DAY_MS = 86_400_000;
/** 重复提醒的最小间隔（防「每分钟提醒」这种刷屏配置）。 */
const MIN_INTERVAL_MS = 60_000;
/** 执行中超过这么久没结束，当僵尸回收重试。 */
const STALE_RUNNING_MS = 300_000;
/** 提醒正文长度上限。 */
export const MAX_REMINDER_TEXT = 300;
/** 备注长度上限。 */
export const MAX_REMINDER_NOTE = 200;
/** 提醒设置的默认值。 */
export function defaultReminderSettings() {
    return {
        enabled: true,
        minDelaySec: 30,
        catchUpMinutes: 720,
        maxPending: 200,
        maxPendingPerChat: 20,
        maxPerDay: 20,
        ttlDays: 400,
    };
}
// 会话键与 QQ 号的校验放在 history.ts（档案 / 提醒 / 命令共用同一套判定），
// 这里再导出一次，好让外部照旧从本模块取。
export { safeChatKey, safeUserId } from "./history.js";
/** 时间戳 → `HH:MM`；非法返回空串。 */
export function formatClock(ts) {
    if (!Number.isFinite(ts) || ts <= 0)
        return '';
    const date = new Date(ts);
    const pad = (value) => (value < 10 ? `0${String(value)}` : String(value));
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** ISO 星期（1=周一 … 7=周日）。 */
export function isoWeekday(ts) {
    const day = new Date(ts).getDay();
    return day === 0 ? 7 : day;
}
/**
 * 解析自然语言时间。优先级：纯时间戳 → 日期（可带时刻）→ 纯时刻 → 相对时间。
 * @param input - 用户/模型给的时间描述。
 * @param now - 当前时间（测试注入）。
 * @returns 解析结果；`ok=false` 时 `error` 是中文原因。
 */
export function parseWhen(input, now = Date.now()) {
    const text = String(input ?? '').trim();
    if (text === '')
        return { ok: false, at: 0, error: '没说时间' };
    // 1) 纯时间戳（秒或毫秒都当毫秒处理：>=10 位）
    if (/^\d{10,}$/u.test(text)) {
        const at = Number(text);
        if (at <= now)
            return { ok: false, at: 0, error: '时间已经过去了' };
        return { ok: true, at, error: '' };
    }
    // 2) 相对时间（放在日期之前：`3天后` 里的数字别被日期分支抢走）
    const relative = /^\+?\s*(\d+(?:\.\d+)?)\s*(s|sec|秒|m|min|分钟|分|h|hour|小时|时|d|day|天)\s*(?:后|之后|以后|內|内)?$/iu.exec(text);
    if (relative !== null) {
        const amount = Number(relative[1]);
        const unit = (relative[2] ?? '').toLowerCase();
        const multiplier = unit === 's' || unit === 'sec' || unit === '秒'
            ? 1000
            : unit === 'm' || unit === 'min' || unit === '分钟' || unit === '分'
                ? 60_000
                : unit === 'h' || unit === 'hour' || unit === '小时' || unit === '时'
                    ? 3_600_000
                    : DAY_MS;
        if (!Number.isFinite(amount) || amount <= 0)
            return { ok: false, at: 0, error: '时间间隔要大于 0' };
        return { ok: true, at: now + amount * multiplier, error: '' };
    }
    // 3) 日期（可带时刻；不带时刻默认当天 09:00）
    const dateMatch = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/u.exec(text);
    if (dateMatch !== null) {
        const year = Number(dateMatch[1]);
        const month = Number(dateMatch[2]);
        const day = Number(dateMatch[3]);
        const hasTime = dateMatch[4] !== undefined;
        const hour = hasTime ? Number(dateMatch[4]) : 9;
        const minute = hasTime ? Number(dateMatch[5]) : 0;
        const second = dateMatch[6] === undefined ? 0 : Number(dateMatch[6]);
        if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
            return { ok: false, at: 0, error: '日期或时刻不合法' };
        }
        const at = new Date(year, month - 1, day, hour, minute, second, 0).getTime();
        if (!Number.isFinite(at))
            return { ok: false, at: 0, error: '日期不合法' };
        if (at <= now)
            return { ok: false, at: 0, error: '时间已经过去了' };
        return { ok: true, at, error: '' };
    }
    // 4) 纯时刻：今天这个点；已经过了就顺延到明天
    const clockMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(text);
    if (clockMatch !== null) {
        const hour = Number(clockMatch[1]);
        const minute = Number(clockMatch[2]);
        const second = clockMatch[3] === undefined ? 0 : Number(clockMatch[3]);
        if (hour > 23 || minute > 59)
            return { ok: false, at: 0, error: '时刻不合法' };
        const base = new Date(now);
        const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, second, 0).getTime();
        return { ok: true, at: at > now ? at : at + DAY_MS, error: '' };
    }
    return { ok: false, at: 0, error: `看不懂这个时间：「${text}」（可以写「9:30」「明天 9 点」不认，请写 2026-09-16 09:00、09:30、+30m、3天后）` };
}
/**
 * 算下一次到期时间。
 * @param reminder - 提醒条目。
 * @param from - 从这个时间往后算。
 * @returns 下一次到期毫秒；不再重复返回 0。
 */
export function nextDueAt(reminder, from = Date.now()) {
    const repeat = reminder.repeat ?? { kind: 'none' };
    if (repeat.kind === 'none')
        return 0;
    if (repeat.kind === 'interval') {
        return from + Math.max(MIN_INTERVAL_MS, repeat.intervalMs ?? 0);
    }
    const source = new Date(reminder.dueAt);
    const hour = source.getHours();
    const minute = source.getMinutes();
    const at = (dayOffset) => new Date(new Date(from).getFullYear(), new Date(from).getMonth(), new Date(from).getDate() + dayOffset, hour, minute, 0, 0).getTime();
    if (repeat.kind === 'daily') {
        const today = at(0);
        return today > from ? today : at(1);
    }
    // weekly
    const wanted = (repeat.weekdays ?? []).map(day => clampInt(day, 1, 7, 1));
    const list = wanted.length > 0 ? [...new Set(wanted)] : [isoWeekday(reminder.dueAt)];
    for (let offset = 0; offset <= 8; offset += 1) {
        const candidate = at(offset);
        if (candidate > from && list.includes(isoWeekday(candidate)))
            return candidate;
    }
    return 0;
}
/** 归一化重复规则。 */
export function normalizeRepeat(raw, dueAt) {
    if (raw === null || typeof raw !== 'object')
        return { kind: 'none' };
    const value = raw;
    const kind = String(value.kind ?? '').toLowerCase();
    if (kind === 'daily')
        return { kind: 'daily' };
    if (kind === 'weekly') {
        const weekdays = Array.isArray(value.weekdays)
            ? [...new Set(value.weekdays.map(day => clampInt(day, 1, 7, 1)))]
            : [];
        return { kind: 'weekly', weekdays: weekdays.length > 0 ? weekdays : [isoWeekday(dueAt)] };
    }
    if (kind === 'interval') {
        const unit = String(value.unit ?? '').toLowerCase();
        const every = Number(value.every);
        const multiplier = unit === 's' ? 1000 : unit === 'h' ? 3_600_000 : unit === 'd' ? DAY_MS : 60_000;
        const intervalMs = Number.isFinite(every) && every > 0 ? every * multiplier : Number(value.intervalMs ?? 0);
        return { kind: 'interval', intervalMs: Math.max(MIN_INTERVAL_MS, intervalMs) };
    }
    return { kind: 'none' };
}
/** 重复规则的中文描述。 */
export function repeatLabel(repeat) {
    if (repeat === undefined || repeat.kind === 'none')
        return '不重复';
    if (repeat.kind === 'daily')
        return '每天';
    if (repeat.kind === 'weekly') {
        const names = ['一', '二', '三', '四', '五', '六', '日'];
        return `每周${(repeat.weekdays ?? []).map(day => names[day - 1] ?? String(day)).join('、')}`;
    }
    const minutes = Math.round((repeat.intervalMs ?? 0) / 60_000);
    return minutes >= 60 * 24 ? `每 ${String(Math.round(minutes / (60 * 24)))} 天` : `每 ${String(minutes)} 分钟`;
}
/** 一条提醒的人话描述。 */
export function describeReminder(item, now = Date.now()) {
    const clock = formatClock(item.dueAt);
    const date = new Date(item.dueAt);
    const dayLabel = new Date(now).toDateString() === date.toDateString()
        ? '今天'
        : new Date(now + DAY_MS).toDateString() === date.toDateString() ? '明天' : `${String(date.getMonth() + 1)}月${String(date.getDate())}日`;
    const who = item.targetUserId === '' ? '' : ` @${item.targetName === '' ? item.targetUserId : item.targetName}`;
    const late = item.notifiedAt > 0 ? '（补发）' : '';
    return `${dayLabel} ${clock}${who}：${item.text}${late}`;
}
/** 给模型看的剩余时间描述。 */
export function describeAgo(at, now = Date.now()) {
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
/** 夹取整数。 */
function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num))
        return fallback;
    return Math.min(max, Math.max(min, Math.trunc(num)));
}
/** 创建失败时抛的错误（中文文案直接给群友看）。 */
export class ReminderError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReminderError';
    }
}
/** 提醒仓库：读写状态文件，管生命周期与限额。 */
export class ReminderStore {
    settings;
    logger;
    file;
    items = [];
    loaded = false;
    constructor(options) {
        this.file = options.file;
        this.settings = options.settings;
        this.logger = options.logger;
        this.load();
    }
    /** 从磁盘加载；文件缺失/损坏时当空库（不抛错，免得插件起不来）。 */
    load() {
        this.loaded = true;
        this.items = [];
        if (!existsSync(this.file))
            return;
        try {
            const raw = JSON.parse(readFileSync(this.file, 'utf8'));
            const list = Array.isArray(raw) ? raw : (raw.items ?? []);
            for (const item of list) {
                const clean = this.sanitize(item);
                if (clean !== undefined)
                    this.items.push(clean);
            }
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 提醒状态文件损坏，已当空库处理：%s', String(error));
        }
    }
    /** 落盘（同步；提醒是低频操作，不值得为它加防抖复杂度）。 */
    save() {
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            const payload = { version: 1, updatedAt: Date.now(), items: this.items };
            writeFileSync(this.file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 提醒状态写入失败：%s', String(error));
        }
    }
    /** 规范化一条记录；关键字段不合法就丢弃。 */
    sanitize(raw) {
        if (raw === null || typeof raw !== 'object')
            return undefined;
        const item = raw;
        const text = String(item.text ?? '').trim().slice(0, MAX_REMINDER_TEXT);
        const chatKey = safeChatKey(item.chatKey);
        const dueAt = Number(item.dueAt);
        if (text === '' || chatKey === '' || !Number.isFinite(dueAt) || dueAt <= 0)
            return undefined;
        const status = ['pending', 'running', 'done', 'canceled', 'missed']
            .find(value => value === item.status) ?? 'pending';
        return {
            id: String(item.id ?? newId()),
            text,
            note: String(item.note ?? '').trim().slice(0, MAX_REMINDER_NOTE),
            dueAt,
            chatKey,
            targetUserId: safeUserId(item.targetUserId),
            targetName: String(item.targetName ?? '').trim().slice(0, 60),
            creatorId: safeUserId(item.creatorId),
            creatorName: String(item.creatorName ?? '').trim().slice(0, 60),
            repeat: normalizeRepeat(item.repeat, dueAt),
            importance: clampInt(item.importance ?? 3, 1, 5, 3),
            status,
            createdAt: Number(item.createdAt ?? Date.now()),
            updatedAt: Number(item.updatedAt ?? Date.now()),
            firedAt: Number(item.firedAt ?? 0),
            firedCount: Number(item.firedCount ?? 0),
            retries: Number(item.retries ?? 0),
            lastError: String(item.lastError ?? '').slice(0, 200),
            notifiedAt: Number(item.notifiedAt ?? 0),
        };
    }
    /** 列出提醒（按到期时间升序）。 */
    list(options = {}) {
        const statuses = (options.status ?? '').split(',').map(value => value.trim()).filter(value => value !== '');
        let result = this.items.filter((item) => {
            if (options.chatKey !== undefined && options.chatKey !== '' && item.chatKey !== options.chatKey)
                return false;
            if (statuses.length > 0 && !statuses.includes(item.status))
                return false;
            return true;
        });
        result = [...result].sort((a, b) => a.dueAt - b.dueAt);
        return options.limit === undefined ? result : result.slice(0, Math.max(1, options.limit));
    }
    /** 取一条。 */
    get(id) {
        return this.items.find(item => item.id === id);
    }
    /** 到点该执行的（pending 且到时间）。 */
    due(now = Date.now()) {
        return this.items.filter(item => item.status === 'pending' && item.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
    }
    /** 即将到来的几条（给提示词用）。 */
    upcoming(chatKey, options = {}) {
        const now = options.now ?? Date.now();
        const within = options.withinMs ?? 7 * DAY_MS;
        return this.list({ chatKey, status: 'pending' })
            .filter(item => item.dueAt <= now + within)
            .slice(0, Math.max(1, options.limit ?? 3));
    }
    /** 统计。 */
    stats() {
        const pending = this.items.filter(item => item.status === 'pending');
        const next = pending.length === 0 ? 0 : Math.min(...pending.map(item => item.dueAt));
        return {
            total: this.items.length,
            pending: pending.length,
            done: this.items.filter(item => item.status === 'done').length,
            missed: this.items.filter(item => item.status === 'missed').length,
            nextDueAt: next === 0 ? 0 : next,
        };
    }
    /**
     * 新建一条提醒。守卫顺序（超限的错误文案要能直接给群友看）：
     * 开关 → 正文 → 会话 → 时间 → 最少提前量 → 全局上限 → 单会话上限 → 每人每日上限。
     */
    create(input, now = Date.now()) {
        if (!this.settings.enabled)
            throw new ReminderError('定时提醒没开（设置页「定时提醒」里打开）。');
        const text = String(input.text ?? '').trim().slice(0, MAX_REMINDER_TEXT);
        if (text === '')
            throw new ReminderError('要提醒什么事？说具体点。');
        const chatKey = safeChatKey(input.chatKey);
        if (chatKey === '')
            throw new ReminderError('不知道该在哪儿提醒（会话标识不合法）。');
        if (!Number.isFinite(input.dueAt) || input.dueAt <= 0)
            throw new ReminderError('时间不合法。');
        const earliest = now + Math.max(0, this.settings.minDelaySec) * 1000;
        if (input.dueAt < earliest) {
            throw new ReminderError(`定得太近了，至少要提前 ${String(this.settings.minDelaySec)} 秒。`);
        }
        const active = this.items.filter(item => item.status === 'pending' || item.status === 'running');
        if (active.length >= this.settings.maxPending)
            throw new ReminderError('挂着的提醒太多了，先让机器人把旧的提醒完。');
        if (active.filter(item => item.chatKey === chatKey).length >= this.settings.maxPendingPerChat) {
            throw new ReminderError('这个会话挂着的提醒太多了，先取消几条。');
        }
        const creatorId = safeUserId(input.creatorId);
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        if (creatorId !== '') {
            const todayCount = this.items.filter(item => item.creatorId === creatorId && item.createdAt >= startOfDay.getTime()).length;
            if (todayCount >= this.settings.maxPerDay)
                throw new ReminderError('今天定的提醒太多了，明天再说。');
        }
        const item = {
            id: newId(),
            text,
            note: String(input.note ?? '').trim().slice(0, MAX_REMINDER_NOTE),
            dueAt: Math.trunc(input.dueAt),
            chatKey,
            targetUserId: safeUserId(input.targetUserId),
            targetName: String(input.targetName ?? '').trim().slice(0, 60),
            creatorId,
            creatorName: String(input.creatorName ?? '').trim().slice(0, 60),
            repeat: normalizeRepeat(input.repeat, input.dueAt),
            importance: clampInt(input.importance ?? 3, 1, 5, 3),
            status: 'pending',
            createdAt: now,
            updatedAt: now,
            firedAt: 0,
            firedCount: 0,
            retries: 0,
            lastError: '',
            notifiedAt: 0,
        };
        this.items.push(item);
        this.save();
        return item;
    }
    /** 取消一条提醒。 */
    cancel(id, now = Date.now()) {
        const item = this.get(id);
        if (item === undefined || item.status === 'canceled' || item.status === 'done')
            return false;
        item.status = 'canceled';
        item.updatedAt = now;
        this.save();
        return true;
    }
    /** 彻底删掉一条。 */
    remove(id) {
        const before = this.items.length;
        this.items = this.items.filter(item => item.id !== id);
        if (this.items.length === before)
            return false;
        this.save();
        return true;
    }
    /** 标记开始执行（**立刻落盘**：中途重启也能靠 running 状态回收重试）。 */
    claim(id, now = Date.now()) {
        const item = this.get(id);
        if (item === undefined || item.status !== 'pending')
            return false;
        item.status = 'running';
        item.firedAt = now;
        item.updatedAt = now;
        this.save();
        return true;
    }
    /** 放回排队（外部原因没发出去，比如会话正忙）；不消耗重试次数。 */
    release(id, now = Date.now()) {
        const item = this.get(id);
        if (item === undefined || item.status !== 'running')
            return;
        item.status = 'pending';
        item.updatedAt = now;
        this.save();
    }
    /** 标记执行成功；周期提醒顺延到下一次。 */
    markFired(id, options = {}) {
        const item = this.get(id);
        if (item === undefined)
            return;
        const at = options.at ?? Date.now();
        item.firedCount += 1;
        item.lastError = '';
        item.retries = 0;
        // 基准取 max(实际触发时间, 原定时间)：晚触发不会让周期越漂越早。
        const next = nextDueAt(item, Math.max(at, item.dueAt));
        if (next > 0) {
            item.dueAt = next;
            item.status = 'pending';
            item.notifiedAt = 0;
        }
        else {
            item.status = 'done';
        }
        item.updatedAt = at;
        this.save();
    }
    /** 标记执行失败：重试几次仍失败就当错过。 */
    markFailed(id, options = {}) {
        const item = this.get(id);
        if (item === undefined)
            return;
        const at = options.at ?? Date.now();
        item.firedCount += 1;
        item.lastError = String(options.error ?? '').slice(0, 200);
        item.retries += 1;
        item.status = item.lastError !== '' && item.retries >= 3 ? 'missed' : 'pending';
        item.updatedAt = at;
        this.save();
    }
    /** 记录「已经把补发这件事说出来了」。 */
    ackNotified(ids, now = Date.now()) {
        if (ids.length === 0)
            return;
        for (const item of this.items) {
            if (ids.includes(item.id))
                item.notifiedAt = now;
        }
        this.save();
    }
    /** 清掉太旧的已结束记录。 */
    prune(now = Date.now()) {
        const cutoff = now - Math.max(1, this.settings.ttlDays) * DAY_MS;
        const before = this.items.length;
        this.items = this.items.filter(item => item.status === 'pending' || item.status === 'running' || item.updatedAt >= cutoff);
        const removed = before - this.items.length;
        if (removed > 0)
            this.save();
        return removed;
    }
    /**
     * 清扫：回收僵尸 running、挑出到点的、标记错过的。
     * @returns 该执行的 / 已错过的 / 被回收的。
     */
    sweep(now = Date.now()) {
        const recovered = [];
        for (const item of this.items) {
            // 执行中卡太久的当僵尸（进程被杀在 claim 之后）：放回排队重试。
            if (item.status === 'running' && now - item.firedAt > STALE_RUNNING_MS) {
                item.status = 'pending';
                item.updatedAt = now;
                recovered.push(item.id);
            }
        }
        const catchUpMs = Math.max(0, this.settings.catchUpMinutes) * 60_000;
        const fired = [];
        const missed = [];
        for (const item of this.items) {
            if (item.status !== 'pending' || item.dueAt > now)
                continue;
            if (now - item.dueAt <= catchUpMs)
                fired.push(item);
            else {
                item.status = 'missed';
                item.updatedAt = now;
                missed.push(item);
            }
        }
        if (recovered.length > 0 || missed.length > 0)
            this.save();
        return { fired, missed, recovered };
    }
    /** 把一条错过的提醒记成「已告知」。 */
    markMissedNotified(id, now = Date.now()) {
        const item = this.get(id);
        if (item === undefined)
            return;
        item.notifiedAt = now;
        this.save();
    }
    /** 状态文件路径（状态展示用）。 */
    get path() {
        return this.file;
    }
    /** 是否已经加载过。 */
    get ready() {
        return this.loaded;
    }
}
/** 生成一个短 id。 */
function newId() {
    return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
