/**
 * 群聊里的「工具调用」：模型用方括号标记使唤插件干活，插件把结果回灌给模型。
 *
 * 为什么用标记而不是原生 function calling：本插件的模型层（dsh 的 llm / 自定义 API 适配）
 * 只透传文本，不保证支持 tools 字段；而群聊里能用的模型五花八门（中转站、小模型）。
 * 标记法在所有模型上都能跑，和已有的 `[表情:名字]`、`[生图:标签]` 一脉相承。
 *
 * 两类标记：
 * - **查资料**（`[搜索:]` `[网页:]` `[查梗:]` `[查档案:]`）：有结果要回灌，模型看到后再说话。
 *   一轮里最多跑 {@link MAX_TOOL_ROUNDS} 轮，防模型套娃烧钱。
 * - **记事**（`[记印象:]` `[记事情:]` `[定提醒:]`）：纯副作用（写档案 / 定提醒），
 *   执行完就从正文里抹掉，不需要模型再说一遍。
 *
 * 安全：所有入参都过长度限制与清洗；`[网页:]` 的 URL 走 safe-fetch 的 SSRF 校验。
 */
import { describeBiliError, lookupMemeOnBili, renderBiliLookup } from "./bili.js";
import { chatLabel } from "./people.js";
import { ReminderError, formatClock, parseWhen } from "./reminders.js";
import { UnsafeUrlError, fetchPageText } from "./safe-fetch.js";
import { describeSearchError, renderSearchResults, webSearch } from "./web-search.js";
/** 一轮回复里最多跑几轮「查资料 → 再说」的往返。 */
export const MAX_TOOL_ROUNDS = 3;
/** 单个工具入参的长度上限。 */
export const MAX_TOOL_ARG = 400;
/** 回灌给模型的结果最多这么长（避免一次搜索把上下文吃满）。 */
export const MAX_TOOL_RESULT_CHARS = 2400;
/**
 * 标记表。顺序即提示词里的出现顺序。
 * 正则都用非贪婪 + 不跨行，免得模型少写一个 `]` 就把整段正文吃掉。
 */
export const TOOL_SPECS = [
    {
        name: 'search',
        pattern: /\[搜索[:：]\s*([^\]\n]{1,200})\]/gu,
        usage: '`[搜索:关键词]` 联网搜一下（想知道「现在」的事、新消息、具体数据时用）',
        informational: true,
    },
    {
        name: 'fetch',
        pattern: /\[网页[:：]\s*(https?:\/\/[^\]\s\n]{1,400})\]/gu,
        usage: '`[网页:https://…]` 读一个网页的正文（群友甩链接过来、要你说说里面写了啥时用）',
        informational: true,
    },
    {
        name: 'bili',
        pattern: /\[查梗[:：]\s*([^\]\n]{1,100})\]/gu,
        usage: '`[查梗:词]` 去 B 站求证某个梗/说法的出处，会给你链接',
        informational: true,
    },
    {
        name: 'recall',
        pattern: /\[查档案[:：]\s*([^\]\n]{1,100})\]/gu,
        usage: '`[查档案:关键词或QQ号]` 回忆以前记下的事和印象（跨群也查得到）',
        informational: true,
    },
    {
        name: 'fact',
        pattern: /\[记印象[:：]\s*([^\]\n]{1,200})\]/gu,
        usage: '`[记印象:这人是个怎样的人/有什么习惯]` 记一条对这个人的长期印象（别记临时的事、别记隐私）',
        informational: false,
    },
    {
        name: 'event',
        pattern: /\[记事情[:：]\s*([^\]\n]{1,200})\]/gu,
        usage: '`[记事情:约定/梗/长期有效的事]` 记一件长期有效的事（约定、梗、恩怨、稳定偏好）',
        informational: false,
    },
    {
        name: 'remind',
        pattern: /\[定提醒[:：]\s*([^\]\n]{1,200})\]/gu,
        usage: '`[定提醒:时间|要提醒的事]` 定个提醒，时间写 `2026-09-16 09:00` `09:30` `+30m` `3天后` 这类，'
            + '要提醒别人就在事后面加 `@QQ号`',
        informational: false,
    },
];
/**
 * 解析正文里的工具标记。
 * @param text - 模型输出。
 * @returns 抹掉标记后的正文 + 按出现顺序排列的调用列表。
 */
