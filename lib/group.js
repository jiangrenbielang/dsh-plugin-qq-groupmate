/**
 * 群会话管理（编排者）：配置解析、命令方法、状态/快照、事件处理与模型调用。
 * 每个群维护独立的角色、模型与历史，实现"独立模型切换"。
 * 历史/状态的形状、触发判断、出站发送分别拆到 history.ts / trigger.ts / outbound.ts。
 */
import { createHash } from 'node:crypto';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createModelResolver } from "./models.js";
import { memoryScopeOf, speakerLabel, trimHistory } from "./history.js";
import { V4_MODEL, V5_MODEL } from "./nai-presets.js";
import { OutboundSender } from "./outbound.js";
import { buildLocalTimeReply } from "./local-routing.js";
import { buildContextBlock, buildNameGuidance, buildStableSystemPrompt, sanitizeReply } from "./prompt.js";
import { evaluateTrigger, extractMessage } from "./trigger.js";
import { chooseVoiceStyle, parseVoiceModeJson } from "./voice.js";
import { collectImages, fetchImages, noteImageRejection } from "./vision.js";
import { DebouncedJsonFile, readJsonFile } from "./store.js";
import { buildToolUsagePrompt, hasInformationalCalls, parseToolCalls, renderActionNotes, renderToolResults, MAX_TOOL_ROUNDS, } from "./agent-tools.js";
export { memoryScopeOf, speakerLabel, trimHistory } from "./history.js";
export { extractMessage } from "./trigger.js";
/** 文本指纹（sha1 前 8 位）：用来观察请求前缀有没有变，见 logCacheFingerprint。 */
function fingerprint(text) {
    return createHash('sha1').update(text).digest('hex').slice(0, 8);
}
/** 群会话管理器。 */
export class GroupManager {
    llm;
    client;
    logger;
    characters;
    defaults;
    overrides;
    models;
    chatBackup;
    outbound;
    state;
    stateFile;
    memory;
    summaries;
    vision;
    stickers;
    imageGen;
    presets;
    policy;
    knowledge;
    learner;
    weather;
    notes;
    voice;
    desktop;
    people;
    tools;
    /** 每个群正在生成回复时置位，避免并发调用模型。 */
    busy = new Set();
    lastReplyAt = new Map();
    lastRandomAt = new Map();
    /** 距离上次叫对方名字已经过了几条回复（称呼概率规则用）。 */
    repliesSinceNameOffered = new Map();
    /** 日文语音模式下：本次要合成的日文文本（群友看到的中文另存）。见 voice.js 的 parseVoiceModeJson。 */
    pendingSpeech = new Map();
    disposed = false;
    constructor(deps) {
        this.llm = deps.llm;
        this.client = deps.client;
        this.logger = deps.logger;
        this.characters = deps.characters;
        this.defaults = deps.defaults;
        this.overrides = deps.overrides;
        // 没给解析器（自测里的简写构造）时退化成「只认 provider/model 写法」。
        this.models = deps.models ?? createModelResolver({
            presets: [],
            defaultModel: { provider: deps.defaults.provider, model: deps.defaults.model },
            isKnownProvider: id => deps.llm.listProviders().some(item => item.id === id),
        });
        this.chatBackup = deps.chatBackup?.trim() === '' ? undefined : deps.chatBackup?.trim();
        this.outbound = new OutboundSender({
            client: deps.client,
            logger: deps.logger,
            outboundFilter: deps.outboundFilter,
            stickers: deps.stickers,
            imageGenClient: deps.imageGen,
            nativeVoice: deps.nativeVoice,
            presets: deps.presets,
            policy: deps.policy,
            senderName: (scopeKey) => this.characterNameOf(scopeKey),
        });
        this.imageGen = deps.imageGen;
        this.presets = deps.presets;
        this.policy = deps.policy;
        this.state = readJsonFile(deps.statePath) ?? { groups: {} };
        this.state.groups ??= {};
        this.stateFile = new DebouncedJsonFile(deps.statePath);
        this.memory = deps.memory;
        this.summaries = deps.summaries;
        this.vision = deps.vision;
        this.stickers = deps.stickers;
        this.knowledge = deps.knowledge;
        this.learner = deps.learner;
        this.weather = deps.weather;
        this.notes = deps.notes;
        this.voice = deps.voice;
        this.desktop = deps.desktop;
        this.people = deps.people;
        this.tools = deps.tools;
        // 原声台词库（游戏配音 / 补音包）：提示词里要列出可用关键词，发送时按关键词取音频。
        this.nativeVoice = deps.nativeVoice;
        // 分层记忆（归档 + 检索）：记忆不再每轮注入，模型用 [回忆:] 主动翻旧账。
        this.recall = deps.recall;
    }
    /** 卸载：落盘并停止接受新事件。 */
    dispose() {
        this.disposed = true;
        this.stateFile.flush();
        this.summaries?.dispose();
        // 学习画像走 1.5 秒防抖落盘：不 dispose 的话刚更新完就退出 dsh 会丢掉这段窗口内的改动。
        this.learner?.dispose();
        // 写信调度器停掉，在飞的生成一并中断。
        this.notes?.dispose();
        // 档案同样走 1.5 秒防抖落盘：不 flush 的话刚记下的印象会丢在退出窗口里。
        this.people?.flush();
        // 还在排队的生图任务一并清掉，别在插件卸载后继续往群里发图。
        this.outbound.dispose();
    }
    /** 事件入口。 */
    handleEvent(event) {
        if (this.disposed)
            return;
        if (event.post_type !== 'message')
            return;
        if (event.message_type === 'group') {
            void this.handleGroupMessage(event);
            return;
        }
        if (event.message_type === 'private' && this.defaults.privateChat) {
            void this.handlePrivateMessage(event);
        }
    }
    /** 查询某个群当前生效的运行参数。 */
    resolveConfig(groupId) {
        const override = this.overrides[groupId];
        const record = this.state.groups[groupId];
        const characterId = record?.characterId ?? override?.character ?? this.defaults.characterId;
        const card = this.characters.get(characterId);
        const triggerPrefixes = override?.prefixes ?? this.defaults.prefixes;
        const cardPrefixes = card?.trigger?.prefixes ?? [];
        // 模型：先把「命令 / 群配置 / 角色卡 / 默认」拼成原始引用，再交给解析器
        //（引用可以是模型配置名，也可以是 `服务商id/模型名` 或裸模型名）。
        const rawProvider = record?.provider ?? override?.provider ?? card?.provider ?? this.defaults.provider;
        const rawModel = record?.model ?? override?.model ?? card?.model ?? this.defaults.model;
        const { provider, model } = this.models.resolve(rawModel, { provider: rawProvider, model: rawModel });
        // 备用模型：群配置优先，其次群聊槽的全局备用；跟主模型相同就不启用。
        const backupRef = override?.backup?.trim() === '' ? undefined : (override?.backup ?? this.chatBackup);
        const backup = backupRef?.trim() === '' || backupRef === undefined
            ? undefined
            : this.models.resolve(backupRef, { provider, model });
        const effectiveBackup = backup !== undefined && (backup.provider !== provider || backup.model !== model)
            ? backup
            : undefined;
        return {
            enabled: override?.enabled !== false,
            characterId,
            provider,
            model,
            ...(effectiveBackup === undefined ? {} : { backup: effectiveBackup }),
            temperature: override?.temperature ?? card?.temperature ?? this.defaults.temperature,
            maxTokens: override?.maxTokens ?? card?.maxTokens ?? this.defaults.maxTokens,
            mention: override?.mention ?? card?.trigger?.mention ?? this.defaults.mention,
            prefixes: [...triggerPrefixes, ...cardPrefixes],
            randomChance: override?.randomChance ?? card?.trigger?.randomChance ?? this.defaults.randomChance,
            cooldownSeconds: this.defaults.cooldownSeconds,
            randomCooldownSeconds: this.defaults.randomCooldownSeconds,
            replyToSelf: this.defaults.replyToSelf,
            maxTurns: this.defaults.maxTurns,
            maxChars: this.defaults.maxChars,
        };
    }
    /** 命令：切换角色。 */
    setCharacter(groupId, characterId) {
        if (!this.characters.has(characterId)) {
            const available = [...this.characters.keys()].join('、');
            return `没有找到角色卡「${characterId}」。可用：${available === '' ? '（无）' : available}`;
        }
        this.record(groupId).characterId = characterId;
        this.persist();
        return `已把本群角色切换为「${this.characters.get(characterId)?.name ?? characterId}」`;
    }
    /** 命令：切换模型。 */
    setModel(groupId, provider, model) {
        const record = this.record(groupId);
        if (provider !== undefined)
            record.provider = provider;
        record.model = model;
        this.persist();
        const effective = this.resolveConfig(groupId);
        return `已把本群模型切换为 ${effective.provider} / ${effective.model}`;
    }
    /** 命令：清空本群上下文。 */
    reset(groupId) {
        const record = this.record(groupId);
        const count = record.history.length;
        record.history = [];
        record.greetingDone = true;
        this.persist();
        this.memory?.clear(memoryScopeOf(groupId));
        this.summaries?.clear(groupId);
        return `已清空本群上下文（${String(count)} 条记录）`;
    }
    /** 命令：查看状态。 */
    status(groupId) {
        const config = this.resolveConfig(groupId);
        const card = this.characters.get(config.characterId);
        const history = this.record(groupId).history.length;
        return [
            `角色：${card?.name ?? config.characterId}（${config.characterId}）`,
            `模型：${config.provider} / ${config.model}`,
            `上下文：${String(history)} 条记录（上限 ${String(config.maxTurns)} 条 / ${String(config.maxChars)} 字）`,
            `触发：${config.mention ? '@' : ''}${config.prefixes.length > 0 ? ` 前缀 ${config.prefixes.join(' ')}` : ''}${config.randomChance > 0 ? ` 随机 ${String(Math.round(config.randomChance * 100))}%` : ''}` || '仅命令',
            `连接：${this.client.isConnected ? '正常' : '断开'}${this.client.self === undefined ? '' : `（QQ ${String(this.client.self)}）`}`,
        ].join('\n');
    }
    /** 全局状态摘要，供会话内 `/qq` 使用。 */
    globalStatus() {
        const config = this.resolveConfig('__global__');
        const card = this.characters.get(config.characterId);
        const groups = Object.keys(this.state.groups).filter(key => !key.startsWith('private:'));
        return [
            `连接：${this.client.isConnected ? '正常' : '断开'}${this.client.self === undefined ? '' : `（QQ ${String(this.client.self)}）`}`,
            `默认角色：${card?.name ?? config.characterId}（${config.characterId}）`,
            `默认模型：${config.provider} / ${config.model}`,
            `已记录群：${String(groups.length)} 个`,
        ].join('\n');
    }
    /** 可用的模型服务商 id（设置页的模型配置下拉用）。 */
    providerIds() {
        return this.llm.listProviders().map(item => item.id);
    }
    /**
     * 拉取某个服务商可用的模型列表（设置页「模型配置 → 拉取」用）。
     * @param provider - 服务商 id：dsh 自带的 provider 或自定义 API 服务商。
     * @returns 模型 id 与可读名；不支持或请求失败时抛错。
     */
    async listModels(provider) {
        const list = this.llm.listModels;
        if (list === undefined)
            throw new Error('当前的 LLM 服务不支持拉取模型列表');
        return await list.call(this.llm, provider);
    }
    /** 可用角色卡 id 列表。 */
    characterIds() {
        return [...this.characters.keys()];
    }
    /**
     * 某个群/私聊当前用的角色名（转发卡片上显示的名字、日志里也用）。
     * @param scopeKey - 群号或 `private:<QQ号>`。
     */
    characterNameOf(scopeKey) {
        const config = this.resolveConfig(scopeKey);
        return this.characters.get(config.characterId)?.name ?? config.characterId;
    }
    /** 当前已知的群与私聊快照，供设置页渲染管理列表。 */
    snapshot() {
        const groups = [];
        const privateChats = [];
        for (const [key, record] of Object.entries(this.state.groups)) {
            const count = record.history?.length ?? 0;
            const summaries = this.summaries?.count(key) ?? 0;
            if (key.startsWith('private:')) {
                privateChats.push({ id: key.slice('private:'.length), messages: count, summaries });
                continue;
            }
            const config = this.resolveConfig(key);
            groups.push({ id: key, messages: count, summaries, character: config.characterId, model: config.model });
        }
        groups.sort((left, right) => Number(right.id) - Number(left.id));
        privateChats.sort((left, right) => Number(right.id) - Number(left.id));
        return { groups, privateChats };
    }
    /** 设置页按下「清空记忆」时调用：清空该群/私聊的内存与 Markdown 记录。 */
    resetMemory(scopeKey) {
        this.reset(scopeKey);
    }
    /**
     * 处理设置页写入的「清空记忆」令牌：只对没处理过的新令牌执行一次。
     * @param tokens - 群号 → 令牌（时间戳）。
     */
    applyResetTokens(tokens) {
        this.state.resetTokens ??= {};
        let changed = false;
        for (const [groupId, token] of Object.entries(tokens)) {
            if (this.state.resetTokens[groupId] === token)
                continue;
            this.state.resetTokens[groupId] = token;
            changed = true;
            this.reset(groupId);
        }
        if (changed)
            this.persist();
    }
    /** 各群记忆条数摘要。 */
    groupSummary() {
        const rows = Object.entries(this.state.groups)
            .filter(([key]) => !key.startsWith('private:'))
            .map(([key, record]) => {
            const config = this.resolveConfig(key);
            return `- ${key}：${String(record.history?.length ?? 0)} 条｜角色 ${config.characterId}｜模型 ${config.model}`;
        });
        if (rows.length === 0)
            return '还没有记录任何群。';
        return rows.join('\n');
    }
    /** 某个群最近若干条记忆（读 Markdown 文件，便于核对落盘内容）。 */
    memoryPreview(groupId, limit) {
        const scope = memoryScopeOf(groupId);
        const lines = this.memory?.tail(scope, limit) ?? [];
        if (lines.length === 0) {
            const count = this.record(groupId).history.length;
            return count === 0
                ? `群 ${groupId} 还没有记忆。`
                : `群 ${groupId} 有 ${String(count)} 条内存记录（记忆文件未启用或尚未写入）。`;
        }
        return [`群 ${groupId} 最近 ${String(lines.length)} 条：`, ...lines].join('\n');
    }
    /** 以机器人身份往群里发一条消息（测试连接用）。 */
    async say(groupId, text) {
        // 注意不能写 `?? text`：apply 返回 undefined 表示「拦下」，会被兜回原文。
        const filtered = this.outbound.filterText(text, groupId);
        if (filtered === undefined || filtered.trim() === '')
            throw new Error('内容含违禁词，已被出站过滤拦下');
        const result = await this.client.sendGroupMessage(groupId, [{ type: 'text', data: { text: filtered } }]);
        this.outbound.rememberSentId(groupId, result.message_id);
        const card = this.characters.get(this.resolveConfig(groupId).characterId);
        this.appendHistory(groupId, {
            role: 'assistant',
            speaker: card?.name ?? '机器人',
            text,
            time: Date.now(),
        });
    }
    /**
     * 投递一封 AI 信件：过滤后发到群里并记入历史。
     * @returns true = 已发送；false = 内容被出站过滤拦下（调用方应丢弃这封信，别重试）。
     */
    async deliverNote(groupId, text) {
        // 注意不能写 `?? text`：apply 返回 undefined 表示「拦下」。
        const filtered = this.outbound.filterText(text, groupId);
        if (filtered === undefined || filtered.trim() === '')
            return false;
        const card = this.characters.get(this.resolveConfig(groupId).characterId);
        const result = await this.client.sendGroupMessage(groupId, [{ type: 'text', data: { text: filtered } }]);
        this.outbound.rememberSentId(groupId, result.message_id);
        this.appendHistory(groupId, {
            role: 'assistant',
            speaker: card?.name ?? '机器人',
            text: filtered,
            time: Date.now(),
        });
        return true;
    }
    /** 这个群/私聊是否在发言白名单里（白名单为空表示不限制）。 */
    isAllowed(scope) {
        if (scope.startsWith('private:')) {
            const allow = this.defaults.allowUsers;
            return allow.length === 0 || allow.includes(scope.slice('private:'.length));
        }
        const allow = this.defaults.allowGroups;
        return allow.length === 0 || allow.includes(scope);
    }
    /** 生图能力是否可用（提示词与命令都看它）。 */
    get imageGenEnabled() {
        return this.outbound.imageGenEnabled;
    }
    /** 画风预设库（命令列表、群友报画风名用）；没配就是 undefined。 */
    get presetStore() {
        return this.presets;
    }
    /** 生图模型策略（切模型、查额度用）；没配就是 undefined。 */
    get modelPolicy() {
        return this.policy;
    }
    /**
     * 某个人当前用哪个生图模型。
     * 没显式切过就用设置页配的默认模型（`imageGen.model`），显式切过按他选的。
     */
    modelOf(userId) {
        const configured = this.imageGen?.settings.model;
        const fallback = configured === V5_MODEL ? V5_MODEL : V4_MODEL;
        return this.policy?.modelOf(userId, fallback) ?? fallback;
    }
    /** 生图服务账号余额（查点数用）；失败返回 undefined。 */
    async imageBalance() {
        return await this.imageGen?.checkAccount();
    }
    /** 某个人的生图模型与 V5 额度说明（`.生图额度` 命令用）。 */
    describeImageQuota(userId) {
        return this.outbound.describeQuota(userId);
    }
    /**
     * 提示词里列哪些画风名给模型看。
     *
     * 只列 V5 那套（含共用的画师预设）：名字短、群里最常用，作者插件的「群友快捷入口」
     * 也是这套；V4.5 预设名字多、画师串长，写进提示词太占地方（群友可以自己 `-p` 指定）。
     *
     * 上限给到 32：现在内置是 7 个画风 + 15 个画师预设 = 22 个（2026-09-14 加了两批画师），
     * 卡在 12/24 都会把后面几个画师名截掉、模型就不知道它们存在；
     * 而 32 也够挡住用户存了几十个自定义预设时把提示词撑爆。
     */
    imageStylesForPrompt() {
        const presets = this.presets;
        if (presets === undefined)
            return undefined;
        const names = Object.keys(presets.list(V5_MODEL)).filter(name => name !== '');
        return names.length === 0 ? undefined : names.slice(0, 32);
    }
    /**
     * 群友在消息里直接报画风名（作者插件的「群友快捷入口」）：
     * 「绝区零游戏风的亚托莉」这种句子不用 `-p`，模型画图时自动带上画风。
     *
     * 只在消息里出现已知画风名时生效，取最长匹配（避免「游戏风」抢走「绝区零游戏风」）；
     * V5 的画风名优先——两套表里重名时以 V5 为准（V5 画风是专属的）。
     *
     * 排除「…风格」这种通用说法（2026-09-14 修正）：画风名里有「游戏风」「高质量写实风」
     * 这类以「风」结尾的词，而「p3游戏风格的群主」里的「游戏风」只是「游戏风格」的一半——
     * 以前会把这句当成点了「游戏风」，还顺手把模型切成 V5，报一句莫名其妙的「画风不存在」。
     * 规则：匹配到之后紧跟一个「格」字的，不算点画风。
     *
     * @param text - 群友这条消息。
     * @returns 给生图用的覆盖项；没命中返回空对象。
     */
    styleHintOf(text) {
        const presets = this.presets;
        if (presets === undefined || text.trim() === '')
            return {};
        const v5 = presets.list(V5_MODEL);
        const v4 = presets.list('nai-diffusion-4-5-full');
        let hit = '';
        let model;
        for (const name of [...Object.keys(v5), ...Object.keys(v4)]) {
            if (name === '')
                continue;
            const at = text.indexOf(name);
            if (at < 0)
                continue;
            // 「…风格」：匹配后面跟着「格」的，是通用说法而不是画风名。
            if (text[at + name.length] === '格')
                continue;
            if (name.length > hit.length) {
                hit = name;
                // 只有 V5 专属的名字（7 个内置画风那种，只在 V5 表里）才顺带切模型；
                // 两套表共用的画师预设（裸画师名）不切，跟随这个人当前的模型。
                model = v5[name] !== undefined && v4[name] === undefined ? V5_MODEL : undefined;
            }
        }
        return hit === '' ? {} : { preset: hit, ...(model === undefined ? {} : { model }) };
    }
    /** 给自测用：暴露「群友报画风名」的匹配结果（`styleHintOf` 是私有的）。 */
    styleHintOfForTest(text) {
        return this.styleHintOf(text);
    }
    /**
     * 让生图队列后台画一张（群内 `.生图` 命令用）；画好会自己发到 `scope`。
     * @param scope - 群号或 `private:<QQ号>`。
     * @returns 生图功能没开时返回 `false`。
     */
    requestImage(scope, prompt, senderId = '') {
        const target = scope.startsWith('private:')
            ? { userId: scope.slice('private:'.length) }
            : { groupId: scope };
        const userId = senderId !== '' ? senderId : (scope.startsWith('private:') ? scope.slice('private:'.length) : '');
        return this.outbound.requestImage(target, prompt, {
            ...(userId === '' ? {} : { userId }),
        });
    }
    record(groupId) {
        let record = this.state.groups[groupId];
        if (record === undefined) {
            record = { history: [] };
            this.state.groups[groupId] = record;
        }
        record.history ??= [];
        // 旧数据没有 seq：按当前顺序补一遍，后续新记录从这里继续递增。
        if (record.nextSeq === undefined) {
            record.history.forEach((entry, index) => { entry.seq ??= index; });
            record.nextSeq = record.history.length;
        }
        return record;
    }
    persist() {
        this.stateFile.schedule(this.state);
    }
    appendHistory(groupId, entry) {
        const record = this.record(groupId);
        if (entry.seq === undefined) {
            entry.seq = record.nextSeq ?? record.history.length;
            record.nextSeq = entry.seq + 1;
        }
        record.history.push(entry);
        this.trimStoredHistory(groupId, record);
        this.persist();
        // 同步写一份人类可读记录到工作区，供直接翻看或让 agent 整理。
        this.memory?.append(memoryScopeOf(groupId), entry);
        // 顺手归档进分层记忆：按小时切块 + 本地索引，**不进提示词**，模型问旧事时才检索。
        this.recall?.append(groupId, entry);
    }
    /**
     * 落盘前的硬性裁剪：只丢「已经被总结记忆覆盖」的旧记录，
     * 否则活跃群会在总结跟上之前就把消息丢掉，那段记忆就再也补不回来了。
     */
    trimStoredHistory(groupId, record) {
        const limit = Math.max(this.defaults.maxTurns * 4, 200);
        if (record.history.length <= limit)
            return;
        const covered = this.summaries?.enabled === true
            ? this.summaries.coveredThroughSeq(groupId)
            : Number.MAX_SAFE_INTEGER;
        const firstUncovered = record.history.findIndex(item => (item.seq ?? 0) > covered);
        const coveredCount = firstUncovered < 0 ? record.history.length : firstUncovered;
        let trimCount = Math.min(record.history.length - limit, coveredCount);
        // 兜底：总结长时间跟不上时也不能无限涨，超出上限就按老规矩从最早的丢。
        const hardCap = limit * 6;
        if (record.history.length - trimCount > hardCap)
            trimCount = record.history.length - hardCap;
        if (trimCount > 0)
            record.history.splice(0, trimCount);
    }
    async handleGroupMessage(event) {
        const groupId = String(event.group_id);
        // 事件自带 self_id 优先：登录信息可能过期或还没返回（与 dispatch 的口径保持一致）。
        const selfId = event.self_id ?? this.client.self;
        if (event.user_id === selfId)
            return;
        const config = this.resolveConfig(groupId);
        if (!config.enabled)
            return;
        const { text, mentioned, replyTo } = extractMessage(event.message, selfId);
        if (text === '')
            return;
        const speaker = event.sender.card?.trim() !== '' && event.sender.card !== undefined
            ? event.sender.card
            : event.sender.nickname;
        const repliedToBot = replyTo !== undefined && this.outbound.hasSentId(groupId, replyTo);
        const card = this.characters.get(config.characterId);
        // 随机命中必须在这里算：只要 randomChance > 0，每条群消息恰好调用一次 Math.random()，
        // 且早于白名单过滤与历史写入；evaluateTrigger 只接收算好的结果，保证调用次数/顺序不变。
        const randomHit = config.randomChance > 0 && Math.random() < config.randomChance;
        this.appendHistory(groupId, { role: 'user', speaker, text, time: event.time * 1000, userId: String(event.user_id) });
        // 信件引擎旁听每条群消息：记录活跃时间（投递要等群里安静），并处理「取消/完成」的更新。
        this.notes?.observeGroupMessage(groupId, text, event.time * 1000);
        // 档案旁听：记下「这个人在这个群说过话」，并留一句表层记忆（别的会话 10 分钟内能看到）。
        this.people?.touchPerson(String(event.user_id), { name: speaker, chatKey: groupId, at: event.time * 1000 });
        this.people?.addSurface({
            userId: String(event.user_id),
            name: speaker,
            chatKey: groupId,
            text,
            at: event.time * 1000,
        });
        // 白名单：留空表示不限制；不在名单里的群照样记录消息（方便在设置页里加进来），但不发言。
        if (this.defaults.allowGroups.length > 0 && !this.defaults.allowGroups.includes(groupId))
            return;
        // 记忆改成「按小时归档 + 模型按需 [回忆:]」之后（见 recall.js），这里不再把旧对话压成摘要——
        // 摘要那套是「压好、每轮都塞进提示词」，既每轮花钱又把请求前缀搅乱；归档在 appendHistory 里已顺手完成。
        // 旧的总结实现与数据都留在磁盘上，想回退随时可以接回来。
        // 风格学习同样后台跑：攒够一批群友发言就提炼一次腔调画像。
        void this.learner?.maybeLearn(groupId, this.record(groupId).history, {
            provider: config.provider,
            model: config.model,
        });
        const facts = evaluateTrigger({
            text,
            mention: config.mention,
            mentioned,
            prefixes: config.prefixes,
            characterName: card?.name ?? '',
            aliases: card?.aliases ?? [],
            replyToSelf: config.replyToSelf,
            repliedToBot,
            randomHit,
        });
        if (!facts.mentioned && !facts.prefixMatched && !facts.repliedToBot && !facts.randomHit)
            return;
        const addressed = facts.mentioned || facts.prefixMatched || facts.repliedToBot;
        const now = Date.now();
        const lastReply = this.lastReplyAt.get(groupId) ?? 0;
        if (now - lastReply < config.cooldownSeconds * 1000)
            return;
        if (!addressed) {
            const lastRandom = this.lastRandomAt.get(groupId) ?? 0;
            if (now - lastRandom < config.randomCooldownSeconds * 1000)
                return;
        }
        if (this.busy.has(groupId))
            return;
        this.busy.add(groupId);
        try {
            await this.replyToGroup(groupId, config, addressed, event.message, text, speaker, String(event.user_id));
        }
        finally {
            this.busy.delete(groupId);
        }
    }
    async handlePrivateMessage(event) {
        const userId = String(event.user_id);
        // 事件自带 self_id 优先：与群消息路径、dispatch 的口径保持一致。
        const selfId = event.self_id ?? this.client.self;
        if (event.user_id === selfId)
            return;
        const { text } = extractMessage(event.message, selfId);
        if (text === '')
            return;
        const config = this.resolveConfig(`private:${userId}`);
        const speaker = event.sender.nickname;
        this.appendHistory(`private:${userId}`, { role: 'user', speaker, text, time: event.time * 1000, userId });
        // 私聊里说的话也记进档案（默认允许在群里自然接上；people.privateToGroup 可关）。
        this.people?.touchPerson(userId, { name: speaker, chatKey: `private:${userId}`, at: event.time * 1000 });
        this.people?.addSurface({
            userId,
            name: speaker,
            chatKey: `private:${userId}`,
            text,
            at: event.time * 1000,
        });
        // 私聊白名单：留空表示不限制；不在名单里的人照样记录，但不回应。
        if (this.defaults.allowUsers.length > 0 && !this.defaults.allowUsers.includes(userId))
            return;
        // 桌面工具：只认管理员的私聊（群友永远触发不了）；命中就是本机操作，不再走模型。
        if (this.desktop !== undefined && this.defaults.admins.includes(userId)) {
            const result = await this.desktop.handle(text, `private:${userId}`);
            if (result !== undefined) {
                const speaker = this.characters.get(config.characterId)?.name ?? config.characterId;
                const sent = await this.outbound.sendTextToPrivate(event.user_id, result.reply);
                if (sent) {
                    this.appendHistory(`private:${userId}`, {
                        role: 'assistant',
                        speaker,
                        text: result.reply,
                        time: Date.now(),
                    });
                }
                if (result.imagePath !== undefined) {
                    await this.outbound.sendLocalImage({ userId: event.user_id }, result.imagePath);
                }
                if (this.voice?.enabled === true)
                    void this.speakTo(`private:${userId}`, result.reply, 'calm');
                return;
            }
        }
        // 私聊同理：不再压缩摘要，旧聊天已进归档（需要时模型用 [回忆:] 取）。
        // 风格学习同样后台跑（私聊只学对方一个人的腔调）。
        void this.learner?.maybeLearn(`private:${userId}`, this.record(`private:${userId}`).history, {
            provider: config.provider,
            model: config.model,
        });
        const now = Date.now();
        // 冷却与忙锁要带 `private:` 前缀：群号与 QQ 号是两套编号，
        // 裸 userId 会和同数字的群号抢同一把锁、同一份冷却。
        const lockKey = `private:${userId}`;
        if (now - (this.lastReplyAt.get(lockKey) ?? 0) < config.cooldownSeconds * 1000)
            return;
        if (this.busy.has(lockKey))
            return;
        this.busy.add(lockKey);
        try {
            const reply = await this.generateReply(`private:${userId}`, config, {
                groupId: undefined,
                groupName: undefined,
                members: [`${speaker}(${userId})`],
                segments: event.message,
                speakerName: speaker,
                userText: text,
                senderId: userId,
            });
            if (reply === undefined)
                return;
            // 回复里可能带 `[表情:名字]`：文字先发，表情再单独发。
            // 生图覆盖同样带 QQ：私聊也能用画风、也按人记 V5 额度。
            if (!await this.outbound.sendReply({ userId: event.user_id }, reply, {
                userId,
                ...this.styleHintOf(text),
            }))
                return;
            this.lastReplyAt.set(lockKey, Date.now());
            this.appendHistory(`private:${userId}`, {
                role: 'assistant',
                speaker: this.characters.get(config.characterId)?.name ?? config.characterId,
                text: reply,
                time: Date.now(),
            });
            // 私聊同样带语音输出。
            if (this.voice?.shouldSpeak(reply) === true) {
                void this.speakTo(`private:${userId}`, reply, chooseVoiceStyle(text, reply));
            }
        }
        catch (error) {
            this.logger.error('qq-groupmate: 私聊回复失败: %s', String(error));
        }
        finally {
            this.busy.delete(lockKey);
        }
    }
    async replyToGroup(groupId, config, addressed, segments, userText, speakerName, 
    /** 发起人的 QQ 号：生图画风按人解析、V5 额度按人记。 */
    senderId = '') {
        const card = this.characters.get(config.characterId);
        if (card === undefined) {
            this.logger.warn('qq-groupmate: 群 %s 的角色卡「%s」不存在，跳过回复', groupId, config.characterId);
            return;
        }
        // 首次被点名时，用角色卡的招呼语打招呼，省一次模型调用。
        const record = this.record(groupId);
        if (!record.greetingDone && card.greeting !== undefined && addressed) {
            record.greetingDone = true;
            // 招呼被拦下或发送失败时不记历史、不置冷却：群里没人看见的话别写进上下文。
            if (await this.outbound.sendTextToGroup(groupId, card.greeting)) {
                this.lastReplyAt.set(groupId, Date.now());
                this.appendHistory(groupId, { role: 'assistant', speaker: card.name, text: card.greeting, time: Date.now() });
            }
            return;
        }
        record.greetingDone = true;
        const recent = record.history.slice(-20);
        const members = [...new Set(recent.map(entry => speakerLabel(entry)))];
        const reply = await this.generateReply(groupId, config, {
            groupId,
            groupName: undefined,
            members,
            segments,
            speakerName: speakerName,
            userText,
            senderId,
        });
        if (reply === undefined)
            return;
        // 回复里可能带 `[表情:名字]`：文字先发，表情再单独发。
        // 生图覆盖传发起人的 QQ：画风按人解析、V5 额度按人记。
        if (!await this.outbound.sendReply({ groupId }, reply, {
            ...(senderId === '' ? {} : { userId: senderId }),
            ...this.styleHintOf(userText),
        }))
            return;
        const now = Date.now();
        this.lastReplyAt.set(groupId, now);
        if (!addressed)
            this.lastRandomAt.set(groupId, now);
        this.appendHistory(groupId, { role: 'assistant', speaker: card.name, text: reply, time: now });
        // 有意义的对话过后，按 mod 的分类规则看要不要挂一封信。
        this.notes?.consider(groupId, userText, reply);
        // 语音输出：按情绪挑参考音，后台合成完发一条 QQ 语音（失败只影响语音）。
        if (this.voice?.shouldSpeak(reply) === true) {
            void this.speakTo(groupId, reply, chooseVoiceStyle(userText, reply));
        }
    }
    /**
     * 合成并发送一条 QQ 语音（文字回复的附加输出，失败静默降级）。
     * @param scope - 群号或 `private:<QQ>`。
     */
    async speakTo(scope, text, style) {
        const voice = this.voice;
        if (voice === undefined)
            return;
        // 日文语音模式下要念的是 speech_ja（日文），不是群友看到的中文。
        const speechText = this.pendingSpeech.get(scope) ?? text;
        this.pendingSpeech.delete(scope);
        const wav = await voice.speak(speechText, style);
        if (wav === undefined)
            return;
        const target = scope.startsWith('private:')
            ? { userId: scope.slice('private:'.length) }
            : { groupId: scope };
        await this.outbound.sendVoice(target, wav);
    }
    /**
     * 桥接/计时器播报：把一句话发到指定归属（可带语音），并记入历史。
     * @param scope - 群号或 `private:<QQ>`。
     * @param message - 正文。
     * @param opts.voice - 要不要带语音。
     * @param opts.mentionUserId - 要不要在这条消息开头 @ 某人（提醒到点时用）。
     */
    async announce(scope, message, opts = {}) {
        const mention = opts.mentionUserId?.trim() ?? '';
        let sent = false;
        if (mention !== '' && !scope.startsWith('private:')) {
            // 带 @ 的消息要发消息段（@ 段 + 文本段），不能只发纯文本。
            sent = await this.outbound.sendSegmentsToGroup(scope, [
                { type: 'at', data: { qq: mention } },
                { type: 'text', data: { text: ` ${message}` } },
            ]);
        }
        else {
            sent = scope.startsWith('private:')
                ? await this.outbound.sendTextToPrivate(scope.slice('private:'.length), message)
                : await this.outbound.sendTextToGroup(scope, message);
        }
        if (!sent)
            return false;
        const card = this.characters.get(this.resolveConfig(scope).characterId);
        this.appendHistory(scope, {
            role: 'assistant',
            speaker: card?.name ?? '机器人',
            text: message,
            time: Date.now(),
        });
        if (opts.voice === true && this.voice?.enabled === true)
            await this.speakTo(scope, message, 'calm');
        return true;
    }
    async generateReply(scope, config, environment) {
        const card = this.characters.get(config.characterId);
        if (card === undefined)
            return undefined;
        // 明确的本机指令：问时间 / 日期 / 星期直接本机回答，不叫模型（与 mod 的本机路由一致）。
        const localReply = buildLocalTimeReply(environment.userText ?? '');
        if (localReply !== undefined) {
            this.logger.debug?.('qq-groupmate: 本机路由直接回答时间类问题（%s）', scope);
            return localReply;
        }
        // 识图：把这条消息里的图片取下来，改用视觉模型看一眼。
        let images = [];
        let target = {
            provider: config.provider,
            model: config.model,
            ...(config.backup === undefined ? {} : { backup: config.backup }),
        };
        if (this.vision?.enabled === true
            && environment.segments !== undefined
            && collectImages(environment.segments).length > 0) {
            images = await fetchImages(this.client, environment.segments, this.vision, this.logger);
            if (images.length > 0) {
                const visionPrimary = this.models.resolve(this.vision.model, { provider: config.provider, model: config.model });
                // 识图槽自己的备用优先，没配就沿用群聊的备用。
                const visionBackupRef = this.vision.backup?.trim();
                const visionBackup = visionBackupRef === undefined || visionBackupRef === ''
                    ? config.backup
                    : this.models.resolve(visionBackupRef, visionPrimary);
                const usable = visionBackup !== undefined
                    && (visionBackup.provider !== visionPrimary.provider || visionBackup.model !== visionPrimary.model)
                    ? visionBackup
                    : undefined;
                target = {
                    provider: visionPrimary.provider,
                    model: visionPrimary.model,
                    ...(usable === undefined ? {} : { backup: usable }),
                };
                this.logger.info('qq-groupmate: 识图 %s 张，改用 %s / %s', String(images.length), target.provider, target.model);
            }
        }
        const record = this.record(scope);
        // 已被总结记忆覆盖的原文不再进上下文，腾出的位置留给新消息。
        let covered = this.summaries?.coveredThroughSeq(scope) ?? -1;
        // 一致性检查：state.json 丢失/损坏重建后历史 seq 从 0 重排，而总结文件里的
        // 覆盖位置可能是几百。照旧过滤会让 visible 为空、机器人永远不再回复；
        // 检测到就把覆盖位置重置回 -1（保留总结正文），按全量历史继续并告警一次。
        if (covered >= 0 && record.history.length > 0) {
            const maxSeq = record.history.reduce((max, entry) => Math.max(max, entry.seq ?? 0), 0);
            if (covered >= maxSeq) {
                this.logger.warn('qq-groupmate: 总结覆盖位置（%s）不小于当前历史最大序号（%s），疑似 state.json 丢失导致历史序号重排，已重置覆盖位置（%s）', String(covered), String(maxSeq), scope);
                this.summaries?.resetCoverage(scope);
                covered = -1;
            }
        }
        // 窗口下界对齐到「裁剪块」网格（2026-09-17）。
        //
        // 为什么必须对齐：覆盖推进的步长是 batchMessages（默认 40），通常小于裁剪块
        // （maxTurns/4，最少 64）。如果窗口下界直接跟着 covered 走，每成功压一批记忆窗口就前移一次、
        // 请求前缀就断一次（实测最快群每 2.7 分钟断一次，断的那次命中归零）；
        // 而且一旦历史涨满 maxTurns，就会退化成「每来一条新消息就裁一条」的连续滑动——
        // 实测那种情况下命中率恒为 0。
        // 对齐到网格后，窗口起点只在跨过整块时才移动，断裂频率按块大小成比例下降。
        const block = Math.max(64, Math.round(Math.max(1, config.maxTurns) / 4));
        const alignDown = (seq) => (seq < 0 ? -1 : Math.floor(seq / block) * block);
        let lower = alignDown(covered);
        const entries = record.history;
        const maxSeq = entries.length === 0 ? 0 : entries[entries.length - 1]?.seq ?? 0;
        // 条数超限也按网格推进：宁可多留最多一个块的原文，也不让前缀每轮都滑。
        while (maxSeq - lower > Math.max(1, config.maxTurns) + block)
            lower += block;
        const visible = lower < 0
            ? entries
            : entries.filter(entry => (entry.seq ?? Number.MAX_SAFE_INTEGER) > lower);
        // 放宽一个块再交给 trimHistory：条数裁剪已经由上面的网格负责，这里只留字符兜底。
        const history = trimHistory(visible, Math.max(1, config.maxTurns) + block, config.maxChars);
        if (history.length === 0)
            return undefined;
        const messages = history.map((entry) => {
            if (entry.role === 'assistant') {
                return createAssistantMessage({
                    content: [{ type: 'text', text: entry.text }],
                    source: { provider: config.provider, model: config.model },
                });
            }
            // 角色卡要求标记管理员时，把标记缀在名字后面，模型据此区分「他」和普通群友。
            const tagged = card.adminTag !== undefined
                && entry.userId !== undefined
                && this.defaults.admins.includes(entry.userId);
            return createUserMessage({
                content: [{ type: 'text', text: `${speakerLabel(entry)}${tagged ? card.adminTag : ''}: ${entry.text}` }],
                source: { kind: 'user' },
            });
        });
        // 称呼概率规则：绝大多数时候不叫名字，隔几轮、对方带情绪时更容易叫一次。
        let nameGuidance;
        if (environment.speakerName !== undefined && environment.userText !== undefined) {
            const sinceOffered = this.repliesSinceNameOffered.get(scope) ?? 0;
            const decision = buildNameGuidance({
                name: environment.speakerName,
                repliesSinceOffered: sinceOffered,
                userText: environment.userText,
                random: Math.random(),
            });
            this.repliesSinceNameOffered.set(scope, decision.offered ? 0 : sinceOffered + 1);
            nameGuidance = decision.guidance;
        }
        // 天气上下文：拿不到就给「坦白说看不到」的兜底话，不影响聊天。
        const weatherContext = await this.weather?.getContext();
        // 群友档案：跨群印象 + 长期记忆 + 「刚在别处说过的话」。
        // 只看本次相关的人（触发者），避免把整个名册倒进提示词。
        const senderId = environment.senderId ?? '';
        const peopleParts = this.people?.formatForPrompt(scope, {
            ...(senderId === '' ? {} : { userIds: [senderId] }),
        });
        const toolsPrompt = this.tools === undefined
            ? ''
            : buildToolUsagePrompt(this.tools.availability);
        // 系统提示只放「这个角色 + 这个群不变的东西」（缓存友好）：同一角色同一群里逐字节一致，
        // 上游的前缀缓存才能从 system 一直命中到后面几万 token 的群聊历史。
        const system = buildStableSystemPrompt({
            card,
            groupId: environment.groupId ?? '私聊',
            groupName: environment.groupName,
            botName: card.name,
            stickers: this.stickers?.available === true ? this.stickers.names() : undefined,
            imageGen: this.outbound.imageGenEnabled,
            imageStyles: this.imageGen !== undefined && this.outbound.imageGenEnabled ? this.imageStylesForPrompt() : undefined,
            tools: toolsPrompt === '' ? undefined : toolsPrompt,
            japaneseVoiceMode: this.voice?.japaneseVoiceMode === true,
            nativeVoiceKeys: this.nativeVoice?.available === true ? this.nativeVoice.describe() : undefined,
        });
        // 每轮都会变的运行时上下文（记忆、知识检索、群友档案、称呼、天气、成员）单独成块，
        // 插到消息序列末尾——理由见 prompt.js 顶部关于「请求前缀缓存」的说明。
        const contextBlock = buildContextBlock({
            members: environment.members,
            knowledge: this.knowledge === undefined
                ? undefined
                : this.knowledge.search(history[history.length - 1]?.text ?? ''),
            learnedStyle: this.learner?.currentStyle(scope)?.text,
            nameGuidance,
            weatherContext,
            surfaceMemory: peopleParts?.surface,
            archiveMemory: peopleParts?.archive,
            runtimeNote: images.length > 0
                ? `有人刚发了 ${String(images.length)} 张图，你直接看到了图片内容，自然点回应，别说「我看不到图片」。`
                : undefined,
        });
        if (contextBlock !== '') {
            // 放在当前消息之前：最后一条仍然是群友刚说的话，模型不会对着资料自说自话。
            messages.splice(Math.max(messages.length - 1, 0), 0, createUserMessage({
                content: [{ type: 'text', text: contextBlock }],
                source: { kind: 'user' },
            }));
        }
        this.logCacheFingerprint(system, messages, contextBlock, history[0]?.seq);
        let result = await this.runModel(target, {
            system,
            messages,
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            images,
        });
        // 图片可能是模型不认的格式（比如有的中转站不收 GIF）：记下这种格式，改成不带图再试一次。
        if (result.failure !== undefined && images.length > 0) {
            noteImageRejection(result.failure, this.logger);
            this.logger.warn('qq-groupmate: 带图请求失败（%s），改成不带图重试一次', result.failure);
            result = await this.runModel(target, {
                system,
                messages,
                temperature: config.temperature,
                maxTokens: config.maxTokens,
            });
        }
        if (result.failure !== undefined) {
            this.logger.warn('qq-groupmate: 模型请求失败（%s），跳过本次回复。若是 MISSING_CREDENTIAL / AUTH，请先在 dsh 里配置模型 API Key', result.failure);
            return undefined;
        }
        // 工具循环：模型写了 `[搜索:]` 这类标记就跑一遍，需要资料就回灌让它接着说；
        // 记印象 / 定提醒这类副作用直接做掉，并把回执挂到结果上（调用方决定要不要发）。
        const looped = await this.runToolLoop(target, config, {
            system,
            messages,
            firstText: result.text,
            ...(images.length === 0 ? {} : { images }),
            context: {
                chatKey: scope,
                userId: environment.senderId ?? '',
                userName: environment.speakerName ?? '',
            },
        });
        // 日文语音模式：模型给的是 {"display_text": 中文, "speech_ja": 日文}——
        // 群友看的正文用 display_text，拿去合成的用 speech_ja（见 voice.js 的 parseVoiceModeJson）。
        const voiceMode = this.voice?.japaneseVoiceMode === true ? parseVoiceModeJson(looped.text) : undefined;
        const reply = sanitizeReply(voiceMode === undefined ? looped.text : voiceMode.display);
        if (reply === undefined) {
            this.logger.debug?.('qq-groupmate: 模型选择不接话（%s）', scope);
            // 正文空了但确实定了提醒：也要把回执发出去，不然群友以为没说。
            return looped.actionNotes.length > 0 ? looped.actionNotes.join('\n') : undefined;
        }
        if (voiceMode !== undefined)
            this.pendingSpeech.set(scope, voiceMode.speech);
        else if (this.voice?.japaneseVoiceMode === true)
            this.logger.warn('qq-groupmate: 日文语音模式：模型没按格式给出 speech_ja（原文：%s），这次语音会用中文音色念原文', reply.slice(0, 40));
        // 动作回执（「已定好：明天 9:00 提醒…」）附在正文后面：这是群友需要知道的事实。
        return looped.actionNotes.length === 0
            ? reply
            : `${reply}\n${looped.actionNotes.join('\n')}`;
    }
    /**
     * 工具循环：把模型输出里的方括号标记（`[搜索:]` 这类）跑掉，需要资料就把结果回灌再让它说一遍。
     *
     * 为什么不用原生 function calling：本插件的模型层只透传文本，群聊里用的模型
     * （中转站、小模型）也不保证支持 tools。标记法在所有模型上都能跑，和既有的
     * `[表情:名字]` / `[生图:标签]` 是同一套思路。
     *
     * 预算与安全：
     * - 最多 {@link MAX_TOOL_ROUNDS} 轮往返，防模型套娃把 token 烧光；
     * - 最后一轮无论如何收尾，不再执行新的查询（免得无限循环）；
     * - 纯动作类（记印象 / 记事情 / 定提醒）执行完就从正文抹掉，不需要再问模型。
     *
     * @returns 最终正文，以及需要口头确认的动作类回执（例如「提醒已定好」）。
     */
    /**
     * 打一条缓存前缀指纹（debug 级）。
     *
     * 上游按请求前缀计费：system 指纹一变，后面几万 token 的群聊历史就全部要重新计费。
     * 排查「缓存命中为零」时先看这行——同一角色、同一群里 system 指纹应当每轮完全相同，
     * 变了就说明有动态内容被塞回了系统提示。
     */
    logCacheFingerprint(system, messages, contextBlock, firstSeq) {
        // `起=` 是这一轮窗口的第一条历史消息序号：它每轮都一样，就说明前缀是「追加」而不是「滑动」，
        // 上游缓存才能命中；它一跳，前面几万 token 就全废了。
        this.logger.debug?.('qq-groupmate: 缓存前缀 system=%s（%s 字）消息=%s 条 起=%s 上下文块=%s 字 首条=%s', fingerprint(system), String(system.length), String(messages.length), String(firstSeq ?? '-'), String(contextBlock.length), fingerprint(messages[0]?.content?.[0]?.text ?? ''));
    }
    async runToolLoop(target, config, options) {
        const tools = this.tools;
        if (tools === undefined)
            return { text: options.firstText, actionNotes: [] };
        const actionNotes = [];
        let text = options.firstText;
        const messages = [...options.messages];
        const parsed = parseToolCalls(text);
        if (parsed.calls.length === 0)
            return { text, actionNotes: [] };
        text = parsed.text;
        for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
            const outcomes = [];
            for (const call of parsed.calls) {
                outcomes.push(await tools.run(call, options.context));
            }
            actionNotes.push(...renderActionNotes(outcomes));
            if (!hasInformationalCalls(parsed.calls))
                break;
            const injected = renderToolResults(outcomes);
            if (injected === '')
                break;
            if (round === MAX_TOOL_ROUNDS - 1) {
                // 最后一轮：资料已经给了，但要再要一次模型的话就超预算了。
                this.logger.debug?.('qq-groupmate: 工具往返已达上限（%s 轮），不再继续查', String(MAX_TOOL_ROUNDS));
                break;
            }
            messages.push(createUserMessage({
                content: [{ type: 'text', text: injected }],
                source: { kind: 'user' },
            }));
            const next = await this.runModel(target, {
                system: options.system,
                messages,
                temperature: config.temperature,
                maxTokens: config.maxTokens,
            });
            if (next.failure !== undefined) {
                this.logger.warn('qq-groupmate: 工具回灌后的模型请求失败（%s），用上一轮文本收尾', next.failure);
                break;
            }
            messages.push(createAssistantMessage({
                content: [{ type: 'text', text: next.text }],
                source: { provider: target.provider, model: target.model },
            }));
            const again = parseToolCalls(next.text);
            text = again.text;
            if (again.calls.length === 0)
                break;
            parsed.calls.length = 0;
            parsed.calls.push(...again.calls);
        }
        return { text, actionNotes };
    }
    /** 跑一次模型调用，收集文本和失败原因；异常也归一成失败字符串。 */
    async runModel(target, request) {
        const controller = new AbortController();
        const timeout = setTimeout(() => { controller.abort(); }, 120000);
        timeout.unref?.();
        let text = '';
        let failure;
        let usage;
        try {
            const stream = this.llm.stream({
                provider: target.provider,
                model: target.model,
                system: request.system,
                messages: request.messages,
                temperature: request.temperature,
                maxTokens: request.maxTokens,
                signal: controller.signal,
                ...(target.backup === undefined ? {} : { backup: target.backup }),
                ...(request.images === undefined || request.images.length === 0 ? {} : { images: request.images }),
            });
            for await (const chunk of stream) {
                if (chunk.type === 'text-delta')
                    text += chunk.text ?? '';
                else if (chunk.type === 'usage') {
                    // 上游按「请求前缀」计费，命中多少直接决定这条回复的成本；
                    // 以前只能去中转后台猜，现在直接打进日志。
                    usage = chunk.usage;
                }
                else if (chunk.type === 'finish') {
                    const reason = chunk.reason;
                    if (reason?.kind === 'error') {
                        failure = reason.failure === undefined
                            ? 'error'
                            : `${reason.failure.code}: ${reason.failure.message}`;
                    }
                    else if (reason?.kind === 'aborted') {
                        failure = 'aborted（请求被取消或超时）';
                    }
                }
            }
        }
        catch (error) {
            this.logger.error('qq-groupmate: 模型调用异常: %s', String(error));
            failure = `EXCEPTION: ${String(error)}`;
        }
        finally {
            clearTimeout(timeout);
        }
        if (usage !== undefined) {
            const hit = usage.cacheReadTokens ?? 0;
            const miss = usage.inputTokens ?? 0;
            const total = hit + miss;
            const rate = total === 0 ? 0 : Math.round((hit / total) * 100);
            this.logger.info('qq-groupmate: 用量 prompt=%s（命中 %s / 未命中 %s，命中率 %s%%）输出=%s', String(total), String(hit), String(miss), String(rate), String(usage.outputTokens ?? 0));
        }
        return { text, failure };
    }
}
