/**
 * AI 信件：有意义的对话过后，角色隔一段时间主动留一张小字条。
 *
 * Mod 的规则原样搬来，只把「Windows 空闲」换成「群里安静」：
 * - 触发分类：upcoming（明天/考试/面试…）、achievement（完成/成功…）、comfort（难过/失恋…）、
 *   promise（约定/答应我…）、bond（喜欢你/谢谢你…），情绪方向随分类固定；
 * - 触发后随机延迟 30~120 分钟才投递，投递要求群里已安静 N 分钟（对应 mod 要求玩家离开电脑 10 分钟）；
 * - 两次投递至少隔 24 小时，一周最多 3 封，挂起事件最多 5 个，同类 6 小时内合并；
 * - 用户说「取消/算了/不用了」就取消挂起的信，「考完了/做完了/成功了」则把它标记完成；
 * - 内容含敏感信息（密码/API Key/长数字/邮箱）一律不写信；
 * - 生成失败 1 小时后自动重试。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm';
import { splitProviderModel } from "./api-client.js";
import { readJsonFile } from "./store.js";
const PENDING_LIMIT = 5;
const CATEGORY_DEDUPE_MS = 6 * 60 * 60 * 1000;
const DELIVERED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TICK_MS = 30 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
/** 分类触发词（与 mod 的分类正则一致，简繁都认）。 */
const CATEGORY_RULES = [
    {
        category: 'upcoming',
        pattern: /(明天|后天|下周|等等要|待会要|考试|面试|报告|手术|约会|旅行|出发|deadline|tomorrow|exam|interview|明日|試験|面接)/iu,
        emotion: text => (/(紧张|害怕|担心|焦虑|不安|怖い|心配|nervous|worried)/iu.test(text)
            ? '紧张，需要温柔支持'
            : '期待中的重要安排'),
    },
    {
        category: 'achievement',
        pattern: /(完成了|成功了|做到了|通过了|过了|终于|毕业|录取|得奖|できた|合格|finished|succeeded|passed)/iu,
        emotion: () => '值得一起庆祝与记住',
    },
    {
        category: 'comfort',
        pattern: /(难过|伤心|哭了|寂寞|孤单|失恋|分手|失败|被骂|压力|悲しい|寂しい|つらい|sad|lonely|heartbroken)/iu,
        emotion: () => '低落，需要安静陪伴而非说教',
    },
    {
        category: 'promise',
        pattern: /(约定|答应我|记得|不要忘记|我们说好|说好|約束|覚えて|promise|remember this)/iu,
        emotion: () => '两人之间值得珍惜的约定',
    },
    {
        category: 'bond',
        pattern: /(喜欢你|爱你|谢谢你|有你真好|陪着我|大好き|愛してる|ありがとう|love you|thank you|喜欢妳|愛妳|謝謝妳)/iu,
        emotion: () => '亲近、感谢与依恋',
    },
];
/** 用户消息更新挂起事件：取消类词 → 取消；完成类词 → 升级为庆祝。 */
const CANCEL_RE = /(取消了|取消吧|算了|不用了|不去了|别再提|忘了吧|キャンセル|中止|やめて|cancel|forget it)/iu;
const COMPLETED_RE = /(完成了|结束了|考完了|做完了|成功了|通过了|过了|终于好了|終わった|できた|finished|done|passed)/iu;
/** 把话题压到 maxChars 字内（与 mod 的 CompactNoteContext 一致）。 */
export function compactNoteContext(text, maximum) {
    const value = text.replace(/\s+/gu, ' ').trim();
    return value.length > maximum ? `${value.slice(0, maximum)}…` : value;
}
/** 内容含敏感信息（密码/密钥/长数字/邮箱）时一律不写信。 */
export function containsSensitiveNoteData(text) {
    return /(api[ _-]?key|密码|验证码|信用卡|身份证|护照|passport|password|token|secret)/iu.test(text)
        || /\b(?:\d[ -]*?){12,19}\b/u.test(text)
        || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(text);
}
/** 判定一条用户消息是否触发信件事件（不查状态、只看文案与敏感词）。 */
export function considerNoteEvent(userText) {
    if (containsSensitiveNoteData(userText) || /(取消|算了|不用了|别再提|忘了吧|forget it|cancel)/iu.test(userText)) {
        return undefined;
    }
    for (const rule of CATEGORY_RULES) {
        if (rule.pattern.test(userText))
            return { category: rule.category, emotion: rule.emotion(userText) };
    }
    return undefined;
}
/** 写信请求（单条 user 消息，与 mod 的 GenerateAiNoteAsync 一致）。 */
export function buildNotePrompt(item) {
    return `用角色的口吻写一封私人小信（自然的简体中文）。事件类别：${item.category}。`
        + `话题：${item.topic}。当时角色的回复：${item.latestContext}。情绪方向：${item.emotion}。`
        + '写 45~110 字的自然中文：温暖、带一点点俏皮和亲近，只在自然时轻轻带出记忆、选择、一起留下过的痕迹这类意味。'
        + '不要提到 AI、定时、存储的记忆、API 或监控；不要给医疗或专业建议；不要复述敏感信息。'
        + '结尾用破折号接角色的自称。只输出信的正文。';
}
/** AI 信件引擎：调度、生成与投递。 */
export class NoteEngine {
    deps;
    state;
    lastActivityAt = new Map();
    generating = false;
    disposed = false;
    timer;
    /** provider 明确拒绝 reasoningEffort 后置位，之后一律用模型默认值。 */
    effortRejected = false;
    constructor(deps) {
        this.deps = deps;
        this.state = readJsonFile(`${deps.dir}/state.json`) ?? { pending: [], deliveredAt: [] };
        this.state.pending ??= [];
        this.state.deliveredAt ??= [];
        // 启动时把卡在 generating 的事件放回 pending（对应 mod 的 LoadAiNoteState）。
        for (const event of this.state.pending) {
            if (event.status === 'generating')
                event.status = 'pending';
        }
        this.state.deliveredAt = this.state.deliveredAt.filter(at => at > Date.now() - DELIVERED_RETENTION_MS);
    }
    get enabled() {
        return this.deps.settings.enabled;
    }
    /** 当前挂起事件数（状态展示用）。 */
    get pendingCount() {
        return this.state.pending.filter(event => event.status === 'pending' || event.status === 'generating').length;
    }
    /** 启动调度定时器。 */
    start() {
        if (this.timer !== undefined || !this.deps.settings.enabled)
            return;
        this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
        this.timer.unref?.();
    }
    /** 停止调度并中断在飞请求。 */
    dispose() {
        this.disposed = true;
        if (this.timer !== undefined)
            clearInterval(this.timer);
        this.timer = undefined;
    }
    /**
     * 群消息观察：记录活跃时间（投递前要确认群里安静），
     * 同时处理「取消/完成」对挂起事件的更新（与 mod 的 UpdatePendingAiNoteEvents 一致）。
     */
    observeGroupMessage(groupId, text, at) {
        if (!this.deps.settings.enabled)
            return;
        this.lastActivityAt.set(groupId, at);
        if (!CANCEL_RE.test(text) && !COMPLETED_RE.test(text))
            return;
        const cancelled = CANCEL_RE.test(text);
        const event = [...this.state.pending].reverse().find(item => item.groupId === groupId && item.status === 'pending');
        if (event === undefined)
            return;
        if (cancelled) {
            event.status = 'cancelled';
            this.deps.logger.warn('qq-groupmate: 用户取消了一封待投递的信（群 %s）', groupId);
        }
        else {
            event.category = 'achievement';
            event.emotion = '值得一起庆祝与记住';
            event.latestContext = compactNoteContext(text, 360);
            this.deps.logger.warn('qq-groupmate: 事件已完成，信件升级为庆祝（群 %s）', groupId);
        }
        this.persist();
    }
    /**
     * 一次成功的群回复后调用：按分类决定要不要挂一封信。
     * @param groupId - 发生对话的群。
     * @param userText - 触发回复的那条用户消息。
     * @param reply - 角色当时的回复。
     * @param now - 当前时间（毫秒）。
     */
    consider(groupId, userText, reply, now = Date.now()) {
        if (this.disposed || !this.deps.settings.enabled)
            return undefined;
        const considered = considerNoteEvent(userText);
        if (considered === undefined)
            return undefined;
        const settings = this.deps.settings;
        const minDelay = Math.max(1, Math.min(1440, settings.delayMinMinutes));
        const maxDelay = Math.max(minDelay, Math.min(2880, settings.delayMaxMinutes));
        const delayMinutes = minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1));
        const topic = compactNoteContext(userText, 360);
        const latestContext = compactNoteContext(reply, 360);
        // 同类 6 小时内已有挂起事件：只更新内容，不再新增（与 mod 一致）。
        const existing = [...this.state.pending].reverse().find(item => item.groupId === groupId
            && item.category === considered.category
            && item.status === 'pending'
            && item.createdAt > now - CATEGORY_DEDUPE_MS);
        if (existing !== undefined) {
            existing.topic = topic;
            existing.latestContext = latestContext;
            existing.emotion = considered.emotion;
            this.persist();
            return considered;
        }
        this.state.pending.push({
            id: `${now.toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`,
            groupId,
            category: considered.category,
            topic,
            latestContext,
            emotion: considered.emotion,
            createdAt: now,
            deliverAfter: now + delayMinutes * 60 * 1000,
            status: 'pending',
        });
        while (this.state.pending.filter(item => item.status === 'pending').length > PENDING_LIMIT) {
            const oldest = this.state.pending.find(item => item.status === 'pending');
            if (oldest === undefined)
                break;
            this.state.pending.splice(this.state.pending.indexOf(oldest), 1);
        }
        this.persist();
        this.deps.logger.warn('qq-groupmate: 已安排一封「%s」的信，%s 分钟后投递到群 %s（内容不写日志）', considered.category, String(delayMinutes), groupId);
        return considered;
    }
    /** 调度心跳：到点、群里安静、冷却与周限都满足才生成并投递。 */
    async tick(now = Date.now()) {
        if (this.disposed || !this.deps.settings.enabled || this.generating)
            return;
        const settings = this.deps.settings;
        const due = this.state.pending.find(item => item.status === 'pending' && item.deliverAfter <= now);
        if (due === undefined)
            return;
        // 群里还没安静够：等等再说（对应 mod 要求玩家离开电脑 N 分钟）。
        const lastActivity = this.lastActivityAt.get(due.groupId);
        if (lastActivity !== undefined && now - lastActivity < settings.requiredQuietMinutes * 60 * 1000)
            return;
        const cooldown = Math.max(1, Math.min(720, settings.cooldownHours)) * 60 * 60 * 1000;
        const lastDelivered = this.state.deliveredAt.length > 0 ? Math.max(...this.state.deliveredAt) : 0;
        if (now - lastDelivered < cooldown)
            return;
        const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
        const weeklyLimit = Math.max(1, Math.min(20, settings.weeklyLimit));
        if (this.state.deliveredAt.filter(at => at >= weekAgo).length >= weeklyLimit)
            return;
        this.generating = true;
        due.status = 'generating';
        this.persist();
        try {
            const text = await this.generate(due);
            if (this.disposed)
                return;
            const sent = await this.deps.deliver(due.groupId, text);
            if (this.disposed)
                return;
            if (sent) {
                due.status = 'delivered';
                this.state.deliveredAt.push(now);
                this.state.deliveredAt = this.state.deliveredAt.filter(at => at > now - DELIVERED_RETENTION_MS);
                this.state.pending = this.state.pending.filter(item => item !== due && (item.status === 'pending' || item.status === 'generating'));
                this.deps.logger.warn('qq-groupmate: 已投递一封信到群 %s（%s）', due.groupId, due.category);
            }
            else {
                // 被出站过滤拦下的信不重试：内容有问题，再试也是一样。
                due.status = 'cancelled';
                this.deps.logger.warn('qq-groupmate: 信件内容被出站过滤拦下，已丢弃（群 %s）', due.groupId);
            }
        }
        catch (error) {
            // 失败退回 pending，1 小时后重试（与 mod 一致）。
            due.status = 'pending';
            due.deliverAfter = now + RETRY_AFTER_FAILURE_MS;
            this.deps.logger.warn('qq-groupmate: 写信失败，1 小时后重试：%s', String(error));
        }
        finally {
            this.generating = false;
            this.persist();
        }
    }
    /** 生成信件正文；失败/空返回抛错。 */
    async generate(item) {
        const settings = this.deps.settings;
        const base = {
            provider: settings.provider?.trim() !== '' && settings.provider !== undefined
                ? settings.provider
                : this.deps.defaultModel.provider,
            model: this.deps.defaultModel.model,
        };
        const { provider, model } = this.deps.models !== undefined
            ? this.deps.models.resolve(settings.model?.trim() ?? '', base)
            : splitProviderModel(base.provider, settings.model?.trim() === '' || settings.model === undefined
                ? base.model
                : settings.model, this.deps.knownProvider ?? (() => false));
        const backupRef = settings.backup?.trim();
        const backup = this.deps.models !== undefined && backupRef !== undefined && backupRef !== ''
            ? this.deps.models.resolve(backupRef, { provider, model })
            : this.deps.defaultModel.backup;
        const usableBackup = backup !== undefined && (backup.provider !== provider || backup.model !== model)
            ? backup
            : undefined;
        const effort = this.effortRejected ? undefined : settings.reasoningEffort?.trim();
        const controller = new AbortController();
        const timeout = setTimeout(() => { controller.abort(); }, 120000);
        timeout.unref?.();
        let text = '';
        let failure;
        try {
            const stream = this.deps.llm.stream({
                provider,
                model,
                system: '',
                messages: [createUserMessage({
                        content: [{ type: 'text', text: buildNotePrompt(item) }],
                        source: { kind: 'user' },
                    })],
                temperature: settings.temperature,
                maxTokens: settings.maxTokens,
                ...(effort === undefined || effort === '' ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
                ...(usableBackup === undefined ? {} : { backup: usableBackup, backupOnEmpty: true }),
                signal: controller.signal,
            });
            for await (const chunk of stream) {
                if (chunk.type === 'text-delta')
                    text += chunk.text ?? '';
                else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
                    failure = chunk.reason.failure === undefined
                        ? 'error'
                        : `${chunk.reason.failure.code}: ${chunk.reason.failure.message}`;
                }
                else if (chunk.type === 'finish' && chunk.reason?.kind === 'aborted') {
                    failure = 'ABORTED: 请求被取消或超时';
                }
            }
        }
        catch (error) {
            if (/REASONING_EFFORT/iu.test(String(error))) {
                this.effortRejected = true;
                this.deps.logger.warn('qq-groupmate: 写信模型不支持 reasoningEffort=%s，改用默认值', effort ?? '');
            }
            throw error;
        }
        finally {
            clearTimeout(timeout);
        }
        if (failure !== undefined)
            throw new Error(failure);
        // 与 mod 的 CleanReply 一致：去 Markdown 符号与多余空白。
        const cleaned = text
            .replace(/^```(?:text|markdown)?\s*/iu, '')
            .replace(/\s*```$/u, '')
            .replace(/[`*_#>]/gu, '')
            .replace(/\s+/gu, ' ')
            .trim();
        if (cleaned.length < 10)
            throw new Error('信件正文过短');
        return cleaned;
    }
    persist() {
        if (this.disposed)
            return;
        try {
            // 状态小，直接同步写；写失败只记日志，别让信件悄悄丢。
            mkdirSync(this.deps.dir, { recursive: true });
            writeFileSync(`${this.deps.dir}/state.json`, JSON.stringify(this.state, null, 2), 'utf8');
        }
        catch (error) {
            this.deps.logger.warn('qq-groupmate: 写信状态落盘失败：%s', String(error));
        }
    }
}
