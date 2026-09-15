/**
 * 群内管理命令：切换角色/模型、重置上下文、查看状态。
 * 命令只在群聊/私聊中以 `commandPrefix` 开头时生效，默认仅管理员可用。
 */
import { deliverGroupText } from "./forward.js";
import { V4_MODEL, V5_MODEL } from "./nai-presets.js";
import { downloadImage } from "./vision.js";
import { ReminderError, describeReminder, parseWhen } from "./reminders.js";
/** 取消息里的图片：优先当前消息，其次被回复的那条。 */
async function resolveImageSegments(client, event) {
    const direct = event.message.filter(segment => segment.type === 'image');
    if (direct.length > 0)
        return direct;
    const reply = event.message.find(segment => segment.type === 'reply');
    const id = reply === undefined ? Number.NaN : Number(reply.data.id);
    if (!Number.isFinite(id))
        return [];
    try {
        const message = await client.call('get_msg', { message_id: id });
        return (message?.message ?? []).filter(segment => segment.type === 'image');
    }
    catch {
        return [];
    }
}
/**
 * 尝试把文本解析成命令。
 * @param text - 消息纯文本。
 * @param prefix - 命令前缀。
 * @returns 解析结果；不是命令时返回 `undefined`。
 */
export function parseCommand(text, prefix) {
    const trimmed = text.trim();
    if (!trimmed.startsWith(prefix))
        return undefined;
    const body = trimmed.slice(prefix.length).trim();
    if (body === '')
        return undefined;
    const [name, ...args] = body.split(/\s+/u);
    if (name === undefined || name === '')
        return undefined;
    return { name: name.toLowerCase(), args };
}
/** 命令帮助文本。 */
export function commandHelp(prefix) {
    return [
        '群友插件命令（管理员）：',
        `${prefix}card [角色id]  查看/切换角色卡`,
        `${prefix}model [provider/model]  查看/切换模型`,
        `${prefix}status  查看当前状态`,
        `${prefix}reset  清空本群上下文`,
        `${prefix}收藏 <名字>  收藏一张图当表情（回复那张图发这条）`,
        `${prefix}表情  列出表情库`,
        `${prefix}存画风 <名字> <画师串>  存一个自己的生图画风`,
        `${prefix}删画风 <名字>  删一个自定义生图画风`,
        '',
        `生图（全员可用，额度按各自的 QQ 算）：`,
        `${prefix}生图 <画面标签>  直接画一张（可加 -p <画风名>）`,
        `${prefix}画风 [名字]  看画风列表（跟随自己当前模型）/ 看某个画风的画师串`,
        `${prefix}v5画风 / ${prefix}v4画风  直接看 V5 画风 / V4.5 预设`,
        `${prefix}切v5 / ${prefix}切v4.5  切换自己的生图模型（V5 每 24 小时有额度）`,
        `${prefix}生图额度  查看自己的生图模型与 V5 剩余张数`,
        '（画风清单这类长回复会以「合并转发」发出来，免得刷屏）',
        '',
        '全员玩法（不需要管理员）：',
        `${prefix}今日老婆 / 抽老婆  随机抽一位今日老婆`,
        `${prefix}强娶 @某人  强行更换今日老婆（有冷却）`,
        `${prefix}我的老婆 / ${prefix}分手 / ${prefix}rbq排行  记录与排行`,
        `${prefix}占卜 [问题] / ${prefix}单抽  星羽塔罗占卜`,
        '',
        '联网与记事（全员可用，也可以直接用自然语言跟角色说）：',
        '直接说「帮我查一下…」「这个梗什么出处」「明天九点提醒我…」即可；',
        `也可以手动用命令：`,
        `${prefix}提醒 <时间> <事>  定个提醒（时间写 2026-09-16 09:00 / 09:30 / +30m / 3天后）`,
        `${prefix}我的提醒 / ${prefix}提醒取消 <编号>  看/取消这个会话里的提醒`,
        `${prefix}回忆 <关键词或QQ号>  查记下的事与印象（跨群也查得到）`,
        `${prefix}忘掉 <印象内容>  删掉一条关于自己的印象`,
        `${prefix}help  显示这条帮助`,
    ].join('\n');
}
function isAdmin(userId, admins) {
    if (admins.length === 0)
        return true;
    return admins.includes(String(userId));
}
/** 提醒 id 的短码：让群友能念出来（完整 id 是 `r_xxx_yyy`，太长）。 */
function shortId(id) {
    return id.replace(/^r_/u, '').slice(-6);
}
/**
 * 把「`<时间> <正文>`」切开。
 *
 * 不能简单按第一个空格切：`2026-09-16 09:00 交作业` 的时间自己就带空格。
 * 这里从最长的前缀开始试，第一个能被 parseWhen 认出来的就是时间（parseWhen 整串锚定，
 * 带上正文一定失败，所以不会把正文吃进时间）。
 * @returns 切好的时间与正文；切不开返回 undefined。
 */
