/**
 * 今日老婆（移植自 AstrBot 插件 astrbot_plugin_wifepicker）：
 * 从最近发言过的群友里抽一位「今日老婆」，附带强娶、分手与被强娶排行。
 *
 * 与原插件的差异（适配 dsh 群友插件）：
 * - 命令对所有群友开放，不走管理员门禁；带 `.` 前缀或直接发关键词都行
 *   （关键词按整句匹配，避免聊天里顺嘴提到「今日老婆」误触发）；
 * - 排行榜用纯文字呈现（原版渲染 HTML 长图，dsh 插件零依赖不渲染）；
 * - 不做自动撤回、求婚与挑选老婆（原版的多步交互流程），只保留核心玩法。
 *
 * 活跃池：每条群消息记录一次发言时间，只有 `activeDays` 天内说过话、
 * 且当前还在群里的人才会被抽到（每次抽取前拉一遍群成员列表过滤退群者）。
 */
import { mkdirSync } from 'node:fs';
import { DebouncedJsonFile, readJsonFile, writeJsonFile } from "./store.js";
/** 无状态时给一份空结构。 */
function emptyState() {
    return { groups: {} };
}
/** 命令 → 玩法路由（无前缀关键词与带前缀命令共用）。 */
const KEYWORD_ROUTES = [
    { keywords: ['今日老婆', '抽老婆', 'jrlp', 'dailywife', 'wife'], action: 'draw' },
    { keywords: ['我的老婆', '抽取历史', 'wdlp', 'mywife'], action: 'history' },
    { keywords: ['强娶', 'qiangqu', 'forcemarry'], action: 'force' },
    { keywords: ['分手', '离婚', 'fs', 'breakup'], action: 'breakup' },
    { keywords: ['rbq排行', 'rbqph', 'wifeleaderboard'], action: 'rank' },
    { keywords: ['抽老婆帮助', '老婆插件帮助', 'clpbz', 'wifehelp'], action: 'help' },
];
const DAY_MS = 86_400_000;
/** 排行榜只统计近 30 天。 */
const RANK_WINDOW_MS = 30 * DAY_MS;
/** 把秒数格式化成「x天x小时x分」。 */
function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (days > 0)
        return `${days}天${hours}小时${minutes}分`;
    if (hours > 0)
        return `${hours}小时${minutes}分`;
    if (minutes > 0)
        return `${minutes}分${totalSeconds % 60}秒`;
    return `${totalSeconds}秒`;
}
/** QQ 头像地址（协议端拿到 URL 会自己下载上传）。 */
function avatarUrl(qq) {
    return `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`;
}
function textSegment(text) {
    return { type: 'text', data: { text } };
}
function atSegment(qq) {
    return { type: 'at', data: { qq } };
}
function imageSegment(url) {
    return { type: 'image', data: { file: url } };
}
/** 今日老婆玩法。 */
export class WifeGame {
    client;
    logger;
    settings;
    stateFile;
    state;
    /** 群成员显示名缓存（群号 → QQ → 名字），每条消息顺手更新。 */
    names = new Map();
    constructor(deps) {
        this.client = deps.client;
        this.logger = deps.logger;
        this.settings = deps.settings;
        try {
            mkdirSync(deps.dir, { recursive: true });
        }
        catch {
            // 目录建不出来时写入侧会再失败一次并记日志，这里不必打断启动。
        }
        this.state = readJsonFile(`${deps.dir}/state.json`) ?? emptyState();
        this.state.groups ??= {};
        this.stateFile = new DebouncedJsonFile(`${deps.dir}/state.json`);
    }
    /** 卸载：落盘。 */
    dispose() {
        this.flush();
    }
    /** 立即落盘。 */
    flush() {
        this.stateFile.flush();
    }
    /** 每条群消息都调：记录活跃与名字，让抽取池保持新鲜。 */
    observe(event) {
        if (!this.settings.enabled)
            return;
        const groupId = String(event.group_id);
        const userId = String(event.user_id);
        const group = this.groupState(groupId);
        group.active[userId] = Date.now();
        const name = event.sender.card?.trim() !== '' && event.sender.card !== undefined
            ? event.sender.card
            : event.sender.nickname;
        if (name !== undefined && name !== '') {
            let groupNames = this.names.get(groupId);
            if (groupNames === undefined) {
                groupNames = new Map();
                this.names.set(groupId, groupNames);
            }
            groupNames.set(userId, name);
        }
        this.stateFile.schedule(this.state);
    }
    /**
     * 处理一条群消息（关键词或带前缀命令都在这里）。
     * @returns true = 已按今日老婆玩法消费，调用方不再往下分发。
     */
    async handleGroup(event, text, prefix) {
        if (!this.settings.enabled)
            return false;
        const action = this.matchAction(text, prefix);
        if (action === undefined)
            return false;
        await this.execute(String(event.group_id), event, action);
        return true;
    }
    /** 帮助文本（`.老婆帮助` 与路由里的帮助关键词共用）。 */
    helpText() {
        return [
            '===== 🌸 今日老婆帮助 =====',
            '1. 【今日老婆 / 抽老婆】：随机抽一位今日老婆',
            `2. 【强娶 @某人】：强行更换今日老婆（冷却 ${this.settings.forceCooldownDays} 天）`,
            '3. 【我的老婆】：查看今天的抽取记录',
            '4. 【分手】：解除普通老婆关系（强娶的不行）',
            `   分手后 ${this.settings.breakupCooldownHours} 小时内不能再用`,
            '5. 【rbq排行】：近 30 天被强娶次数排行',
            `每人每天最多抽 ${this.settings.dailyLimit} 次；`,
            `只有 ${this.settings.activeDays} 天内发过言、且还在群里的人会被抽到。`,
        ].join('\n');
    }
    /** 把一条消息折算成玩法：先认前缀命令，再按整句认关键词。 */
    matchAction(text, prefix) {
        const trimmed = text.trim();
        if (trimmed.startsWith(prefix)) {
            const [name] = trimmed.slice(prefix.length).trim().split(/\s+/u);
            const command = name?.toLowerCase();
            if (command !== undefined && command !== '') {
                for (const route of KEYWORD_ROUTES) {
                    if (route.keywords.includes(command))
                        return route.action;
                }
            }
            return undefined;
        }
        if (!this.settings.keywordTrigger)
            return undefined;
        // 整句匹配：剥掉 @ 片段与空白后必须恰好等于关键词，避免聊天误触发。
        const bare = trimmed.replace(/@\S+/gu, '').replace(/\s+/gu, '');
        for (const route of KEYWORD_ROUTES) {
            if (route.keywords.some(keyword => keyword === bare))
                return route.action;
        }
        return undefined;
    }
    groupState(groupId) {
        let group = this.state.groups[groupId];
        const today = new Date().toISOString().slice(0, 10);
        if (group === undefined || group.date !== today) {
            // 跨天只清当日抽取记录，冷却与活跃池保留。
            group = {
                date: today,
                records: [],
                active: group?.active ?? {},
                forced: group?.forced ?? {},
                rbq: group?.rbq ?? {},
                breakup: group?.breakup ?? {},
            };
            this.state.groups[groupId] = group;
            this.stateFile.schedule(this.state);
        }
        return group;
    }
    displayName(groupId, userId, fallback = `QQ${userId}`) {
        const name = this.names.get(groupId)?.get(userId);
        return name !== undefined && name !== '' ? name : fallback;
    }
    async execute(groupId, event, action) {
        try {
            const segments = action === 'draw'
                ? await this.draw(groupId, event)
                : action === 'history'
                    ? this.history(groupId, event)
                    : action === 'force'
                        ? await this.force(groupId, event)
                        : action === 'breakup'
                            ? this.breakup(groupId, event)
                            : action === 'rank'
                                ? await this.rank(groupId)
                                : [textSegment(this.helpText())];
            if (segments.length > 0) {
                await this.client.sendGroupMessage(groupId, segments);
            }
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 今日老婆玩法执行失败（%s %s）: %s', action, groupId, String(error));
        }
    }
    /** 抽今日老婆。 */
    async draw(groupId, event) {
        const group = this.groupState(groupId);
        const userId = String(event.user_id);
        const selfId = this.client.self === undefined ? '' : String(this.client.self);
        const usedToday = group.records.filter(record => record.userId === userId);
        if (usedToday.length >= this.settings.dailyLimit) {
            const wife = usedToday[0];
            if (wife === undefined)
                return [textSegment('你今天已经抽过老婆了，明天再来吧！')];
            const name = this.displayName(groupId, wife.wifeId, wife.wifeName);
            return [
                atSegment(userId),
                textSegment(` 你今天已经有老婆了哦❤️~\n她是：【${name}】\n`),
                imageSegment(avatarUrl(wife.wifeId)),
            ];
        }
        // 活跃池：清掉过期发言后，与当前群成员列表取交集（顺便清掉退群的人）。
        const now = Date.now();
        const activeLimit = Math.min(30, Math.max(1, this.settings.activeDays)) * DAY_MS;
        for (const [uid, ts] of Object.entries(group.active)) {
            if (uid === '0' || now - ts > activeLimit)
                delete group.active[uid];
        }
        let memberIds;
        let memberNames;
        try {
            const members = await this.client.call('get_group_member_list', { group_id: Number(groupId) });
            memberIds = members.map(member => String(member.user_id));
            memberNames = new Map(members.map(member => [
                String(member.user_id),
                (member.card?.trim() || member.nickname || '').trim(),
            ]));
        }
        catch {
            // 拉不到成员列表就用活跃池兜底（可能抽到已退群的人，可接受）。
        }
        const excluded = new Set(['0', userId, ...(this.client.self === undefined ? [] : [selfId])]);
        for (const uid of this.settings.excludedUsers)
            excluded.add(uid.trim());
        const pool = Object.keys(group.active).filter((uid) => {
            if (excluded.has(uid))
                return false;
            if (memberIds !== undefined && !memberIds.includes(uid))
                return false;
            return uid !== selfId;
        });
        if (memberIds !== undefined) {
            for (const uid of Object.keys(group.active)) {
                if (!memberIds.includes(uid))
                    delete group.active[uid];
            }
            this.stateFile.schedule(this.state);
        }
        if (pool.length === 0) {
            return [textSegment(`老婆池为空（需要有人在 ${this.settings.activeDays} 天内发过言）。`)];
        }
        const wifeId = pool[Math.floor(Math.random() * pool.length)] ?? '0';
        const cachedName = this.displayName(groupId, wifeId);
        const wifeName = memberNames?.get(wifeId) || cachedName;
        this.logger.info('qq-groupmate: 今日老婆 %s/%s 抽中 %s（%s）', groupId, userId, wifeId, wifeName);
        group.records.push({
            userId,
            wifeId,
            wifeName,
            time: new Date().toISOString(),
        });
        this.stateFile.schedule(this.state);
        const segments = [
            atSegment(userId),
            textSegment(` 你的今日老婆是：\n\n【${wifeName}】（${wifeId}）\n`),
        ];
        if (this.settings.atWife)
            segments.push(atSegment(wifeId), textSegment(' '));
        segments.push(imageSegment(avatarUrl(wifeId)), textSegment(`\n请好好对待她哦❤️~\n今日剩余抽取次数：${String(Math.max(0, this.settings.dailyLimit - usedToday.length - 1))}次`));
        return segments;
    }
    /** 我的老婆：今天的抽取记录。 */
    history(groupId, event) {
        const group = this.groupState(groupId);
        const userId = String(event.user_id);
        const records = group.records.filter(record => record.userId === userId);
        if (records.length === 0)
            return [textSegment('你今天还没有抽过老婆哦~')];
        const lines = records.map((record, index) => {
            const name = this.displayName(groupId, record.wifeId, record.wifeName);
            const time = new Date(record.time).toLocaleTimeString('zh-CN', { hour12: false, timeStyle: 'short' });
            return `${index + 1}. 【${name}】（${time}${record.forced === true ? '，强娶' : ''}）`;
        });
        return [
            atSegment(userId),
            textSegment(` 🌸 你今日的老婆记录（${records.length}/${this.settings.dailyLimit}）：\n${lines.join('\n')}\n剩余次数：${String(Math.max(0, this.settings.dailyLimit - records.length))}次`),
        ];
    }
    /** 从消息段里取强娶目标：第一个不是自己、不是机器人的 @。 */
    resolveForceTarget(event) {
        const selfId = this.client.self === undefined ? '' : String(this.client.self);
        const senderId = String(event.user_id);
        for (const segment of event.message) {
            if (segment.type !== 'at')
                continue;
            const qq = String(segment.data.qq ?? '');
            if (qq === '' || qq === 'all')
                continue;
            if (qq !== selfId && qq !== senderId)
                return qq;
        }
        return undefined;
    }
    /** 强娶 @某人：顶掉今天的记录并进入冷却。 */
    async force(groupId, event) {
        const group = this.groupState(groupId);
        const userId = String(event.user_id);
        const now = Date.now();
        const cooldownMs = Math.max(0, this.settings.forceCooldownDays) * DAY_MS;
        const lastForced = group.forced[userId];
        if (lastForced !== undefined && cooldownMs > 0) {
            const remaining = lastForced + cooldownMs - now;
            if (remaining > 0) {
                const resetAt = new Date(lastForced + cooldownMs);
                return [atSegment(userId), textSegment(` 你已经强娶过啦！\n请等待：${formatDuration(remaining)}后再试。\n(重置时间：${resetAt.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })})`)];
            }
        }
        const targetId = this.resolveForceTarget(event);
        if (targetId === undefined)
            return [textSegment('请 @ 一个你想强娶的人。')];
        if (targetId === userId)
            return [textSegment('不能娶自己！')];
        const selfId = this.client.self === undefined ? '' : String(this.client.self);
        if (targetId === selfId)
            return [textSegment('不能娶本机器人哦。')];
        if (this.settings.excludedUsers.includes(targetId))
            return [textSegment('该用户在强娶排除列表中，无法被强娶。')];
        // 名字尽量用群成员接口的群名片，拉不到再用消息里的缓存。
        let targetName = this.displayName(groupId, targetId);
        try {
            const member = await this.client.getGroupMemberInfo(groupId, targetId);
            const card = (member.card?.trim() || member.nickname || '').trim();
            if (card !== '')
                targetName = card;
        }
        catch {
            // 拉不到就沿用缓存名。
        }
        const timestamp = new Date().toISOString();
        // 顶掉今天自己原有的记录（强娶 = 更换今日老婆）。
        group.records = group.records.filter(record => record.userId !== userId);
        group.records.push({ userId, wifeId: targetId, wifeName: targetName, time: timestamp, forced: true });
        group.forced[userId] = now;
        const rbqList = group.rbq[targetId] ?? [];
        rbqList.push(now);
        group.rbq[targetId] = rbqList.filter(ts => now - ts < RANK_WINDOW_MS);
        this.stateFile.schedule(this.state);
        this.logger.info('qq-groupmate: 强娶 %s/%s → %s（%s）', groupId, userId, targetId, targetName);
        return [
            atSegment(userId),
            textSegment(` 你今天强娶了【${targetName}】哦❤️~\n请对她好一点哦~。\n`),
            imageSegment(avatarUrl(targetId)),
        ];
    }
    /** 分手：解除今天的普通（非强娶）老婆关系。 */
    breakup(groupId, event) {
        const group = this.groupState(groupId);
        const userId = String(event.user_id);
        const now = Date.now();
        const cooldownMs = Math.max(0, this.settings.breakupCooldownHours) * 3_600_000;
        const lastBreakup = group.breakup[userId];
        if (lastBreakup !== undefined && cooldownMs > 0) {
            const remaining = lastBreakup + cooldownMs - now;
            if (remaining > 0) {
                return [textSegment(`你还在分手冷却期内，请等待 ${formatDuration(remaining)} 后再试。`)];
            }
        }
        const mine = group.records.filter(record => record.userId === userId);
        if (mine.length === 0)
            return [textSegment('你现在还没有老婆，无法分手哦。')];
        const ordinary = mine.filter(record => record.forced !== true);
        if (ordinary.length === 0)
            return [textSegment('强娶的老婆不能分手！')];
        const names = ordinary.map(record => `【${this.displayName(groupId, record.wifeId, record.wifeName)}】`);
        group.records = group.records.filter(record => !(record.userId === userId && record.forced !== true));
        group.breakup[userId] = now;
        this.stateFile.schedule(this.state);
        return [textSegment(`你已经和${names.join('、')}分手了。分手指令将在 ${this.settings.breakupCooldownHours} 小时后恢复使用。`)];
    }
    /** 被强娶排行（近 30 天，纯文字 Top10）。 */
    async rank(groupId) {
        const group = this.groupState(groupId);
        const now = Date.now();
        // 顺手清掉 30 天外的旧记录。
        for (const [uid, list] of Object.entries(group.rbq)) {
            const fresh = list.filter(ts => now - ts < RANK_WINDOW_MS);
            if (fresh.length === 0)
                delete group.rbq[uid];
            else
                group.rbq[uid] = fresh;
        }
        this.stateFile.schedule(this.state);
        const rows = Object.entries(group.rbq)
            .map(([uid, list]) => ({ uid, count: list.length }))
            .filter(row => row.count > 0)
            .sort((left, right) => right.count - left.count)
            .slice(0, 10);
        if (rows.length === 0) {
            return [textSegment('本群近30天还没有人被强娶过，大家都很有礼貌呢。')];
        }
        // 逐个补名字：排行靠前的几个人值得一次群成员查询，失败就退回缓存名。
        const lines = [];
        let rank = 0;
        let lastCount = Number.NaN;
        for (const [index, row] of rows.entries()) {
            if (row.count !== lastCount) {
                rank = index + 1;
                lastCount = row.count;
            }
            let name = this.displayName(groupId, row.uid);
            try {
                const member = await this.client.getGroupMemberInfo(groupId, row.uid);
                const card = (member.card?.trim() || member.nickname || '').trim();
                if (card !== '')
                    name = card;
            }
            catch {
                // 拉不到就沿用缓存名。
            }
            lines.push(`${rank}. ${name}（${row.uid}）— 被强娶 ${row.count} 次`);
        }
        return [textSegment(`❤️ 群rbq月榜 ❤️\n${'─'.repeat(16)}\n${lines.join('\n')}`)];
    }
}
/** 供自测与配置解析用的默认设置。 */
export function defaultWifeSettings() {
    return {
        enabled: true,
        dailyLimit: 1,
        activeDays: 30,
        atWife: true,
        keywordTrigger: true,
        excludedUsers: [],
        forceCooldownDays: 3,
        breakupCooldownHours: 72,
    };
}
/** 导出给测试：把状态原样写盘（避免测试里等防抖）。 */
export function writeWifeStateForTest(dir, state) {
    writeJsonFile(`${dir}/state.json`, state);
}
