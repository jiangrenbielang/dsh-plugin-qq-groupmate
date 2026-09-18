/**
 * 历史/状态的数据形状与纯函数工具：只有类型和纯函数，不持有状态、不产生副作用。
 * 由 GroupManager 编排使用，summary / learner 等模块直接从本模块取类型。
 */
/** 由内部作用域键推导记忆归属：`private:<id>` 是私聊，其余是群。 */
export function memoryScopeOf(scopeKey) {
    return scopeKey.startsWith('private:')
        ? { kind: 'private', id: scopeKey.slice('private:'.length) }
        : { kind: 'group', id: scopeKey };
}
/**
 * 会话键校验：群号或 `private:<QQ>`。
 *
 * 放在本模块（而不是某个功能模块）里：群友档案、定时提醒、命令都要用同一套判定，
 * 各自复制一份迟早会出现「提醒认的键档案不认」这种口径不一致。
 * @param value - 待校验的值。
 * @returns 规范化后的键；非法时返回空串。
 */
export function safeChatKey(value) {
    const text = String(value ?? '').trim();
    if (/^\d{1,15}$/u.test(text))
        return text;
    const match = /^private:(\d{1,15})$/u.exec(text);
    return match === null ? '' : text;
}
/**
 * QQ 号校验（1~15 位数字）。
 * @param value - 待校验的值。
 * @returns 规范化后的 QQ 号；非法时返回空串。
 */
export function safeUserId(value) {
    const text = String(value ?? '').trim();
    return /^\d{1,15}$/u.test(text) ? text : '';
}
/** 提示词里怎么称呼一个发言人：昵称 + （QQ 号），让模型能认准人。 */
export function speakerLabel(entry) {
    return entry.userId === undefined || entry.userId === ''
        ? entry.speaker
        : `${entry.speaker}(${entry.userId})`;
}
/**
 * 块状裁剪的最小粒度（条）。
 *
 * 2026-09-17 从 16 提到 64：群里消息短（十几字一条）时，16 条几分钟就攒够，
 * 于是请求窗口每几分钟就往前滑一次、前缀跟着断一次，上游缓存被反复清零
 * （实测日志里同一群连续几次请求的「首条」每次都不同就是这个原因）。
 * 粒度越大，两次「断裂」之间的稳定期越长，命中率越高。
 */
const TRIM_BLOCK_MIN = 64;
/**
 * 按配置裁剪历史：保留最近的消息并限制总字数。
 *
 * **块状裁剪（缓存友好，2026-09-15）**：上游按请求前缀做上下文缓存，如果每来一条新消息
 * 就从头部丢掉最旧的一条，请求前缀每轮都会漂移一格，几万 token 的历史每轮都要重新计费。
 * 所以只在超限时一次丢掉一整块（至少 {@link TRIM_BLOCK} 条），
 * 让绝大多数轮次里 messages 前缀逐字节不变。
 * @param history - 完整历史（时间正序）。
 * @param maxTurns - 最多保留多少条。
 * @param maxChars - 最多保留多少字符（超了再从头部按块丢）。
 * @param blockSize - 一次至少丢多少条，默认 16。
 * @returns 裁剪后的历史（时间正序）。
 */
export function trimHistory(history, maxTurns, maxChars, blockSize) {
    const limit = Math.max(1, maxTurns);
    // 块随窗口缩放：至少 64 条，且不小于窗口的四分之一。
    const block = Math.max(TRIM_BLOCK_MIN, Math.round(blockSize ?? limit / 4));
    let list = history;
    if (history.length > limit) {
        const overflow = history.length - limit;
        const drop = Math.min(history.length - 1, Math.max(block, Math.ceil(overflow / block) * block));
        list = history.slice(drop);
    }
    let total = list.reduce((sum, entry) => sum + entry.text.length + entry.speaker.length + 2, 0);
    let start = 0;
    while (total > maxChars && list.length - start > 1) {
        const step = Math.min(block, list.length - start - 1);
        for (let index = 0; index < step; index += 1) {
            const removed = list[start + index];
            total -= removed.text.length + removed.speaker.length + 2;
        }
        start += step;
    }
    return start === 0 ? list : list.slice(start);
}