export function splitTimeAndSubject(text) {
    const value = text.trim();
    if (value === '')
        return undefined;
    const boundaries = [];
    for (let i = 1; i < value.length; i += 1) {
        if (/\s/u.test(value[i]))
            boundaries.push(i);
    }
    // 从后往前试：最长的前缀优先，这样 `2026-09-16 09:00` 整体先被认出来。
    for (const at of boundaries.reverse()) {
        const when = value.slice(0, at).trim();
        const subject = value.slice(at).trim();
        if (when === '' || subject === '')
            continue;
        if (parseWhen(when).ok)
            return { when, subject };
    }
    // 没有正文（只有时间）时也允许：调用方会提示补上「要提醒什么事」。
    if (parseWhen(value).ok)
        return { when: value, subject: '' };
    return undefined;
}
/**
 * 这些命令走「生图命令」处理：全员可用，额度按各人 QQ 算。
 * （画风列表、切生图模型、查额度都是只读或只影响自己。）
 */
function isImageCommand(name) {
    return [
        'styles', '画风', '预设', 'v5styles', 'v5画风', 'v4styles', 'v45画风', 'v4画风',
        'v5artist', 'v5画师串',
        'v5', '切v5', '切换v5', '用v5', 'v4', 'v45', 'v4.5', '切v4', '切v45', '切v4.5', '切入v4.5', '用v4.5',
        'quota', '生图额度', '余额', '点数',
        'save', '存画风', '存预设', 'del', '删画风',
    ].includes(name);
}
/**
 * 这些命令全员可用：提醒是「自己的事」、档案是「自己的记录」，
 * 让人人可用才说得通；真正影响别人的操作（改角色/模型/清空记忆）仍限管理员。
 */
