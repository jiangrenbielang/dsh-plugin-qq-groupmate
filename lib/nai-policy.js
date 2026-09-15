/**
 * 生图模型策略：按 QQ 记「这个人用 V4.5 还是 V5」，以及 V5 的滚动 24 小时额度。
 *
 * 移植自大佬的 AstrBot 插件 astrbot_plugin_nai2api 的 model_policy.py：
 *   - 模型选择按用户（QQ 号）分别保存，一个人切换不影响别人
 *   - V5 每张 5 点，普通用户每 24 小时最多 N 张（滚动窗口，不是自然日）
 *   - 白名单用户不限额
 *
 * 额度在**提交生成前**先占位（reserve），画失败时再释放（release），
 * 避免并发下两个人同时通过检查、双双超额。
 */
import { readJsonFile, writeJsonFile } from "./store.js";
import { V4_MODEL, V5_MODEL } from "./nai-presets.js";
/** V5 额度窗口：24 小时。 */
const WINDOW_MS = 24 * 60 * 60 * 1000;
/** V5 额度用尽时抛出。 */
export class V5LimitReached extends Error {
    constructor(limit, retryAfterMs) {
        const minutes = Math.max(1, Math.ceil(retryAfterMs / 60000));
        const wait = minutes >= 60 ? `约 ${String(Math.floor(minutes / 60))} 小时 ${String(minutes % 60)} 分钟` : `约 ${String(minutes)} 分钟`;
        super(`V5 每 24 小时最多画 ${String(limit)} 张，你的额度用完了，${wait}后再试`);
        this.name = 'V5LimitReached';
    }
}
/**
 * 模型策略：按 QQ 记模型与 V5 用量。
 * 状态落一份 JSON（读多写少，不需要 sqlite）。
 */
export class NaiModelPolicy {
    settings;
    logger;
    state;
    unlimited;
    constructor(settings, logger) {
        this.settings = settings;
        this.logger = logger;
        this.unlimited = new Set(settings.v5UnlimitedUsers.map(id => id.trim()).filter(id => id !== ''));
        const raw = readJsonFile(settings.path);
        this.state = {
            models: raw?.models !== undefined && typeof raw.models === 'object' && raw.models !== null ? raw.models : {},
            usage: raw?.usage !== undefined && typeof raw.usage === 'object' && raw.usage !== null ? raw.usage : {},
        };
        this.prune(Date.now());
    }
    /**
     * 这个人当前用哪个模型。
     * 显式切换过（`.切v5` / `.切v4.5`）就用他选的；没选过就用配置里的默认模型
     * （设置页「生图 → 模型」，默认 V4.5）。
     *
     * 以前这里写死回退 V4.5，导致设置页把默认模型改成 V5 也不生效——
     * 所有人还是按 V4.5 算，跟页面上写的对不上。
     */
    modelOf(userId, fallback = V4_MODEL) {
        const value = this.state.models[userId];
        if (value === V5_MODEL || value === V4_MODEL)
            return value;
        return fallback === V5_MODEL ? V5_MODEL : V4_MODEL;
    }
    /** 切换某个人的模型。 */
    setModel(userId, model) {
        if (model !== V4_MODEL && model !== V5_MODEL) {
            throw new Error(`不认识的生图模型：${model}`);
        }
        this.state.models[userId] = model;
        this.persist();
    }
    /** 查某个人的 V5 额度（不占用）。 */
    quotaOf(userId, now = Date.now()) {
        if (this.unlimited.has(userId))
            return { unlimited: true, remaining: Number.POSITIVE_INFINITY, retryAfterMs: 0 };
        const used = this.usageOf(userId, now);
        const limit = this.settings.v5DailyLimit;
        if (limit <= 0)
            return { unlimited: true, remaining: Number.POSITIVE_INFINITY, retryAfterMs: 0 };
        const remaining = Math.max(0, limit - used.length);
        if (remaining > 0)
            return { unlimited: false, remaining, retryAfterMs: 0 };
        const oldest = used[0] ?? now;
        return { unlimited: false, remaining: 0, retryAfterMs: Math.max(0, oldest + WINDOW_MS - now) };
    }
    /**
     * 占一张 V5 额度；额度不够抛 `V5LimitReached`。
     * @returns 占位凭据（画失败时交给 `release` 还回去）；白名单返回 undefined。
     */
    reserve(userId, now = Date.now()) {
        if (this.unlimited.has(userId))
            return undefined;
        const limit = this.settings.v5DailyLimit;
        if (limit <= 0)
            return undefined;
        const quota = this.quotaOf(userId, now);
        if (quota.remaining <= 0)
            throw new V5LimitReached(limit, quota.retryAfterMs);
        const list = this.usageOf(userId, now);
        list.push(now);
        this.state.usage[userId] = list;
        this.persist();
        return now;
    }
    /** 画失败时把占位还回去（只还一次；凭据对不上就忽略）。 */
    release(userId, token, now = Date.now()) {
        if (token === undefined)
            return;
        const list = this.usageOf(userId, now);
        const index = list.indexOf(token);
        if (index < 0)
            return;
        list.splice(index, 1);
        if (list.length === 0)
            delete this.state.usage[userId];
        else
            this.state.usage[userId] = list;
        this.persist();
    }
    /**
     * 一句「当前模型 + 额度」的说明。
     * @param userId - 谁的额度。
     * @param fallback - 没显式切过模型时用哪个（设置页配的默认模型）。
     */
    describe(userId, fallback = V4_MODEL) {
        const model = this.modelOf(userId, fallback);
        if (model !== V5_MODEL)
            return '当前模型：V4.5（默认，1 点/张，不限张数）';
        const quota = this.quotaOf(userId);
        const detail = quota.unlimited
            ? '白名单不限额'
            : `24 小时还剩 ${String(quota.remaining)}/${String(this.settings.v5DailyLimit)} 张`;
        return `当前模型：V5（5 点/张，${detail}）`;
    }
    /** 取窗口内的用量（顺带清掉过期的）。 */
    usageOf(userId, now) {
        const list = (this.state.usage[userId] ?? []).filter(at => now - at < WINDOW_MS);
        if (list.length === 0)
            delete this.state.usage[userId];
        else
            this.state.usage[userId] = list;
        return list;
    }
    /** 清掉所有过期的用量记录。 */
    prune(now) {
        let changed = false;
        for (const [userId, list] of Object.entries(this.state.usage)) {
            if (!Array.isArray(list)) {
                delete this.state.usage[userId];
                changed = true;
                continue;
            }
            const kept = list.filter(at => typeof at === 'number' && now - at < WINDOW_MS);
            if (kept.length !== list.length) {
                changed = true;
                if (kept.length === 0)
                    delete this.state.usage[userId];
                else
                    this.state.usage[userId] = kept;
            }
        }
        if (changed)
            this.persist();
    }
    persist() {
        try {
            writeJsonFile(this.settings.path, this.state);
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 生图额度状态落盘失败（%s）：%s', this.settings.path, String(error));
        }
    }
}
