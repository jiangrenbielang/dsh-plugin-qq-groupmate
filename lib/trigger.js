/**
 * 触发判断：只回答「这条消息要不要回」，不碰历史、状态与发送。
 * 抽成纯函数便于覆盖各种触发组合，也让 GroupManager 只负责编排。
 * 运行/插件配置的形状（运行时参数、全局默认、每群覆盖）也放在这里，
 * 因为触发判断的五个事实正是从这些配置里取的。
 */
/** 从消息段中提取纯文本与触发线索。 */
export function extractMessage(segments, selfId) {
    const parts = [];
    let mentioned = false;
    let replyTo;
    for (const segment of segments) {
        switch (segment.type) {
            case 'text':
                parts.push(String(segment.data.text ?? ''));
                break;
            case 'at': {
                const qq = String(segment.data.qq ?? '');
                if (qq === 'all' || (selfId !== undefined && qq === String(selfId))) {
                    mentioned = true;
                    parts.push('@你');
                }
                else {
                    parts.push(`@${qq}`);
                }
                break;
            }
            case 'reply': {
                const id = Number(segment.data.id);
                if (Number.isFinite(id))
                    replyTo = id;
                break;
            }
            case 'image':
                parts.push('[图片]');
                break;
            case 'face':
                parts.push('[表情]');
                break;
            case 'record':
                parts.push('[语音]');
                break;
            case 'video':
                parts.push('[视频]');
                break;
            case 'json':
                parts.push('[卡片消息]');
                break;
            case 'forward':
                parts.push('[转发消息]');
                break;
            default:
                parts.push(`[${segment.type}]`);
                break;
        }
    }
    const text = parts.join('').replace(/\s+/gu, ' ').trim();
    return { text, mentioned, replyTo };
}
/**
 * 触发判断：把五个事实（mention / prefixes / 角色名+别名 / replyToSelf / randomChance）
 * 折算成 TriggerFacts，纯函数、无副作用。
 *
 * 随机数刻意由调用方算好传入（`randomHit`），不在这里调用 `Math.random()`：
 * 线上实现是 `config.randomChance > 0 && Math.random() < config.randomChance`，
 * 只要 randomChance > 0，每条群消息恰好求值一次，而且早于白名单过滤与历史写入。
 * 把随机数留在原来的调用点，才能保证 Math.random 的调用次数与顺序完全不变。
 */
export function evaluateTrigger(input) {
    const lower = input.text.toLowerCase();
    const nameHit = [input.characterName, ...input.aliases]
        .filter(alias => alias !== '')
        .some(alias => lower.startsWith(alias.toLowerCase()));
    const prefixHit = input.prefixes.some(prefix => lower.startsWith(prefix.toLowerCase()));
    return {
        mentioned: input.mention && input.mentioned,
        prefixMatched: prefixHit || nameHit,
        repliedToBot: input.replyToSelf && input.repliedToBot,
        randomHit: input.randomHit,
    };
}