function isPersonalCommand(name) {
    return [
        '提醒', '提醒我', '定时', '我的提醒', '提醒列表', '提醒取消', '取消提醒',
        'remind', 'remindlist', 'remindcancel',
        '回忆', '查档案', 'recall', '忘掉', 'forget',
    ].includes(name);
}
/** 命令分发器。 */
export class CommandHandler {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * 处理一条可能包含命令的消息。
     * @returns 已作为命令处理时返回 `true`（调用方不再走对话流程）。
     */
    async handleGroup(event, text) {
        const command = parseCommand(text, this.deps.prefix);
        if (command === undefined)
            return false;
        const groupId = String(event.group_id);
        // 生图 / 个人（提醒、档案）命令对全员开放：只读或只影响自己；
        // 其余管理命令仍限管理员。
        const reply = isImageCommand(command.name)
            ? await this.executeImage(command, String(event.user_id))
            : isPersonalCommand(command.name)
                ? await this.executePersonal(groupId, command, String(event.user_id))
                : !isAdmin(event.user_id, this.deps.admins)
                    ? '只有管理员能执行这个命令。'
                    : await this.execute(groupId, command, event);
        // 画风清单这种十几行的回复走合并转发，群里只占一条（见 forward.ts）。
        await deliverGroupText(this.deps.client, groupId, reply, {
            ...(this.deps.client.self === undefined ? {} : { selfId: this.deps.client.self }),
            nickname: this.deps.manager.characterNameOf(groupId),
        }, this.deps.logger).catch(() => { });
        return true;
    }
    /** 处理私聊命令。 */
    async handlePrivate(event, text) {
        const command = parseCommand(text, this.deps.prefix);
        if (command === undefined)
            return false;
        const scope = `private:${String(event.user_id)}`;
        const reply = isImageCommand(command.name)
            ? await this.executeImage(command, String(event.user_id))
            : isPersonalCommand(command.name)
                ? await this.executePersonal(scope, command, String(event.user_id))
                : !isAdmin(event.user_id, this.deps.admins)
                    ? '只有管理员能执行这个命令。'
                    : await this.execute(scope, command, event);
        await this.deps.client.sendPrivateMessage(event.user_id, [{ type: 'text', data: { text: reply } }]).catch(() => { });
        return true;
    }
    /**
     * 生图相关命令（画风/切模型/额度）：不走管理员门禁。
     * 这些命令只读或只影响自己的模型选择，额度也按各自的 QQ 算，全员可用。
     */
    async executeImage(command, userId) {
        const manager = this.deps.manager;
        const prefix = this.deps.prefix;
        const presets = manager.presetStore;
        switch (command.name) {
            case 'styles':
            case '画风':
            case '预设': {
                if (presets === undefined)
                    return '生图画风功能没开：先让管理员在设置页里打开生图。';
                // 跟随这个人当前的模型（与作者插件 `/nai presets` 一致）：
                // V4.5 时列 V4.5 预设，切到 V5 后列 V5 画风。
                const current = manager.modelOf(userId);
                return presets.render(current, command.args.join(' ').trim());
            }
            case 'v5styles':
            case 'v5画风':
                if (presets === undefined)
                    return '生图画风功能没开：先让管理员在设置页里打开生图。';
                return presets.render(V5_MODEL, command.args.join(' ').trim());
            case 'v4styles':
            case 'v45画风':
            case 'v4画风':
                if (presets === undefined)
                    return '生图画风功能没开：先让管理员在设置页里打开生图。';
                return presets.render(V4_MODEL, command.args.join(' ').trim());
            case 'v5artist':
            case 'v5画师串': {
                if (presets === undefined)
                    return '生图画风功能没开：先让管理员在设置页里打开生图。';
                const name = command.args.join(' ').trim();
                if (name === '')
                    return `用法：${prefix}V5画师串 <画风名>，例如 ${prefix}V5画师串 绝区零游戏风`;
                const preset = presets.list(V5_MODEL)[name];
                if (preset === undefined)
                    return `V5 画风「${name}」不存在。发 ${prefix}画风 看列表。`;
                if (preset.artist.trim() !== '') {
                    const from = presets.hasArtistOverride(name) ? '（来自设置页「画风预设」）' : '';
                    return `V5 画师串「${name}」：${from}\n${preset.artist}`;
                }
                return `V5 画师串「${name}」还没填。管理员在设置页「生图 → 画风预设」里给这个名字贴一条就行，`
                    + `或者先 ${prefix}切v5 再 ${prefix}存画风 ${name} <画师串>。`;
            }
            case 'v5':
            case '切v5':
            case '切换v5':
            case '用v5': {
                const policy = manager.modelPolicy;
                if (policy === undefined)
                    return '生图模型切换没开：先让管理员在设置页里打开生图。';
                policy.setModel(userId, V5_MODEL);
                return `已切换到 V5（5 点/张）。${policy.describe(userId)}\n想用哪个画风直接说，例如「绝区零游戏风的…」；发 ${prefix}画风 看全部画风。`;
            }
            case 'v4':
            case 'v45':
            case 'v4.5':
            case '切v4':
            case '切v45':
            case '切v4.5':
            case '切入v4.5':
            case '用v4.5': {
                const policy = manager.modelPolicy;
                if (policy === undefined)
                    return '生图模型切换没开：先让管理员在设置页里打开生图。';
                policy.setModel(userId, V4_MODEL);
                return `已切回 V4.5（1 点/张，不限张数）。发 ${prefix}画风 看 V5 画风，${prefix}预设 看 V4.5 预设。`;
            }
            case 'quota':
            case '生图额度':
            case '余额':
            case '点数': {
                const described = manager.describeImageQuota(userId);
                if (described === undefined)
                    return '生图额度功能没开：先让管理员在设置页里打开生图。';
                const balance = await manager.imageBalance();
                const lines = [described];
                if (balance !== undefined) {
                    lines.push(`账号剩余 ${String(balance.balance)} 点（V4.5 普通尺寸约 ${String(balance.balance)} 张，V5 约 ${String(Math.floor(balance.balance / 5))} 张）`);
                    if (balance.note !== '')
                        lines.push(`备注：${balance.note}`);
                }
                return lines.join('\n');
            }
            case 'save':
            case '存画风':
            case '存预设': {
                if (!isAdmin(userId, this.deps.admins))
                    return '只有管理员能存画风。';
                if (presets === undefined)
                    return '生图画风功能没开：先让管理员在设置页里打开生图。';
                const args = command.args;
                const name = args[0];
                const artist = args.slice(1).join(' ').trim();
                if (name === undefined || artist === '') {
                    return `用法：${prefix}存画风 <名字> <画师串>\n名字不能有空格；画师串可以带空格逗号。\n当前模型的画风会存进对应那份表（${prefix}切v5 后存的是 V5 画风）。`;
                }
                const model = manager.modelOf(userId);
                if (presets.isBuiltin(model, name))
                    return `「${name}」是内置画风，不能覆盖；换个名字存。`;
                const existed = presets.save(model, name, artist);
                const note = presets.hasArtistOverride(name)
                    ? `\n注意：设置页「画风预设」里也给「${name}」填过画师串，那里优先级更高，出图用的是那一条。`
                    : '';
                return `${existed ? '已更新' : '已存好'} ${model === V5_MODEL ? 'V5' : 'V4.5'} 画风「${name}」。${note}`;
            }
            case 'del':
            case '删画风': {
                if (!isAdmin(userId, this.deps.admins))
                    return '只有管理员能删画风。';
                if (presets === undefined)
                    return '生图画风功能没开：先让管理员在设置页里打开生图。';
                const name = command.args.join(' ').trim();
                if (name === '')
                    return `用法：${prefix}删画风 <名字>`;
                const model = manager.modelOf(userId);
                if (presets.isBuiltin(model, name))
                    return `「${name}」是内置画风，删不了。`;
                return presets.remove(model, name)
                    ? `已删掉${model === V5_MODEL ? 'V5' : 'V4.5'} 画风「${name}」。`
                    : `${model === V5_MODEL ? 'V5' : 'V4.5'} 画风「${name}」不存在。`;
            }
            default:
                return `未知命令「${command.name}」。\n${commandHelp(prefix)}`;
        }
    }
    /**
     * 个人命令（提醒 / 档案）：全员可用，都只影响自己。
     * @param scope - 会话键（群号或 `private:<QQ>`）；提醒就定在这个会话里。
     * @param userId - 发起人 QQ 号（提醒记在他名下，档案查的是他）。
     */
    async executePersonal(scope, command, userId) {
        const prefix = this.deps.prefix;
        const reminders = this.deps.reminders;
        const people = this.deps.people;
        switch (command.name) {
            case '提醒':
            case '提醒我':
            case 'remind': {
                if (reminders === undefined)
                    return '定时提醒没开（让管理员在设置页里打开）。';
                const rest = command.args.join(' ').trim();
                if (rest === '') {
                    return [
                        `用法：\`${prefix}提醒 <时间> <要提醒的事>\``,
                        '时间写法：`2026-09-16 09:00`、`2026-09-16`、`09:30`（过了就明天）、`+30m`、`3天后`。',
                        `例：\`${prefix}提醒 2026-09-16 09:00 交作业\`、\`${prefix}提醒 3天后 给她买礼物\``,
                        `要提醒别人：在事后面加 @某人，例如 \`${prefix}提醒 +30m 开会 @张三\`。`,
                    ].join('\n');
                }
                // 时间与正文的分界不固定：时间本身可能含空格（`2026-09-16 09:00`），
                // 所以从最长的前缀开始试，取第一个能被认出来的时间——parseWhen 是整串锚定的，
                // 带上正文必然解析失败，因此这样切不会误判。
                const split = splitTimeAndSubject(rest);
                if (split === undefined) {
                    return `时间没看懂：${parseWhen(rest).error}\n写法：\`${prefix}提醒 2026-09-16 09:00 交作业\``;
                }
                if (split.subject === '')
                    return `要提醒什么事？比如 \`${prefix}提醒 ${split.when} 交作业\``;
                const parsed = parseWhen(split.when);
                if (!parsed.ok)
                    return `时间没看懂：${parsed.error}`;
                const subject = split.subject;
                try {
                    const item = reminders.create({
                        text: subject,
                        dueAt: parsed.at,
                        chatKey: scope,
                        creatorId: userId,
                        creatorName: '',
                    });
                    const date = new Date(item.dueAt);
                    return `好，${String(date.getMonth() + 1)}月${String(date.getDate())}日 `
                        + `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} 提醒你「${item.text}」。`;
                }
                catch (error) {
                    if (error instanceof ReminderError)
                        return error.message;
                    throw error;
                }
            }
            case '我的提醒':
            case '提醒列表':
            case 'remindlist': {
                if (reminders === undefined)
                    return '定时提醒没开。';
                const items = reminders.list({ chatKey: scope, status: 'pending,running' });
                if (items.length === 0)
                    return '这个会话里没有挂着的提醒。';
                const lines = [`这个会话挂着 ${String(items.length)} 条提醒：`];
                for (const item of items) {
                    lines.push(`- [${shortId(item.id)}] ${describeReminder(item)}`);
                }
                lines.push(`取消：\`${prefix}提醒取消 <编号>\``);
                return lines.join('\n');
            }
            case '提醒取消':
            case '取消提醒':
            case 'remindcancel': {
                if (reminders === undefined)
                    return '定时提醒没开。';
                const key = command.args.join('').trim();
                if (key === '') {
                    const items = reminders.list({ chatKey: scope, status: 'pending,running' });
                    if (items.length === 0)
                        return '这个会话里没有挂着的提醒。';
                    return `要取消哪条？\n${items.map(item => `- [${shortId(item.id)}] ${describeReminder(item)}`).join('\n')}`;
                }
                const hit = reminders.list({ chatKey: scope, status: 'pending,running' })
                    .find(item => item.id.endsWith(key) || shortId(item.id) === key);
                if (hit === undefined)
                    return `没找到编号 ${key} 的提醒。发 \`${prefix}我的提醒\` 看列表。`;
                reminders.cancel(hit.id);
                return `已取消：「${hit.text}」。`;
            }
            case '回忆':
            case '查档案':
            case 'recall': {
                if (people === undefined)
                    return '群友档案没开（让管理员在设置页里打开）。';
                const query = command.args.join(' ').trim();
                if (query === '')
                    return `用法：\`${prefix}回忆 <关键词或QQ号>\``;
                const found = people.search({ query, chatKey: scope, limit: 8 });
                if (found.people.length === 0 && found.events.length === 0)
                    return `没查到这个会话相关的记录（「${query}」）。`;
                const lines = [`关于「${query}」我记着的：`];
                for (const person of found.people) {
                    lines.push(`${person.name === '' ? `QQ ${person.userId}` : `${person.name}（${person.userId}）`}`);
                    for (const fact of person.facts)
                        lines.push(`  · ${fact.content}`);
                }
                for (const event of found.events)
                    lines.push(`· [${event.kind}] ${event.text}（${event.from}）`);
                return lines.join('\n');
            }
            case '忘掉':
            case 'forget': {
                if (people === undefined)
                    return '群友档案没开。';
                const what = command.args.join(' ').trim();
                if (what === '')
                    return `用法：\`${prefix}忘掉 <印象内容>\`\n（只删你自己的档案；也可以直接跟角色说「这事翻篇了」。）`;
                const removed = people.forgetFact(userId, { content: what });
                return removed ? `忘掉了：「${what}」。` : `档案里没有「${what}」这条印象。`;
            }
            default:
                return commandHelp(prefix);
        }
    }
    async execute(scope, command, event) {
        const manager = this.deps.manager;
        const prefix = this.deps.prefix;
        switch (command.name) {
            case 'help':
            case 'h':
                return commandHelp(prefix);
            case 'card':
            case '角色': {
                const target = command.args[0];
                if (target === undefined) {
                    const current = manager.resolveConfig(scope).characterId;
                    return `当前角色：${current}\n用法：${prefix}card <角色id>`;
                }
                return manager.setCharacter(scope, target);
            }
            case 'model':
            case '模型': {
                const target = command.args[0];
                if (target === undefined) {
                    const config = manager.resolveConfig(scope);
                    return `当前模型：${config.provider} / ${config.model}\n用法：${prefix}model <model> 或 ${prefix}model <provider>/<model>`;
                }
                const slash = target.indexOf('/');
                if (slash > 0) {
                    return manager.setModel(scope, target.slice(0, slash), target.slice(slash + 1));
                }
                return manager.setModel(scope, undefined, target);
            }
            case 'status':
            case '状态':
                return manager.status(scope);
            case 'reset':
            case '重置':
                return manager.reset(scope);
            case 'collect':
            case '收藏':
                return await this.collect(event, command.args[0]);
            case 'stickers':
            case '表情': {
                const library = this.deps.stickers;
                if (library === undefined || !library.enabled) {
                    return '表情包功能没开：在设置页「表情包」里打开，并把图片放进表情目录。';
                }
                const names = library.names();
                return names.length === 0
                    ? `表情库是空的。用法：回复一张图发 ${prefix}收藏 <名字>`
                    : `共 ${String(library.count)} 个表情：${names.join('、')}\n用法：${prefix}收藏 <名字>（回复要收藏的图）`;
            }
            case 'draw':
            case '生图':
            case '画图':
                return this.draw(scope, command.args, String(event.user_id));
            default:
                return `未知命令「${command.name}」。\n${commandHelp(prefix)}`;
        }
    }
    /** `.生图 <画面标签>`：直接让机器人画一张，画好自己发到当前会话。 */
    draw(scope, args, userId) {
        const manager = this.deps.manager;
        if (!manager.imageGenEnabled) {
            return '生图功能没开：在设置页「生图」里打开并填上密钥。';
        }
        // 画图要花点数：不在发言白名单里的群/人，命令也不给画，免得在别处被白嫖。
        if (!manager.isAllowed(scope)) {
            return '这个群/人不在机器人的发言范围里，先让管理员在设置页里放开。';
        }
        const prompt = args.join(' ').trim();
        if (prompt === '') {
            return `用法：${this.deps.prefix}生图 <画面标签>，例如 ${this.deps.prefix}生图 1girl, silver hair, smile\n`
                + `标签用英文逗号分隔；能加 -p <画风名> 指定画风，例如 ${this.deps.prefix}生图 1girl, cat ears -p 绝区零游戏风\n`
                + `画一张要好几分钟，画好会直接发出来；发 ${this.deps.prefix}画风 看全部画风。`;
        }
        const result = manager.requestImage(scope, prompt, userId);
        if (result.error !== undefined)
            return result.error;
        return result.queued
            ? '好，开始画了。画一张要好几分钟，出来我直接发出来。'
            : '生图功能没开：在设置页「生图」里打开并填上密钥。';
    }
    /** `.收藏 [名字]`：把一张图存进表情库。 */
    async collect(event, rawName) {
        const library = this.deps.stickers;
        if (library === undefined || !library.enabled) {
            return '表情包功能没开：在设置页「表情包」里打开，并把图片放进表情目录。';
        }
        const segments = await resolveImageSegments(this.deps.client, event);
        const image = segments[0];
        if (image === undefined) {
            return `没找到图片。用法：回复一张图发 ${this.deps.prefix}收藏 <名字>`;
        }
        const downloaded = await downloadImage(this.deps.client, { file: image.data.file, url: image.data.url }, 8 * 1024 * 1024, this.deps.logger);
        if (downloaded === undefined)
            return '这张图取不回来（太大或链接失效），换一张试试。';
        const name = library.save(rawName ?? '', downloaded.buffer, downloaded.mime);
        return `已收藏「${name}」，表情库现在有 ${String(library.count)} 个。`;
    }
}
