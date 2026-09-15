/**
 * 出站消息过滤：机器人往 QQ 发文字前，按违禁词表检查一遍。
 *
 * 词表复用「持续学习 → 禁用词」（`learner.bannedWords`），设置页里那一个框两边都管。
 * 命中时整条丢弃还是只删词，由 `mode` 决定：
 * - `block`（默认）：整条不发，记日志
 * - `redact`：把违禁词替换成 `*`，剩下的照发
 */
/**
 * 检查并过滤一条将要发出的文本。
 * @param text - 准备发送的文本。
 * @param settings - 过滤配置（词表为空时原样放行）。
 * @returns 过滤结果；`blocked=true` 时调用方不应发送。
 */
export function filterOutboundText(text, settings) {
    const words = settings.bannedWords
        .map(word => word.trim())
        .filter(word => word !== '');
    if (words.length === 0 || text.trim() === '') {
        return { text, blocked: false, hits: [] };
    }
    const lower = text.toLowerCase();
    // 词表不区分大小写：用户填「Banned」也要能命中文本里的「banned」。
    const hits = words.filter(word => lower.includes(word.toLowerCase()));
    if (hits.length === 0)
        return { text, blocked: false, hits: [] };
    if (settings.mode === 'redact') {
        let filtered = text;
        for (const word of [...hits].sort((a, b) => b.length - a.length)) {
            // 大小写不敏感地替换；用词本身的长短号填 `*`，保持排版不至于太突兀。
            const pattern = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu');
            filtered = filtered.replace(pattern, '*'.repeat(Math.max(1, word.length)));
        }
        // 剩下的只有星号/空白就等于没内容，按整条拦下处理。
        const cleaned = filtered.trim();
        if (cleaned === '' || /^\*+$/u.test(cleaned.replace(/\s/gu, ''))) {
            return { text: '', blocked: true, hits };
        }
        return { text: cleaned, blocked: false, hits };
    }
    return { text, blocked: true, hits };
}
/** 出站过滤器：包一层日志与计数。 */
export class OutboundFilter {
    settings;
    logger;
    /** 已拦截的条数（运行状态上报用）。 */
    blockedCount = 0;
    /** 已替换的条数。 */
    redactedCount = 0;
    constructor(settings, logger) {
        this.settings = settings;
        this.logger = logger;
    }
    /** 当前词表与模式。 */
    get config() {
        return this.settings;
    }
    /** 累计拦截 / 替换条数。 */
    get stats() {
        return { blocked: this.blockedCount, redacted: this.redactedCount };
    }
    /**
     * 过滤一条将要发出的文本；命中时记日志。
     * @param text - 准备发送的文本。
     * @param scope - 发往哪里（群号 / private:QQ），写进日志。
     * @returns 过滤后的文本；返回 `undefined` 表示整条拦下、不要发。
     */
    apply(text, scope) {
        const result = filterOutboundText(text, this.settings);
        if (result.hits.length === 0)
            return text;
        if (result.blocked) {
            this.blockedCount += 1;
            this.logger.warn('qq-groupmate: 拦截发往 %s 的消息（含违禁词：%s）：%s', scope, result.hits.join('、'), text.slice(0, 80));
            return undefined;
        }
        this.redactedCount += 1;
        this.logger.warn('qq-groupmate: 发往 %s 的消息含违禁词（%s），已替换成 *', scope, result.hits.join('、'));
        return result.text;
    }
}