export function parseToolCalls(text) {
    let remaining = String(text ?? '');
    const calls = [];
    for (const spec of TOOL_SPECS) {
        // 每次从新的正则实例开始，避免 lastIndex 残留（g 标志的正则是有状态的）。
        const pattern = new RegExp(spec.pattern.source, spec.pattern.flags);
        remaining = remaining.replace(pattern, (raw, arg) => {
            const value = String(arg ?? '').trim();
            if (value !== '')
                calls.push({ name: spec.name, arg: value, raw, index: 0 });
            return '';
        });
    }
    // 按在原文里出现的位置排序，让「先搜后写」的顺序符合直觉。
    const ordered = calls
        .map((call) => {
        const index = String(text ?? '').indexOf(call.raw);
        return { ...call, index: index < 0 ? Number.MAX_SAFE_INTEGER : index };
    })
        .sort((a, b) => a.index - b.index)
        .map(({ name, arg, raw }) => ({ name, arg, raw }));
    return {
        text: remaining.replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim(),
        calls: ordered,
    };
}
/** 这段文本里有没有需要回灌的「查资料」调用。 */
export function hasInformationalCalls(calls) {
    return calls.some(call => TOOL_SPECS.find(spec => spec.name === call.name)?.informational === true);
}
/** 生成提示词里的「工具箱」一节；没有可用工具时返回空串。 */
export function buildToolUsagePrompt(options) {
    const available = TOOL_SPECS.filter((spec) => {
        if (spec.name === 'search' || spec.name === 'fetch' || spec.name === 'bili')
            return options.search === true;
        if (spec.name === 'recall')
            return options.people === true;
        if (spec.name === 'fact' || spec.name === 'event')
            return options.people === true;
        return options.reminders === true;
    });
    if (available.length === 0)
        return '';
    return [
        '# 你能做的事（用方括号标记，插件会替你做）',
        ...available.map(spec => `- ${spec.usage}`),
        '用法：标记单独写出来就会被执行，不用跟别人解释你在查什么；'
            + '查资料的标记会在本轮内直接给你结果，你拿到结果后用**自己的话**接着聊，别把链接和原文照抄一遍。'
            + '标记不要嵌套、不要换行、一次别超过两三个。',
    ].join('\n');
}
/** 工具执行器。 */
export class ToolRunner {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /** 当前有哪些工具可用（提示词要用同一份判断）。 */
    get availability() {
        return {
            search: this.deps.search?.enabled === true,
            people: this.deps.people !== undefined,
            reminders: this.deps.reminders !== undefined,
        };
    }
    /**
     * 执行一次工具调用。
     * @param call - 解析出来的调用。
     * @param context - 谁在哪个会话触发的。
     * @returns 结果；失败时 `ok=false` 且 `result` 是一句让模型能自然带过的话。
     */
    async run(call, context) {
        try {
            switch (call.name) {
                case 'search': return await this.runSearch(call);
                case 'fetch': return await this.runFetch(call);
                case 'bili': return await this.runBili(call);
                case 'recall': return this.runRecall(call, context);
                case 'fact': return this.runFact(call, context);
                case 'event': return this.runEvent(call, context);
                case 'remind': return this.runRemind(call, context);
                default: return { name: call.name, informational: false, result: '', ok: false };
            }
        }
        catch (error) {
            this.deps.logger.warn('qq-groupmate: 工具 %s 执行失败：%s', call.name, String(error));
            return {
                name: call.name,
                informational: TOOL_SPECS.find(spec => spec.name === call.name)?.informational === true,
                result: `（${String(error instanceof Error ? error.message : error)}）`,
                ok: false,
            };
        }
    }
    async runSearch(call) {
        const settings = this.deps.search;
        if (settings === undefined || !settings.enabled) {
            return { name: 'search', informational: true, result: '（联网搜索没开）', ok: false };
        }
        try {
            const response = await webSearch(call.arg.slice(0, 200), settings, this.deps.logger);
            return {
                name: 'search',
                informational: true,
                result: truncate(renderSearchResults(response), MAX_TOOL_RESULT_CHARS),
                ok: true,
            };
        }
        catch (error) {
            return { name: 'search', informational: true, result: `（${describeSearchError(error)}）`, ok: false };
        }
    }
    async runFetch(call) {
        if (this.deps.search?.enabled !== true) {
            return { name: 'fetch', informational: true, result: '（联网没开）', ok: false };
        }
        try {
            const page = await fetchPageText(call.arg.slice(0, 400));
            const head = page.title === '' ? `网页内容（${page.url}）：` : `网页「${page.title}」（${page.url}）：`;
            const body = truncate(page.text, MAX_TOOL_RESULT_CHARS);
            const tail = page.truncated ? '\n（内容太长已截断。）' : '';
            return { name: 'fetch', informational: true, result: `${head}\n${body}${tail}`, ok: true };
        }
        catch (error) {
            const message = error instanceof UnsafeUrlError ? error.message : `抓取失败：${error instanceof Error ? error.message : String(error)}`;
            return { name: 'fetch', informational: true, result: `（${message}）`, ok: false };
        }
    }
    async runBili(call) {
        if (this.deps.search?.enabled !== true) {
            return { name: 'bili', informational: true, result: '（联网没开）', ok: false };
        }
        try {
            const lookup = await lookupMemeOnBili(call.arg.slice(0, 100));
            return {
                name: 'bili',
                informational: true,
                result: truncate(renderBiliLookup(lookup), MAX_TOOL_RESULT_CHARS),
                ok: true,
            };
        }
        catch (error) {
            return { name: 'bili', informational: true, result: `（${describeBiliError(error, this.deps.logger)}）`, ok: false };
        }
    }
    runRecall(call, context) {
        const people = this.deps.people;
        if (people === undefined) {
            return { name: 'recall', informational: true, result: '（没有档案可查）', ok: false };
        }
        const query = call.arg.slice(0, 100);
        const userId = /^\d{5,15}$/u.test(query.trim()) ? query.trim() : '';
        const found = people.search({
            query,
            chatKey: context.chatKey,
            ...(userId === '' ? {} : { userId }),
            limit: 8,
        });
        const lines = [`查档案「${query}」：`];
        if (found.people.length === 0 && found.events.length === 0) {
            lines.push('没查到相关的记录。别硬编，就当没有这回事。');
        }
        for (const person of found.people) {
            lines.push(`- ${person.name === '' ? `QQ ${person.userId}` : `${person.name}（QQ ${person.userId}）`}`);
            for (const fact of person.facts)
                lines.push(`  · ${fact.content}（记于 ${fact.source}）`);
        }
        for (const event of found.events) {
            lines.push(`- [${event.kind}] ${event.text}（${event.from}）`);
        }
        if (found.people.length > 0 || found.events.length > 0) {
            lines.push('（这些是以前记下的，可以自然提起；记不清或对不上就别用。）');
        }
        return { name: 'recall', informational: true, result: truncate(lines.join('\n'), MAX_TOOL_RESULT_CHARS), ok: true };
    }
    runFact(call, context) {
        const people = this.deps.people;
        if (people === undefined) {
            return { name: 'fact', informational: false, result: '（档案没开）', ok: false };
        }
        if (looksLikeInjection(call.arg)) {
            this.deps.logger.warn('qq-groupmate: 拒绝写入疑似提示词注入的印象：%s', call.arg.slice(0, 80));
            return { name: 'fact', informational: false, result: '（这条不像正常印象，没记）', ok: false };
        }
        if (context.userId === '') {
            return { name: 'fact', informational: false, result: '（不知道是谁，没记）', ok: false };
        }
        const result = people.rememberFact(context.userId, call.arg.slice(0, 200), {
            name: context.userName,
            chatKey: context.chatKey,
            importance: 3,
        });
        return {
            name: 'fact',
            informational: false,
            result: result === 'skipped' ? '（没记）' : '（已记下）',
            ok: result !== 'skipped',
        };
    }
    runEvent(call, context) {
        const people = this.deps.people;
        if (people === undefined) {
            return { name: 'event', informational: false, result: '（档案没开）', ok: false };
        }
        if (looksLikeInjection(call.arg)) {
            this.deps.logger.warn('qq-groupmate: 拒绝写入疑似提示词注入的事件：%s', call.arg.slice(0, 80));
            return { name: 'event', informational: false, result: '（这条不像正常事件，没记）', ok: false };
        }
        const id = people.noteEvent({
            text: call.arg.slice(0, 200),
            kind: 'event',
            scope: 'chat',
            chatKey: context.chatKey,
            ...(context.userId === '' ? {} : { participants: [context.userId] }),
        });
        return { name: 'event', informational: false, result: id === '' ? '（没记）' : '（已记下）', ok: id !== '' };
    }
    runRemind(call, context) {
        const reminders = this.deps.reminders;
        if (reminders === undefined) {
            return { name: 'remind', informational: false, result: '（定时提醒没开）', ok: false };
        }
        const [timePart, ...rest] = call.arg.split(/[|｜]/u);
        const when = String(timePart ?? '').trim();
        // 拆「要提醒的事」与「@谁」：末尾的 @数字 是提醒对象。
        let subject = rest.join('|').trim();
        let targetUserId = '';
        const atMatch = /@\s*(\d{5,15})\s*$/u.exec(subject);
        if (atMatch !== null) {
            targetUserId = atMatch[1];
            subject = subject.slice(0, atMatch.index).trim();
        }
        if (when === '' || subject === '') {
            return {
                name: 'remind',
                informational: false,
                result: '（要写成 `[定提醒:时间|要提醒的事]`，例如 `[定提醒:明天 09:00 不行，请写 2026-09-16 09:00|交作业]`）',
                ok: false,
            };
        }
        const parsed = parseWhen(when);
        if (!parsed.ok)
            return { name: 'remind', informational: false, result: `（${parsed.error}）`, ok: false };
        try {
            const item = reminders.create({
                text: subject.slice(0, 200),
                dueAt: parsed.at,
                chatKey: context.chatKey,
                ...(targetUserId === '' ? {} : { targetUserId }),
                ...(targetUserId === '' ? {} : { targetName: targetUserId }),
                creatorId: context.userId,
                creatorName: context.userName,
            });
            const when2 = `${new Date(item.dueAt).getMonth() + 1}月${new Date(item.dueAt).getDate()}日 ${formatClock(item.dueAt)}`;
            return {
                name: 'remind',
                informational: false,
                result: `（已定好：${when2} 提醒「${item.text}」）`,
                ok: true,
            };
        }
        catch (error) {
            if (error instanceof ReminderError)
                return { name: 'remind', informational: false, result: `（${error.message}）`, ok: false };
            throw error;
        }
    }
}
/** 把工具结果拼成回灌给模型的一段 user 消息。 */
export function renderToolResults(outcomes) {
    const informational = outcomes.filter(outcome => outcome.informational);
    if (informational.length === 0)
        return '';
    const parts = informational.map((outcome) => {
        const label = TOOL_SPECS.find(spec => spec.name === outcome.name)?.name ?? outcome.name;
        return `【${label}】\n${outcome.result}`;
    });
    return [
        '下面是你要的资料，用你自己的话接着说这次回复（别把原文、链接列表照抄出来，一两句就够）：',
        ...parts,
    ].join('\n\n');
}
/**
 * 取动作类（副作用）回执，一条一个元素。
 *
 * 返回数组而不是拼好的字符串：调用方要往数组里追加，如果给的是字符串，
 * `push(...)` 会把字符串按**字符**拆开塞进去（真踩过：回执变成一个字一行）。
 */
export function renderActionNotes(outcomes) {
    const notes = [];
    for (const outcome of outcomes) {
        if (outcome.informational || !outcome.ok)
            continue;
        if (outcome.name === 'remind') {
            const text = outcome.result.replace(/^（/u, '').replace(/）$/u, '').trim();
            if (text !== '')
                notes.push(text);
        }
    }
    return notes;
}
/** 疑似提示词注入：这些内容不许进档案（档案会进提示词，写进去就是持久污染）。 */
export function looksLikeInjection(text) {
    return /忽略(以上|上面|之前|前面|所有)/u.test(text)
        || /(系统|开发)者?提示词?/u.test(text)
        || /你现在是|你从现在开始是|扮演一个/u.test(text)
        || /ignore\s+(all\s+)?(previous|above)/iu.test(text)
        || /system\s*prompt/iu.test(text)
        || /disregard\s+(all\s+)?(previous|prior)/iu.test(text)
        || /<\s*\|?\s*(im_start|system)\s*\|?\s*>/iu.test(text)
        || /\[(system|assistant|tool)\]/iu.test(text);
}
/** 超长截断。 */
function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
/** 会话显示名（给「已定好提醒」这类回执用）。 */
export function describeChat(chatKey) {
    return chatLabel(chatKey);
}
