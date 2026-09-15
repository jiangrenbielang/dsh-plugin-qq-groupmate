/**
 * 长回复改「合并转发」。
 *
 * 画风清单这类十几行的回复直接铺在群里，一次就顶掉半屏聊天记录；转成一条
 * 「聊天记录」卡片后群里只占一条，想看的人点开看。短回复照旧直接发文本——
 * 一两句话也包成卡片反而更难点开。
 *
 * 协议端要的是 OneBot 11 的 `send_group_forward_msg` + `node` 段
 * （NapCat / SnowLuma 都支持；SnowLuma 的节点取 `user_id`/`nickname`/`content`）。
 * 转发失败（协议端不支持、节点被拒等）自动退回普通文本，绝不让回复发不出去。
 */
/** 行数到这么多就当长回复（画风清单 17~19 行，正常聊天一到两句）。 */
export const FORWARD_MIN_LINES = 5;
/** 或者字数到这么多（单行长文一样会刷屏）。 */
export const FORWARD_MIN_CHARS = 300;
/** 一条转发里最多几个节点：行数更多时把后面的行并进最后一个节点（上百个节点协议端不爱收）。 */
export const FORWARD_MAX_NODES = 50;
/** 把回复切成非空行。 */
export function replyLines(text) {
    return text
        .split(/\r?\n/u)
        .map(line => line.trimEnd())
        .filter(line => line.trim() !== '');
}
/** 这段回复要不要走合并转发。 */
export function shouldForwardReply(text) {
    if (text.trim() === '')
        return false;
    return replyLines(text).length >= FORWARD_MIN_LINES || text.length >= FORWARD_MIN_CHARS;
}
/**
 * 把回复拆成转发节点：一行一个节点（卡片里就是一条条短消息，好读）。
 * 行数超过 {@link FORWARD_MAX_NODES} 时，多出来的行并进最后一个节点。
 * @param text - 回复正文。
 * @param sender - 发送者（QQ 号与显示名）。
 * @returns 节点数组；`selfId` 不可用时返回空数组（调用方退回普通文本）。
 */
export function buildForwardNodes(text, sender) {
    const selfId = sender.selfId;
    if (selfId === undefined || !Number.isFinite(selfId) || selfId <= 0)
        return [];
    const lines = replyLines(text);
    if (lines.length === 0)
        return [];
    const nickname = sender.nickname?.trim() === '' || sender.nickname === undefined
        ? String(selfId)
        : sender.nickname;
    const head = lines.slice(0, FORWARD_MAX_NODES - 1);
    const rest = lines.slice(FORWARD_MAX_NODES - 1);
    const chunks = rest.length === 0 ? head : [...head, rest.join('\n')];
    return chunks.map(line => ({
        type: 'node',
        data: {
            user_id: selfId,
            nickname,
            content: [{ type: 'text', data: { text: line } }],
        },
    }));
}
/** 发一条合并转发；失败抛错，由调用方决定要不要退文本。 */
async function sendForward(client, groupId, nodes) {
    const result = await client.call('send_group_forward_msg', {
        group_id: Number(groupId),
        messages: nodes,
    });
    return typeof result?.message_id === 'number' ? result.message_id : undefined;
}
/**
 * 发一条群消息：长回复先试合并转发，失败或太短就直接发文本。
 * 文本那条路的异常照旧抛给调用方（调用方已有兜错逻辑），转发那条路的异常只记日志。
 *
 * @param client - OneBot 端点。
 * @param groupId - 群号。
 * @param text - 已经过滤过的正文（调用方负责违禁词过滤，这里不再过滤）。
 * @param sender - 转发卡片上的发送者。
 * @param logger - 日志。
 */
export async function deliverGroupText(client, groupId, text, sender, logger) {
    if (shouldForwardReply(text)) {
        const nodes = buildForwardNodes(text, { ...sender, selfId: sender.selfId ?? client.self });
        if (nodes.length === 0) {
            logger.debug?.('qq-groupmate: 机器人 QQ 号未知，长回复改发普通文本');
        }
        else {
            try {
                const messageId = await sendForward(client, groupId, nodes);
                logger.info('qq-groupmate: 群 %s 的长回复（%s 行）已按合并转发发出（%s 个节点）', groupId, String(replyLines(text).length), String(nodes.length));
                return { ...(messageId === undefined ? {} : { messageId }), viaForward: true };
            }
            catch (error) {
                logger.warn('qq-groupmate: 合并转发失败（%s），改发普通文本', String(error));
            }
        }
    }
    const result = await client.sendGroupMessage(groupId, [{ type: 'text', data: { text } }]);
    return { messageId: result.message_id, viaForward: false };
}
