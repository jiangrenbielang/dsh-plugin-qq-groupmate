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
/** 按配置裁剪历史：保留最近的消息并限制总字数。 */
export function trimHistory(history, maxTurns, maxChars) {
    let list = history.slice(-Math.max(1, maxTurns));
    let total = list.reduce((sum, entry) => sum + entry.text.length + entry.speaker.length + 2, 0);
    while (total > maxChars && list.length > 1) {
        const removed = list.shift();
        if (removed === undefined)
            break;
        total -= removed.text.length + removed.speaker.length + 2;
    }
    return list;
}
