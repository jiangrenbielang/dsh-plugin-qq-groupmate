/**
 * dsh 会话内的快捷命令：在任意会话（包括 qqds 工作区里的窗口会话）里
 * 用 `/qq-*` 直接查看和切换 QQ 机器人的状态、角色、模型与记忆。
 *
 * 命令不进入模型消息：结果只渲染在界面上，不消耗 token、不污染对话。
 */
const HELP = [
    '可用命令：',
    '/qq                  查看机器人状态',
    '/qq-card <角色id>     切换默认角色（加群号则只改那个群）',
    '/qq-model <模型>      切换默认模型，可写 provider/model（加群号则只改那个群）',
    '/qq-groups           列出有记忆的群',
    '/qq-memory <群号> [条数]  看某个群最近的对话',
    '/qq-reset <群号>      清空某个群的记忆',
    '/qq-say <群号> <内容>  以机器人身份发一句话（测试连接）',
].join('\n');
function ok(text) {
    return { kind: 'success', text };
}
function fail(text) {
    return { kind: 'error', text };
}
/** 解析 `<值> [群号]` 形式的输入。 */
function splitValueAndGroup(raw) {
    const parts = raw.trim().split(/\s+/u).filter(part => part !== '');
    if (parts.length === 0)
        return { value: '' };
    if (parts.length === 1)
        return { value: parts[0] ?? '' };
    return { value: parts[0] ?? '', groupId: parts[1] };
}
/** 注册全部会话内命令；返回注销函数。 */
export function registerSessionCommands(ctx, deps) {
    const { getManager, logger, setSetting } = deps;
    const manager = () => getManager();
    ctx.commands.register({
        name: 'qq',
        description: '查看 QQ 群友机器人的连接状态与当前配置',
        handler: () => {
            const current = manager();
            if (current === undefined)
                return fail('插件未启动：检查配置或日志。');
            return ok(`${current.globalStatus()}\n\n${HELP}`);
        },
    });
    ctx.commands.register({
        name: 'qq-card',
        description: '切换 QQ 机器人的角色卡（默认角色或指定群）',
        input: { hint: '<角色id> [群号]' },
        handler: async ({ rawInput }) => {
            const current = manager();
            if (current === undefined)
                return fail('插件未启动。');
            const { value, groupId } = splitValueAndGroup(rawInput);
            if (value === '') {
                const available = current.characterIds();
                return fail(`用法：/qq-card <角色id> [群号]\n可用角色：${available.length === 0 ? '（无）' : available.join('、')}`);
            }
            if (!current.characterIds().includes(value)) {
                return fail(`没有角色卡「${value}」。可用：${current.characterIds().join('、') || '（无）'}`);
            }
            if (groupId === undefined) {
                await setSetting({ defaultCharacter: value });
                return ok(`默认角色已切换为「${value}」，未单独设置的群都会用它。`);
            }
            return ok(current.setCharacter(groupId, value));
        },
    });
    ctx.commands.register({
        name: 'qq-model',
        description: '切换 QQ 机器人使用的模型（默认或指定群）',
        input: { hint: '<模型 或 provider/模型> [群号]' },
        handler: async ({ rawInput }) => {
            const current = manager();
            if (current === undefined)
                return fail('插件未启动。');
            const { value, groupId } = splitValueAndGroup(rawInput);
            if (value === '') {
                return fail('用法：/qq-model <模型> 或 /qq-model <provider>/<模型> [群号]');
            }
            const slash = value.indexOf('/');
            const provider = slash > 0 ? value.slice(0, slash) : undefined;
            const model = slash > 0 ? value.slice(slash + 1) : value;
            if (groupId === undefined) {
                await setSetting(provider === undefined ? { model } : { provider, model });
                return ok(`默认模型已切换为 ${provider === undefined ? model : `${provider} / ${model}`}。`);
            }
            return ok(current.setModel(groupId, provider, model));
        },
    });
    ctx.commands.register({
        name: 'qq-groups',
        description: '列出 QQ 机器人的群与记忆条数',
        handler: () => {
            const current = manager();
            if (current === undefined)
                return fail('插件未启动。');
            return ok(current.groupSummary());
        },
    });
    ctx.commands.register({
        name: 'qq-memory',
        description: '查看某个群最近的对话记录',
        input: { hint: '<群号> [条数]' },
        handler: ({ rawInput }) => {
            const current = manager();
            if (current === undefined)
                return fail('插件未启动。');
            const parts = rawInput.trim().split(/\s+/u).filter(part => part !== '');
            const groupId = parts[0];
            if (groupId === undefined)
                return fail('用法：/qq-memory <群号> [条数]');
            const limit = Number(parts[1] ?? 20);
            return ok(current.memoryPreview(groupId, Number.isFinite(limit) ? limit : 20));
        },
    });
    ctx.commands.register({
        name: 'qq-reset',
        description: '清空某个群的记忆',
        input: { hint: '<群号>' },
        handler: ({ rawInput }) => {
            const current = manager();
            if (current === undefined)
                return fail('插件未启动。');
            const groupId = rawInput.trim().split(/\s+/u)[0];
            if (groupId === undefined || groupId === '')
                return fail('用法：/qq-reset <群号>');
            return ok(current.reset(groupId));
        },
    });
    ctx.commands.register({
        name: 'qq-say',
        description: '以机器人身份往群里发一条消息',
        input: { hint: '<群号> <内容>' },
        handler: async ({ rawInput }) => {
            const current = manager();
            if (current === undefined)
                return fail('插件未启动。');
            const trimmed = rawInput.trim();
            const space = trimmed.search(/\s/u);
            if (space <= 0)
                return fail('用法：/qq-say <群号> <内容>');
            const groupId = trimmed.slice(0, space);
            const text = trimmed.slice(space + 1).trim();
            if (text === '')
                return fail('要发送的内容不能为空。');
            try {
                await current.say(groupId, text);
                return ok(`已发送到群 ${groupId}。`);
            }
            catch (error) {
                logger.warn('qq-groupmate: /qq-say 发送失败：%s', String(error));
                return fail(`发送失败：${String(error)}`);
            }
        },
    });
}
