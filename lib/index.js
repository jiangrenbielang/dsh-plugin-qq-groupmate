/**
 * QQ 群友插件：让 dsh 里的 AI 以普通群友身份接入 QQ 群。
 *
 * - 通过 OneBot 11 接入 NapCat / SnowLuma / LLOneBot / go-cqhttp，支持正向与反向 WS
 * - 角色卡定义人设、说话风格、示例对话，支持 SillyTavern V2 卡片
 * - 每个群可以独立切换角色与模型，与 dsh 主会话互不影响
 * - 配置通过 dsh 设置页的「插件配置」卡片编辑，改完即时生效，无需重启
 *
 * @module dsh-plugin-qq-groupmate
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { loadCharacterCards } from "./character.js";
import { KnowledgeBase, resolveKnowledgeSettings } from "./knowledge.js";
import { ProtocolSideLauncher } from "./launcher.js";
import { createModelResolver } from "./models.js";
import { OutboundFilter } from "./outbound-filter.js";
import { Learner } from "./learner.js";
import { CommandHandler } from "./commands.js";
import { createEventDispatcher } from "./dispatch.js";
import { GroupManager } from "./group.js";
import { ImageGenClient } from "./imagegen.js";
import { NaiModelPolicy } from "./nai-policy.js";
import { PresetStore } from "./nai-presets.js";
import { resolveBridgePath } from "./rphub-browser.js";
import { createTeeLogger } from "./log.js";
import { MemoryWriter } from "./memory.js";
import { NoteEngine } from "./notes.js";
import { StickerLibrary } from "./stickers.js";
import { SummaryEngine } from "./summary.js";
import { ApiLlmClient, createLlmRouter, normalizeApiProviders, splitProviderModel } from "./api-client.js";
import { OneBotClient, OneBotServer } from "./onebot.js";
import { registerSessionCommands } from "./session-commands.js";
import { expandHome, resolveDshHome } from "./store.js";
import { BridgeWatcher, defaultBridgeEventsDir } from "./bridge.js";
import { DesktopAgent } from "./desktop.js";
import { TarotGame } from "./tarot.js";
import { NativeVoiceLibrary } from "./native-voice.js";
import { RecallStore } from "./recall.js";
import { VoiceClient, normalizeVoiceLanguage } from "./voice.js";
import { WeatherService } from "./weather.js";
import { WifeGame, defaultWifeSettings } from "./wife.js";
import { PeopleStore, defaultPeopleSettings } from "./people.js";
import { ReminderStore, defaultReminderSettings } from "./reminders.js";
import { ReminderScheduler } from "./reminder-scheduler.js";
import { ToolRunner } from "./agent-tools.js";
/** Cordis 插件名。 */
export const name = 'qq-groupmate';
/** 依赖 dsh 的 LLM 服务；未就绪前不加载。 */
export const inject = ['llm'];
/** 设置命名空间：插件配置卡片的配对键，必须与浏览器半写的键一致。 */
export const NS = 'qq-groupmate';
/** 设置命名空间：运行状态（由插件写入，卡片只读展示）。 */
export const STATUS_NS = 'qq-groupmate-status';
/** 配置 schema：同时供设置页渲染表单与写入门禁。 */
export const Config = z.object({
    mode: z.union([z.const('forward'), z.const('reverse')]),
    wsUrl: z.string(),
    listenPort: z.number().step(1).min(1).max(65535).default(3001),
    listenHost: z.string().default('127.0.0.1'),
    accessToken: z.string(),
    dataDir: z.string(),
    logFile: z.string().default('qq-groupmate.log'),
    charactersDir: z.string(),
    knowledgeDir: z.string(),
    knowledge: z.object({
        enabled: z.boolean().default(false),
        dir: z.string().default(''),
    }),
    defaultCharacter: z.string().default('default'),
    provider: z.string().default('deepseek-official'),
    model: z.string().default('deepseek-v4-flash'),
    temperature: z.number().min(0).max(2).default(1),
    maxTokens: z.number().step(1).min(16).max(32768).default(512),
    commandPrefix: z.string().default('.'),
    admins: z.array(z.string()).default([]),
    trigger: z.object({
        mention: z.boolean().default(true),
        prefixes: z.array(z.string()).default([]),
        randomChance: z.number().min(0).max(1).default(0),
        cooldownSeconds: z.number().min(0).max(3600).default(5),
        randomCooldownSeconds: z.number().min(0).max(86400).default(90),
        replyToSelf: z.boolean().default(true),
        privateChat: z.boolean().default(true),
    }),
    context: z.object({
        maxTurns: z.number().step(1).min(1).max(500).default(30),
        maxChars: z.number().step(1).min(200).max(100000).default(6000),
    }),
    memory: z.object({
        enabled: z.boolean().default(true),
        // 分层记忆：归档保留天数。旧的摘要字段（batchMessages / keepMessages / mergeCount…）
        // 留在 schema 里保证老配置还能解析，但设置页已经不再暴露——那条「压缩后每轮注入」的路线整体下线了。
        retainDays: z.number().step(1).min(7).max(3650).default(120),
        provider: z.string(),
        model: z.string(),
        batchMessages: z.number().step(1).min(4).max(500).default(40),
        keepMessages: z.number().step(1).min(0).max(500).default(0),
        mergeCount: z.number().step(1).min(2).max(20).default(5),
        reasoningEffort: z.string().default('off'),
        temperature: z.number().min(0).max(2).default(0.2),
        maxTokens: z.number().step(1).min(64).max(32768).default(2000),
    }),
    learner: z.object({
        enabled: z.boolean().default(false),
        provider: z.string(),
        model: z.string(),
        batchMessages: z.number().step(1).min(4).max(500).default(60),
        keepMessages: z.number().step(1).min(0).max(500).default(40),
        maxChars: z.number().step(1).min(100).max(2000).default(400),
        bannedWords: z.array(z.string()).default([]),
        skipGroups: z.array(z.string()).default([]),
        skipSpeakers: z.array(z.string()).default([]),
        reasoningEffort: z.string().default('off'),
        temperature: z.number().min(0).max(2).default(0.2),
        maxTokens: z.number().step(1).min(64).max(32768).default(2000),
    }),
    models: z.array(z.object({
        name: z.string().default(''),
        provider: z.string().default(''),
        model: z.string().default(''),
    })).default([]),
    modelSlots: z.object({
        chat: z.object({ model: z.string().default(''), backup: z.string().default('') }),
        summary: z.object({ model: z.string().default(''), backup: z.string().default('') }),
        learner: z.object({ model: z.string().default(''), backup: z.string().default('') }),
        vision: z.object({ model: z.string().default(''), backup: z.string().default('') }),
    }),
    protocolSide: z.object({
        mode: z.union([z.const('local'), z.const('external')]).default('local'),
        command: z.string().default(''),
        workDir: z.string().default(''),
        autoStart: z.boolean().default(true),
        autoStop: z.boolean().default(false),
        showConsole: z.boolean().default(true),
        readyPort: z.number().step(1).min(0).max(65535).default(0),
        readyTimeoutSeconds: z.number().step(1).min(5).max(600).default(120),
        webuiUrl: z.string().default('http://127.0.0.1:5099'),
        logFile: z.string().default(''),
    }),
    protocolSideAction: z.string().default(''),
    protocolSideToken: z.number().step(1).default(0),
    modelFetchProvider: z.string().default(''),
    modelFetchToken: z.number().step(1).default(0),
    groups: z.dict(z.object({
        enabled: z.boolean(),
        character: z.string(),
        provider: z.string(),
        model: z.string(),
        /** 该群的备用模型（模型配置名或 `服务商/模型名`）。 */
        backup: z.string(),
        temperature: z.number().min(0).max(2),
        maxTokens: z.number().step(1).min(16).max(32768),
        randomChance: z.number().min(0).max(1),
        mention: z.boolean(),
        prefixes: z.array(z.string()),
        /** 改这个数字会清空该群记忆（设置页「清空记忆」按钮用）。 */
        resetToken: z.number(),
    })),
    vision: z.object({
        enabled: z.boolean().default(false),
        model: z.string().default(''),
        maxImages: z.number().step(1).min(1).max(10).default(3),
        maxBytes: z.number().step(1).min(1024).max(20000000).default(1572864),
    }),
    stickers: z.object({
        enabled: z.boolean().default(false),
        dir: z.string().default(''),
        maxListed: z.number().step(1).min(1).max(200).default(30),
        probability: z.number().min(0).max(1).default(0.2),
    }),
    imageGen: z.object({
        enabled: z.boolean().default(false),
        baseUrl: z.string().default(''),
        token: z.string().default(''),
        model: z.string().default('nai-diffusion-4-5-full'),
        size: z.string().default('竖图'),
        steps: z.number().step(1).min(1).max(28).default(28),
        scale: z.number().min(0).max(20).default(6),
        sampler: z.string().default('k_dpmpp_2m_sde'),
        artist: z.string().default(''),
        negative: z.string().default(''),
        timeoutSeconds: z.number().step(1).min(30).max(1800).default(300),
        // 0 = 按尺寸自动估算（普通 1、2K 15、4K 25），填了就按填的点数记。
        cost: z.number().step(1).min(0).max(100).default(0),
        maxPerReply: z.number().step(1).min(1).max(4).default(1),
        maxQueue: z.number().step(1).min(1).max(20).default(3),
        downloadConnections: z.number().step(1).min(1).max(4).default(2),
        sendMode: z.string().default('url'),
        notifyOnFailure: z.boolean().default(true),
        // 网页引擎：无头浏览器驱动线上生图页面（参数模板全是网页自己的），出图后走中转下载。
        browser: z.boolean().default(true),
        browserPath: z.string().default(''),
        browserPort: z.number().step(1).min(1024).max(65535).default(9333),
        // 生图页面地址（自建/自托管的 NAI 生图网页）。留空表示不启用网页引擎，只走下面的直连接口。
        pageUrl: z.string().default(''),
        // wsrv.nl 中转下载：直连这条线路到源站被限速（~25KB/s），中转 200~800KB/s。
        relay: z.boolean().default(true),
        relayConnections: z.number().step(1).min(1).max(8).default(6),
        // 图片下面的信息标签（`V5 | 绝区零游戏风 | 耗时37秒`），移植作者插件的做法。
        showImageInfo: z.boolean().default(true),
        // V5 专属：内置画风的画师串留空待填（作者分发包不带那份数据），这里统一兜底。
        v5FallbackArtist: z.string().default(''),
        // 逐个画风的画师串（设置页「画风预设」）；拿到作者那份 v5_presets.json 后直接贴这里。
        presetArtists: z.dict(z.string()).default({}),
        v5DailyLimit: z.number().step(1).min(0).max(100).default(4),
        v5UnlimitedUsers: z.array(z.string()).default([]),
    }),
    outboundFilter: z.object({
        enabled: z.boolean().default(true),
        mode: z.string().default('block'),
        bannedWords: z.array(z.string()).default([]),
    }),
    weather: z.object({
        enabled: z.boolean().default(true),
        locationName: z.string().default(''),
        autoDetectFromIp: z.boolean().default(true),
        latitude: z.number().default(0),
        longitude: z.number().default(0),
    }),
    notes: z.object({
        enabled: z.boolean().default(true),
        provider: z.string().default(''),
        model: z.string().default(''),
        backup: z.string().default(''),
        delayMinMinutes: z.number().step(1).min(1).max(1440).default(30),
        delayMaxMinutes: z.number().step(1).min(1).max(2880).default(120),
        cooldownHours: z.number().step(1).min(1).max(720).default(24),
        weeklyLimit: z.number().step(1).min(1).max(20).default(3),
        requiredQuietMinutes: z.number().step(1).min(0).max(1440).default(10),
        temperature: z.number().min(0).max(2).default(0.8),
        maxTokens: z.number().step(1).min(64).max(8192).default(800),
        reasoningEffort: z.string().default('off'),
    }),
    voice: z.object({
        enabled: z.boolean().default(true),
        endpoint: z.string().default('http://127.0.0.1:9880/tts'),
        japaneseEndpoint: z.string().default('http://127.0.0.1:9881/tts'),
        language: z.string().default('auto'),
        hostPath: z.string().default(''),
        autoStart: z.boolean().default(true),
        refsDir: z.string().default(''),
        japaneseRefsDir: z.string().default(''),
        probability: z.number().min(0).max(1).default(1),
        maxChars: z.number().step(1).min(20).max(2000).default(200),
    }),
    desktop: z.object({
        enabled: z.boolean().default(false),
    }),
    wife: z.object({
        enabled: z.boolean().default(true),
        dailyLimit: z.number().step(1).min(1).max(10).default(1),
        activeDays: z.number().step(1).min(1).max(30).default(30),
        atWife: z.boolean().default(true),
        keywordTrigger: z.boolean().default(true),
        excludedUsers: z.array(z.string()).default([]),
        forceCooldownDays: z.number().step(1).min(0).max(30).default(3),
        breakupCooldownHours: z.number().step(1).min(0).max(720).default(72),
    }),
    tarot: z.object({
        enabled: z.boolean().default(true),
        aiEnabled: z.boolean().default(true),
        model: z.string().default(''),
        aiTimeoutSeconds: z.number().step(1).min(5).max(300).default(30),
        cooldownSeconds: z.number().step(1).min(0).max(3600).default(10),
        dailyCountLimit: z.number().step(1).min(0).max(100).default(0),
        persona: z.string().default('random'),
        disclaimer: z.string().default(''),
        shuffleLines: z.boolean().default(true),
        dailyFixed: z.boolean().default(true),
    }),
    bridge: z.object({
        enabled: z.boolean().default(true),
        eventsDir: z.string().default(''),
        notifyUsers: z.array(z.string()).default([]),
        notifyGroups: z.array(z.string()).default([]),
        voice: z.boolean().default(true),
    }),
    web: z.object({
        enabled: z.boolean().default(true),
        searchUrl: z.string().default('https://cn.bing.com/search'),
        maxResults: z.number().step(1).min(1).max(10).default(6),
        timeoutMs: z.number().step(1).min(5000).max(60000).default(15000),
        customBaseUrl: z.string().default(''),
        customApiKey: z.string().default(''),
    }),
    people: z.object({
        enabled: z.boolean().default(true),
        crossGroupEnabled: z.boolean().default(true),
        privateToGroup: z.boolean().default(true),
        crossGroupExclude: z.array(z.string()).default([]),
        peopleMaxInject: z.number().step(1).min(0).max(20).default(6),
        eventsMaxInject: z.number().step(1).min(0).max(20).default(6),
        maxChars: z.number().step(1).min(300).max(6000).default(1400),
        factsPerPersonInject: z.number().step(1).min(1).max(8).default(3),
        decayHalfLifeDays: z.number().step(1).min(1).max(365).default(30),
        decayMinWeight: z.number().step(0.01).min(0).max(1).default(0.08),
        decayMinAgeDays: z.number().step(1).min(0).max(365).default(7),
        keepImportance: z.number().step(1).min(1).max(5).default(4),
        maxFactsPerPerson: z.number().step(1).min(3).max(50).default(12),
        maxEventsPerChat: z.number().step(1).min(10).max(500).default(150),
        maxEventsTotal: z.number().step(1).min(20).max(2000).default(400),
        surfaceEnabled: z.boolean().default(true),
        surfaceTtlMinutes: z.number().step(1).min(1).max(1440).default(10),
        surfaceMaxPerPerson: z.number().step(1).min(1).max(200).default(50),
        surfaceMaxInject: z.number().step(1).min(0).max(20).default(6),
        decayIntervalHours: z.number().step(1).min(0).max(720).default(24),
    }),
    reminders: z.object({
        enabled: z.boolean().default(true),
        minDelaySec: z.number().step(1).min(0).max(3600).default(30),
        catchUpMinutes: z.number().step(1).min(0).max(10080).default(720),
        maxPending: z.number().step(1).min(1).max(2000).default(200),
        maxPendingPerChat: z.number().step(1).min(1).max(100).default(20),
        maxPerDay: z.number().step(1).min(1).max(200).default(20),
        ttlDays: z.number().step(1).min(1).max(3650).default(400),
        mentionTarget: z.boolean().default(true),
        voice: z.boolean().default(true),
    }),
    apiProviders: z.array(z.object({
        id: z.string().default(''),
        protocol: z.string().default('openai'),
        baseUrl: z.string().default(''),
        apiKey: z.string().default(''),
        headers: z.dict(z.string()).default({}),
    })).default([]),
    allowGroups: z.array(z.string()).default([]),
    allowUsers: z.array(z.string()).default([]),
    reloadToken: z.number().step(1).default(0),
});
/** 运行状态 schema。 */
export const Status = z.object({
    state: z.string().default('idle'),
    self: z.string().default(''),
    detail: z.string().default('插件尚未启动'),
    groups: z.array(z.object({
        id: z.string(),
        messages: z.number().step(1).default(0),
        summaries: z.number().step(1).default(0),
        character: z.string().default(''),
        model: z.string().default(''),
    })).default([]),
    privateChats: z.array(z.object({
        id: z.string(),
        messages: z.number().step(1).default(0),
        summaries: z.number().step(1).default(0),
    })).default([]),
    characters: z.array(z.string()).default([]),
    providers: z.array(z.string()).default([]),
    modelFallback: z.string().default(''),
    modelCatalog: z.object({
        provider: z.string().default(''),
        models: z.array(z.string()).default([]),
        at: z.number().step(1).default(0),
        pending: z.boolean().default(false),
        error: z.string().default(''),
    }).default({ provider: '', models: [], at: 0, pending: false, error: '' }),
    presets: z.object({
        v45: z.array(z.object({
            name: z.string().default(''),
            desc: z.string().default(''),
            builtin: z.boolean().default(false),
            overridden: z.boolean().default(false),
            filled: z.boolean().default(false),
            preview: z.string().default(''),
        })).default([]),
        v5: z.array(z.object({
            name: z.string().default(''),
            desc: z.string().default(''),
            builtin: z.boolean().default(false),
            overridden: z.boolean().default(false),
            filled: z.boolean().default(false),
            preview: z.string().default(''),
        })).default([]),
    }).default({ v45: [], v5: [] }),
    protocolSide: z.object({
        mode: z.string().default('local'),
        state: z.string().default('stopped'),
        pid: z.number().step(1).default(0),
        owned: z.boolean().default(false),
        detail: z.string().default(''),
        webuiUrl: z.string().default(''),
        command: z.string().default(''),
    }).default({
        mode: 'local',
        state: 'stopped',
        pid: 0,
        owned: false,
        detail: '协议端未运行',
        webuiUrl: '',
        command: '',
    }),
});
/** 解析连接方式：显式 mode 优先，否则有 wsUrl 走正向、没有则走反向。 */
function resolveMode(config) {
    if (config.mode !== undefined)
        return config.mode;
    return config.wsUrl?.trim() ? 'forward' : 'reverse';
}
/** 校验配置里 Schema 表达不了的约束；设置页写入时也会经过这里。 */
function assertConfig(config) {
    const mode = resolveMode(config);
    if (mode === 'forward') {
        const url = config.wsUrl?.trim() ?? '';
        if (!/^wss?:\/\//iu.test(url)) {
            throw new Error('正向模式需要合法 wsUrl，例如 ws://127.0.0.1:3001');
        }
    }
    if ((config.commandPrefix ?? '.').trim() === '') {
        throw new Error('commandPrefix 不能为空字符串');
    }
    const protocolSideMode = config.protocolSide?.mode;
    if (protocolSideMode !== undefined && protocolSideMode !== 'local' && protocolSideMode !== 'external') {
        throw new Error('protocolSide.mode 只能是 local（本地托管）或 external（外部手动）');
    }
}
/** 从连接配置推断就绪端口：正向取 wsUrl 端口，反向取 listenPort。 */
function defaultReadyPort(config) {
    if (resolveMode(config) === 'forward') {
        try {
            const parsed = new URL(config.wsUrl?.trim() ?? '');
            if (parsed.port !== '')
                return Number(parsed.port);
        }
        catch {
            // wsUrl 不合法时由 assertConfig 报错，这里只给个兜底值。
        }
        return 3001;
    }
    return config.listenPort ?? 3001;
}
/** 取第一个非空的引用（模型分配槽优先，其次各自的老字段）。 */
function firstRef(...values) {
    for (const value of values) {
        const text = value?.trim();
        if (text !== undefined && text !== '')
            return text;
    }
    return undefined;
}
/** 按尺寸估一次生成的点数：普通 1 点，2K 15 点，4K 25 点（跟服务端一致）。 */
function defaultImageCost(size) {
    if (size.startsWith('4K'))
        return 25;
    if (size.startsWith('2K'))
        return 15;
    return 1;
}
/** 一份通用的负面提示词：画图常见的坏手坏脸、水印文字都在里面。 */
export const DEFAULT_IMAGE_NEGATIVE = [
    '{{{bad anatomy}}}', '{bad feet}', 'bad hands', '{{{bad proportions}}}', '{blurry}',
    'cloned face', 'cropped', '{{{deformed}}}', '{{{disfigured}}}', 'error',
    '{{{extra arms}}}', '{extra digit}', '{{{extra legs}}}', 'extra limbs', '{{extra limbs}}',
    '{fewer digits}', '{{{fused fingers}}}', 'gross proportions', 'ink eyes', 'ink hair',
    'jpeg artifacts', '{{{{long neck}}}}', 'low quality', '{malformed limbs}', '{{missing arms}}',
    '{missing fingers}', '{{missing legs}}', 'mutated hands', '{{{mutation}}}', 'normal quality',
    'owres', '{{poorly drawn face}}', '{{poorly drawn hands}}', 'signature', 'text',
    '{{too many fingers}}', '{{{ugly}}}', 'username', 'watermark', 'worst quality',
].join(',');
/**
 * 随包资源目录（lib/ 的上一级）。
 *
 * 刚装完时数据目录（DSH_HOME/qq-groupmate）还是空的，示例角色卡与塔罗卡面就先从包内读；
 * 用户把自己的卡片放进数据目录后，自动优先用数据目录里的那份。
 */
function bundledAssetPath(...segments) {
    return join(dirname(fileURLToPath(import.meta.url)), '..', ...segments);
}
/** 解析生图配置：补默认值、折算点数、去掉地址尾部斜杠。 */
export function resolveImageGenSettings(config, dataDir = '') {
    const size = config.size?.trim() === '' || config.size === undefined ? '竖图' : config.size.trim();
    const rawCost = config.cost ?? 0;
    const stateDir = dataDir === '' ? '' : `${dataDir}/nai`;
    return {
        enabled: config.enabled === true,
        baseUrl: config.baseUrl?.trim() === '' || config.baseUrl === undefined
            ? ''
            : config.baseUrl.trim().replace(/\/+$/u, ''),
        token: (config.token ?? '').trim(),
        model: config.model?.trim() === '' || config.model === undefined ? 'nai-diffusion-4-5-full' : config.model.trim(),
        size,
        steps: config.steps ?? 28,
        scale: config.scale ?? 6,
        sampler: config.sampler?.trim() === '' || config.sampler === undefined ? 'k_dpmpp_2m_sde' : config.sampler.trim(),
        artist: (config.artist ?? '').trim(),
        negative: (config.negative ?? '').trim() === '' ? DEFAULT_IMAGE_NEGATIVE : (config.negative ?? '').trim(),
        timeoutSeconds: config.timeoutSeconds ?? 300,
        cost: rawCost > 0 ? rawCost : defaultImageCost(size),
        maxPerReply: config.maxPerReply ?? 1,
        maxQueue: config.maxQueue ?? 3,
        downloadConnections: config.downloadConnections ?? 2,
        sendMode: config.sendMode?.trim().toLowerCase() === 'base64' ? 'base64' : 'url',
        notifyOnFailure: config.notifyOnFailure !== false,
        browserEnabled: config.browser === true && (config.pageUrl ?? '').trim() !== '',
        browserPath: (config.browserPath ?? '').trim(),
        browserPort: config.browserPort !== undefined && config.browserPort >= 1024 ? config.browserPort : 9333,
        pageUrl: (config.pageUrl ?? '').trim(),
        relayEnabled: config.relay !== false,
        relayConnections: config.relayConnections !== undefined && config.relayConnections >= 1
            ? Math.min(8, Math.floor(config.relayConnections))
            : 6,
        showImageInfo: config.showImageInfo !== false,
        v5FallbackArtist: (config.v5FallbackArtist ?? '').trim(),
        v5DailyLimit: config.v5DailyLimit ?? 4,
        v5UnlimitedUsers: (config.v5UnlimitedUsers ?? []).map(id => id.trim()).filter(id => id !== ''),
        stateDir: stateDir === '' ? `${resolveDshHome()}/qq-groupmate/nai` : stateDir,
    };
}
/** 解析协议端托管设置。 */
function resolveProtocolSide(config, dataDir) {
    const raw = config.protocolSide ?? {};
    const configuredLog = raw.logFile?.trim();
    const logFile = configuredLog === undefined || configuredLog === ''
        ? `${dataDir}/protocol-side.log`
        : expandHome(/[/\\]/u.test(configuredLog) ? configuredLog : `${dataDir}/${configuredLog}`);
    const readyPort = (raw.readyPort ?? 0) > 0 ? raw.readyPort : defaultReadyPort(config);
    return {
        mode: raw.mode === 'external' ? 'external' : 'local',
        command: raw.command?.trim() ?? '',
        workDir: expandHome(raw.workDir?.trim() ?? ''),
        autoStart: raw.autoStart !== false,
        autoStop: raw.autoStop === true,
        showConsole: raw.showConsole !== false,
        readyPort,
        readyTimeoutSeconds: raw.readyTimeoutSeconds ?? 120,
        webuiUrl: raw.webuiUrl?.trim() || 'http://127.0.0.1:5099',
        logFile,
    };
}
/** cordis fiber 状态：与 `@deepseek-ai/dsh-settings` 内部使用的常量一致。 */
const FIBER_DISPOSED = 4;
const FIBER_UNLOADING = 5;
/** 解析日志文件路径：相对路径落到数据目录下，空值表示不写文件。 */
function resolveLogPath(config, dataDir) {
    const logName = config.logFile?.trim();
    if (logName === undefined || logName === '')
        return undefined;
    return expandHome(/[/\\]/u.test(logName) ? logName : `${dataDir}/${logName}`);
}
/** 读一眼状态文件里已记录的群号，供记忆说明页展示。 */
function readGroups(dataDir) {
    try {
        const parsed = JSON.parse(readFileSync(`${dataDir}/state.json`, 'utf8'));
        return parsed.groups ?? {};
    }
    catch {
        return {};
    }
}
/** 按配置组装运行时：日志、角色卡、连接、会话、命令。 */
function createRuntime(ctx, config, logger, reportStatus, onModelBackup) {
    assertConfig(config);
    const mode = resolveMode(config);
    const home = resolveDshHome();
    const dataDir = expandHome(config.dataDir?.trim() || `${home}/qq-groupmate`);
    let charactersDir = expandHome(config.charactersDir?.trim() || `${dataDir}/characters`);
    const knowledgeSettings = resolveKnowledgeSettings(config, dataDir);
    const knowledgeDir = expandHome(knowledgeSettings.dir);
    let characters = loadCharacterCards(charactersDir, logger);
    // 数据目录里一张卡都没有，又没手动指定目录：用随包的示例角色卡兜底。
    if (characters.size === 0 && (config.charactersDir?.trim() ?? '') === '') {
        const bundledDir = bundledAssetPath('characters');
        if (bundledDir !== charactersDir) {
            const bundled = loadCharacterCards(bundledDir, logger);
            if (bundled.size > 0) {
                charactersDir = bundledDir;
                characters = bundled;
            }
        }
    }
    if (characters.size === 0) {
        logger.warn('qq-groupmate: 角色卡目录 %s 里没有可用角色卡，请放入 JSON 角色卡（或设置 charactersDir）', charactersDir);
    }
    else {
        logger.info('qq-groupmate: 已加载 %s 张角色卡：%s', String(characters.size), [...characters.keys()].join('、'));
    }
    // 知识库：默认关闭。开着的时候群友消息命中知识条目会注入提示词，而知识文档
    // 一旦是别人家的内容（仓库自带 FAQ 就是），机器人容易当成群内事实讲。
    const knowledge = knowledgeSettings.enabled ? new KnowledgeBase(knowledgeDir, logger) : undefined;
    if (knowledge === undefined) {
        logger.info('qq-groupmate: 知识库已关闭（默认关；要用请在设置页「知识库」里打开，并把文档换成自己社群的内容）');
    }
    else if (knowledge.size > 0) {
        logger.info('qq-groupmate: 已加载知识库 %s 条（%s）', String(knowledge.size), knowledgeDir);
    }
    const defaults = {
        characterId: config.defaultCharacter ?? 'default',
        provider: config.provider ?? 'deepseek-official',
        model: config.model ?? 'deepseek-v4-flash',
        temperature: config.temperature ?? 1,
        maxTokens: config.maxTokens ?? 512,
        mention: config.trigger?.mention ?? true,
        prefixes: (config.trigger?.prefixes ?? []).filter(prefix => prefix.trim() !== ''),
        randomChance: config.trigger?.randomChance ?? 0,
        cooldownSeconds: config.trigger?.cooldownSeconds ?? 5,
        randomCooldownSeconds: config.trigger?.randomCooldownSeconds ?? 90,
        replyToSelf: config.trigger?.replyToSelf ?? true,
        maxTurns: config.context?.maxTurns ?? 30,
        maxChars: config.context?.maxChars ?? 6000,
        privateChat: config.trigger?.privateChat ?? true,
        allowGroups: (config.allowGroups ?? []).map(id => id.trim()).filter(id => id !== ''),
        allowUsers: (config.allowUsers ?? []).map(id => id.trim()).filter(id => id !== ''),
        admins: (config.admins ?? []).map(id => id.trim()).filter(id => id !== ''),
    };
    // 独立 API 服务商：命中就用自己的 HTTP 客户端，否则回落 dsh 的 LLM 服务。
    const apiClient = new ApiLlmClient(normalizeApiProviders(config.apiProviders, logger));
    const llm = createLlmRouter(ctx.llm, apiClient, logger, (info) => {
        onModelBackup(info);
    });
    if (apiClient.ids.length > 0)
        logger.info('qq-groupmate: 自定义 API 服务商：%s', apiClient.ids.join('、'));
    // 默认模型也允许写成 `服务商id/模型名`，日志和记忆索引里显示拆开后的结果。
    const knownProvider = (id) => llm.listProviders().some(item => item.id === id);
    const resolvedDefault = splitProviderModel(defaults.provider, defaults.model, knownProvider);
    // 模型配置清单：各处（群聊/总结/学习/识图/单个群）按名字引用，还能各配一个备用模型。
    const models = createModelResolver({
        presets: config.models,
        defaultModel: resolvedDefault,
        isKnownProvider: knownProvider,
        logger,
    });
    if (models.names().length > 0)
        logger.info('qq-groupmate: 已配置 %s 个模型：%s', String(models.names().length), models.names().join('、'));
    const chatSlot = models.resolveSlot(config.modelSlots?.chat, resolvedDefault);
    defaults.provider = chatSlot.primary.provider;
    defaults.model = chatSlot.primary.model;
    // 分发器先于 endpoint 构造：endpoint 的事件回调通过闭包引用它。
    let dispatch = () => { };
    const onStateChange = (connected, selfId) => {
        reportStatus(connected
            ? {
                state: 'connected',
                self: selfId === undefined ? '' : String(selfId),
                detail: selfId === undefined ? '已连接协议端' : `已登录 QQ ${String(selfId)}`,
            }
            : { state: 'disconnected', self: '', detail: '等待协议端接入（检查 QQ 协议端是否已登录）' });
    };
    const endpoint = mode === 'forward'
        ? new OneBotClient({
            wsUrl: (config.wsUrl ?? '').trim(),
            accessToken: config.accessToken,
            logger,
            onEvent: event => dispatch(event),
            onStateChange,
        })
        : new OneBotServer({
            listenPort: config.listenPort ?? 3001,
            listenHost: config.listenHost ?? '127.0.0.1',
            accessToken: config.accessToken,
            logger,
            onEvent: event => dispatch(event),
            onStateChange,
        });
    // 人类可读记忆：和工作区里的记录同步，方便直接翻看或让 agent 整理。
    const memory = new MemoryWriter(dataDir, logger);
    memory.writeIndex({
        mode: mode === 'forward' ? '正向 WS' : '反向 WS',
        endpoint: mode === 'forward' ? (config.wsUrl ?? '') : `${config.listenHost ?? '127.0.0.1'}:${String(config.listenPort ?? 3001)}`,
        provider: defaults.provider,
        model: defaults.model,
        character: defaults.characterId,
        characters: [...characters.keys()],
        groups: Object.keys(readGroups(dataDir)),
    });
    // 分层记忆（2026-09-18 起）：旧聊天按小时归档，模型写 [回忆:] 时再检索；
    // 下面这个 summaries 实例保留给旧数据与回退用，正常路径已不再触发它做总结。
    const memoryConfig = config.memory ?? {};
    const summaries = memoryConfig.enabled === false
        ? undefined
        : new SummaryEngine({
            llm,
            logger,
            dir: `${dataDir}/memory/summaries`,
            knownProvider,
            models,
            settings: {
                enabled: true,
                provider: memoryConfig.provider?.trim() === '' ? undefined : memoryConfig.provider,
                model: firstRef(config.modelSlots?.summary?.model, memoryConfig.model),
                backup: firstRef(config.modelSlots?.summary?.backup, memoryConfig.backup),
                batchMessages: memoryConfig.batchMessages ?? 40,
                // 0 = 跟随上下文条数：总结只压缩会掉出上下文窗口的部分，聊天时上下文更完整。
                keepMessages: (memoryConfig.keepMessages ?? 0) > 0
                    ? memoryConfig.keepMessages
                    : (config.context?.maxTurns ?? 30),
                mergeCount: memoryConfig.mergeCount ?? 5,
                reasoningEffort: memoryConfig.reasoningEffort?.trim() === '' ? undefined : memoryConfig.reasoningEffort,
                temperature: memoryConfig.temperature ?? 0.2,
                maxTokens: memoryConfig.maxTokens ?? 2000,
            },
        });
    if (summaries !== undefined) {
        logger.info('qq-groupmate: 总结记忆每 %s 条压一次，最近 %s 条保持原文（0 表示跟随上下文条数）', String(memoryConfig.batchMessages ?? 40), String((memoryConfig.keepMessages ?? 0) > 0 ? memoryConfig.keepMessages : (config.context?.maxTurns ?? 30)));
    }
    const visionConfig = config.vision ?? {};
    const vision = {
        enabled: visionConfig.enabled === true,
        model: firstRef(config.modelSlots?.vision?.model, visionConfig.model),
        backup: firstRef(config.modelSlots?.vision?.backup, visionConfig.backup),
        maxImages: visionConfig.maxImages ?? 3,
        maxBytes: visionConfig.maxBytes ?? 1572864,
    };
    if (vision.enabled)
        logger.info('qq-groupmate: 识图已开启（模型 %s）', vision.model ?? '跟随当前模型');
    // 说话风格持续学习：从群友发言里提炼腔调，让回复更像人（默认关闭）。
    const learnerConfig = config.learner ?? {};
    const learner = new Learner({
        llm,
        logger,
        dir: `${dataDir}/learned`,
        knownProvider,
        models,
        settings: {
            enabled: learnerConfig.enabled === true,
            provider: learnerConfig.provider?.trim() === '' ? undefined : learnerConfig.provider,
            model: firstRef(config.modelSlots?.learner?.model, learnerConfig.model),
            backup: firstRef(config.modelSlots?.learner?.backup, learnerConfig.backup),
            batchMessages: learnerConfig.batchMessages ?? 60,
            keepMessages: learnerConfig.keepMessages ?? 40,
            maxChars: learnerConfig.maxChars ?? 400,
            bannedWords: (learnerConfig.bannedWords ?? []).map(word => word.trim()).filter(word => word !== ''),
            skipGroups: (learnerConfig.skipGroups ?? []).map(id => id.trim()).filter(id => id !== ''),
            skipSpeakers: (learnerConfig.skipSpeakers ?? []).map(word => word.trim()).filter(word => word !== ''),
            reasoningEffort: learnerConfig.reasoningEffort?.trim() === '' ? undefined : learnerConfig.reasoningEffort,
            temperature: learnerConfig.temperature ?? 0.2,
            maxTokens: learnerConfig.maxTokens ?? 2000,
        },
    });
    if (learner.enabled) {
        logger.info('qq-groupmate: 风格学习已开启（每 %s 条群友消息提炼一次，禁用词：%s）', String(learnerConfig.batchMessages ?? 60), (learnerConfig.bannedWords ?? []).filter(word => word.trim() !== '').join('、') || '（无）');
    }
    const stickerConfig = config.stickers ?? {};
    const stickers = new StickerLibrary({
        enabled: stickerConfig.enabled === true,
        dir: expandHome(stickerConfig.dir?.trim() === '' || stickerConfig.dir === undefined
            ? `${dataDir}/stickers`
            : stickerConfig.dir),
        maxListed: stickerConfig.maxListed ?? 30,
        probability: stickerConfig.probability ?? 0.2,
    }, logger);
    // 生图：接 Nai2API 兼容服务，模型输出 [生图:标签] 就后台画一张发出去。
    // 画风/模型/额度这套移植自大佬的 AstrBot 插件 astrbot_plugin_nai2api：
    // 预设库管 V4.5 预设与 V5 画风，策略库管按 QQ 的模型选择与 V5 的 24 小时额度。
    const imageGenConfig = config.imageGen ?? {};
    const imageGenSettings = resolveImageGenSettings(imageGenConfig, dataDir);
    const presets = new PresetStore({
        dir: imageGenSettings.stateDir,
        v5FallbackArtist: imageGenSettings.v5FallbackArtist,
        presetArtists: imageGenConfig.presetArtists ?? {},
    }, logger);
    if (imageGenConfig.enabled === true) {
        const unknown = presets.unknownArtistOverrides();
        if (unknown.length > 0) {
            logger.warn('qq-groupmate: 设置页「画风预设」里有 %s 个名字不在画风库里，等于没填：%s', String(unknown.length), unknown.join('、'));
        }
        const filledV5 = presets.describe('nai-diffusion-5-full').filter(entry => entry.overridden).length;
        if (filledV5 > 0) {
            logger.info('qq-groupmate: 画风预设里有 %s 个画师串来自设置页（覆盖内置/自定义）', String(filledV5));
        }
    }
    const policy = new NaiModelPolicy({
        path: `${imageGenSettings.stateDir}/model_policy.json`,
        v5DailyLimit: imageGenSettings.v5DailyLimit,
        v5UnlimitedUsers: imageGenSettings.v5UnlimitedUsers,
    }, logger);
    const imageGen = new ImageGenClient(imageGenSettings, logger, policy);
    if (imageGenConfig.enabled === true) {
        if (imageGen.enabled) {
            logger.info('qq-groupmate: 生图已开启（%s，模型 %s，尺寸 %s，每次最多 %s 张；%s）', imageGen.settings.baseUrl, imageGen.settings.model, imageGen.settings.size, String(imageGen.settings.maxPerReply), imageGen.settings.browserEnabled
                ? `网页引擎主路，调试端口 ${String(imageGen.settings.browserPort)}${imageGen.settings.relayEnabled ? '，中转下载' : '，直连下载'}`
                : '直连接口（网页引擎已关）');
            if (imageGen.settings.browserEnabled) {
                const bridge = resolveBridgePath();
                if (bridge === undefined) {
                    logger.warn('qq-groupmate: 生图桥接脚本没找到（rphub/qq-bridge.js），网页引擎会失败并退回直连——重装插件时记得把它一起拷过去');
                }
                else {
                    logger.info('qq-groupmate: 生图桥接脚本：%s', bridge);
                }
            }
            logger.info('qq-groupmate: 画风预设 V4.5 %s 个、V5 %s 个；V5 每 24 小时 %s 张（白名单 %s）', String(Object.keys(presets.list('nai-diffusion-4-5-full')).length), String(Object.keys(presets.list('nai-diffusion-5-full')).length), imageGen.settings.v5DailyLimit <= 0 ? '不限' : String(imageGen.settings.v5DailyLimit), imageGen.settings.v5UnlimitedUsers.length === 0 ? '无' : imageGen.settings.v5UnlimitedUsers.join('、'));
        }
        else {
            logger.warn('qq-groupmate: 生图开关是开的，但没填密钥（设置页「生图 → 密钥」），先当没开处理');
        }
    }
    // 出站过滤：发送前按违禁词检查（词表默认复用持续学习的禁用词）。
    const outboundConfig = config.outboundFilter ?? {};
    const outboundWords = (outboundConfig.bannedWords ?? []).some(word => word.trim() !== '')
        ? (outboundConfig.bannedWords ?? [])
        : (learnerConfig.bannedWords ?? []);
    const outboundFilter = new OutboundFilter({
        bannedWords: outboundConfig.enabled === false ? [] : outboundWords.map(word => word.trim()).filter(word => word !== ''),
        mode: outboundConfig.mode?.trim().toLowerCase() === 'redact' ? 'redact' : 'block',
    }, logger);
    if (outboundFilter.config.bannedWords.length > 0) {
        logger.info('qq-groupmate: 出站过滤已开启（%s 模式，%s 个词：%s）', outboundFilter.config.mode, String(outboundFilter.config.bannedWords.length), outboundFilter.config.bannedWords.join('、'));
    }
    // 天气上下文：被问到天气时按 Open-Meteo 的实时数据如实回答（IP 粗略定位 + 10 分钟缓存）。
    const weatherConfig = config.weather ?? {};
    const weatherSettings = {
        enabled: weatherConfig.enabled !== false,
        locationName: weatherConfig.locationName ?? '',
        autoDetectFromIp: weatherConfig.autoDetectFromIp !== false,
        latitude: weatherConfig.latitude ?? 0,
        longitude: weatherConfig.longitude ?? 0,
    };
    const weather = new WeatherService(weatherSettings, logger);
    if (weatherSettings.enabled)
        logger.info('qq-groupmate: 天气上下文已开启（Open-Meteo，10 分钟缓存）');
    // AI 信件：有意义的对话过后，隔一段时间留一张小字条（投递前等群里安静，冷却与周限防刷屏）。
    const notesConfig = config.notes ?? {};
    let managerRef;
    const noteSettings = {
        enabled: notesConfig.enabled !== false,
        provider: notesConfig.provider?.trim() === '' ? undefined : notesConfig.provider,
        model: notesConfig.model?.trim() === '' ? undefined : notesConfig.model,
        backup: notesConfig.backup?.trim() === '' ? undefined : notesConfig.backup,
        delayMinMinutes: notesConfig.delayMinMinutes ?? 30,
        delayMaxMinutes: notesConfig.delayMaxMinutes ?? 120,
        cooldownHours: notesConfig.cooldownHours ?? 24,
        weeklyLimit: notesConfig.weeklyLimit ?? 3,
        requiredQuietMinutes: notesConfig.requiredQuietMinutes ?? 10,
        temperature: notesConfig.temperature ?? 0.8,
        maxTokens: notesConfig.maxTokens ?? 800,
        reasoningEffort: notesConfig.reasoningEffort?.trim() === '' ? undefined : notesConfig.reasoningEffort,
    };
    const chatSlotBackup = chatSlot.backup;
    const notes = new NoteEngine({
        llm,
        logger,
        dir: `${dataDir}/notes`,
        knownProvider,
        models,
        // 写信模型留空时跟随默认群聊模型（含群聊备用）。
        defaultModel: {
            provider: defaults.provider,
            model: defaults.model,
            ...(chatSlotBackup === undefined ? {} : { backup: chatSlotBackup }),
        },
        settings: noteSettings,
        deliver: async (groupId, text) => {
            const manager = managerRef;
            if (manager === undefined)
                return false;
            return await manager.deliverNote(groupId, text);
        },
    });
    if (noteSettings.enabled) {
        logger.info('qq-groupmate: AI 信件已开启（触发后 %s~%s 分钟投递，冷却 %s 小时，每周最多 %s 封，群里安静 %s 分钟才发）', String(noteSettings.delayMinMinutes), String(noteSettings.delayMaxMinutes), String(noteSettings.cooldownHours), String(noteSettings.weeklyLimit), String(noteSettings.requiredQuietMinutes));
    }
    notes.start();
    // 语音输出：回复用本地 GPT-SoVITS 合成后发成 QQ 语音（合成失败自动退化为纯文字）。
    const voiceConfig = config.voice ?? {};
    const voiceSettings = {
        enabled: voiceConfig.enabled !== false,
        // 中文（默认 9880）与日文（默认 9881）各一套服务，与 mod 的两个端点一致。
        endpoint: voiceConfig.endpoint?.trim() === '' || voiceConfig.endpoint === undefined
            ? 'http://127.0.0.1:9880/tts'
            : voiceConfig.endpoint.trim(),
        japaneseEndpoint: voiceConfig.japaneseEndpoint?.trim() === '' || voiceConfig.japaneseEndpoint === undefined
            ? 'http://127.0.0.1:9881/tts'
            : voiceConfig.japaneseEndpoint.trim(),
        // auto：回复里出现假名就走日文音色；也可以写死 zh / ja。
        language: normalizeVoiceLanguage(voiceConfig.language),
        hostPath: expandHome(voiceConfig.hostPath?.trim() ?? ''),
        autoStart: voiceConfig.autoStart !== false,
        refsDir: expandHome(voiceConfig.refsDir?.trim() === '' || voiceConfig.refsDir === undefined
            ? `${dataDir}/voice/refs`
            : voiceConfig.refsDir),
        japaneseRefsDir: expandHome(voiceConfig.japaneseRefsDir?.trim() ?? ''),
        probability: voiceConfig.probability ?? 1,
        maxChars: voiceConfig.maxChars ?? 200,
    };
    // 原声台词库：本机原声素材（索引在 <dataDir>/native-voice/index.json，没有就自动跳过）。
    // 先建它再建 VoiceClient：TTS 要拿同情绪的原声片段当辅助参考音。
    const nativeVoice = new NativeVoiceLibrary(dataDir, logger);
    // 分层记忆：归档 + 本地索引。记忆平常不进提示词——省 token，也让请求前缀更稳。
    const recall = new RecallStore(dataDir, logger, { enabled: config.memory?.enabled !== false });
    if (nativeVoice.available) {
        logger.info('qq-groupmate: 原声台词库已加载（%s 条，模型可用 [原声:关键词] 直接放原声）', String(nativeVoice.keywords().length));
    }
    const voice = new VoiceClient(voiceSettings, logger, nativeVoice);
    if (voiceSettings.enabled) {
        logger.info('qq-groupmate: 语音输出已开启（中文 %s / 日文 %s，音色 %s，概率 %s%%，超过 %s 字不合成；合成失败自动退化纯文字）', voiceSettings.endpoint, voiceSettings.japaneseEndpoint, voiceSettings.language === 'auto' ? '按回复语言自动' : voiceSettings.language, String(Math.round(voiceSettings.probability * 100)), String(voiceSettings.maxChars));
        // 开机就把本地语音服务拉起来：api_v2 冷启动要二十几秒，等第一条回复才拉会来不及出声。
        voice.warmup();
    }
    // 桌面工具：管理员私聊里可以指挥这台电脑（默认关，群友永远触发不了）。
    const desktopEnabled = (config.desktop ?? {}).enabled === true;
    const desktop = new DesktopAgent({
        logger,
        advancedEnabled: () => desktopEnabled,
        announce: async (scope, message) => {
            await managerRef?.announce(scope, message, { voice: voiceSettings.enabled });
        },
    });
    if (desktopEnabled)
        logger.info('qq-groupmate: 桌面工具已开启（仅管理员私聊可用）');
    // Agent 生命周期桥接：监听事件目录（外部工具把生命周期钩子的 JSON 写到这里）。
    const bridgeConfig = config.bridge ?? {};
    const bridgeNotifyUsers = (bridgeConfig.notifyUsers ?? []).map(id => id.trim()).filter(id => id !== '');
    const bridgeNotifyGroups = (bridgeConfig.notifyGroups ?? []).map(id => id.trim()).filter(id => id !== '');
    // 没配播报对象时默认播报给第一个管理员（对应桌宠「对玩家说话」）。
    if (bridgeNotifyUsers.length === 0 && bridgeNotifyGroups.length === 0 && defaults.admins.length > 0) {
        const first = defaults.admins[0];
        if (first !== undefined)
            bridgeNotifyUsers.push(first);
    }
    const bridgeSettings = {
        enabled: bridgeConfig.enabled !== false,
        eventsDir: expandHome(bridgeConfig.eventsDir?.trim() ?? ''),
        notifyUsers: bridgeNotifyUsers,
        notifyGroups: bridgeNotifyGroups,
        voice: bridgeConfig.voice !== false,
    };
    const bridge = new BridgeWatcher(bridgeSettings, logger, async (message) => {
        const manager = managerRef;
        if (manager === undefined)
            return false;
        let sentAny = false;
        const speak = bridgeSettings.voice && voiceSettings.enabled;
        for (const userId of bridgeSettings.notifyUsers) {
            const sent = await manager.announce(`private:${userId}`, message, { voice: speak });
            sentAny = sentAny || sent;
        }
        for (const groupId of bridgeSettings.notifyGroups) {
            const sent = await manager.announce(groupId, message, { voice: speak });
            sentAny = sentAny || sent;
        }
        return sentAny;
    });
    if (bridgeSettings.enabled) {
        logger.info('qq-groupmate: 生命周期桥接已开启（监听 %s，播报给 %s）', bridgeSettings.eventsDir === '' ? defaultBridgeEventsDir() : bridgeSettings.eventsDir, [...bridgeSettings.notifyUsers.map(id => `私聊 ${id}`), ...bridgeSettings.notifyGroups.map(id => `群 ${id}`)].join('、')
            || '（无）');
    }
    bridge.start();
    // 今日老婆：从最近发言过的群友里抽一位今日老婆（全员可玩；状态落 dataDir/wife）。
    const wifeConfig = config.wife ?? {};
    const wifeSettings = {
        ...defaultWifeSettings(),
        enabled: wifeConfig.enabled !== false,
        dailyLimit: wifeConfig.dailyLimit ?? 1,
        activeDays: wifeConfig.activeDays ?? 30,
        atWife: wifeConfig.atWife !== false,
        keywordTrigger: wifeConfig.keywordTrigger !== false,
        excludedUsers: (wifeConfig.excludedUsers ?? []).map(id => id.trim()).filter(id => id !== ''),
        forceCooldownDays: wifeConfig.forceCooldownDays ?? 3,
        breakupCooldownHours: wifeConfig.breakupCooldownHours ?? 72,
    };
    const wife = new WifeGame({
        client: endpoint,
        logger,
        dir: `${dataDir}/wife`,
        settings: wifeSettings,
    });
    if (wifeSettings.enabled) {
        logger.info('qq-groupmate: 今日老婆已开启（每天 %s 次，活跃 %s 天，关键词触发 %s）', String(wifeSettings.dailyLimit), String(wifeSettings.activeDays), wifeSettings.keywordTrigger ? '开' : '关');
    }
    // 星羽塔罗：78 张塔罗牌占卜 + AI 解读（全员可玩；卡面素材在 dataDir/tarot/cards）。
    const tarotConfig = config.tarot ?? {};
    const tarotSettings = {
        enabled: tarotConfig.enabled !== false,
        aiEnabled: tarotConfig.aiEnabled !== false,
        model: tarotConfig.model?.trim() ?? '',
        aiTimeoutSeconds: tarotConfig.aiTimeoutSeconds ?? 30,
        cooldownSeconds: tarotConfig.cooldownSeconds ?? 10,
        dailyCountLimit: tarotConfig.dailyCountLimit ?? 0,
        persona: tarotConfig.persona?.trim().toLowerCase() || 'random',
        disclaimer: tarotConfig.disclaimer ?? '',
        shuffleLines: tarotConfig.shuffleLines !== false,
        dailyFixed: tarotConfig.dailyFixed !== false,
        // 卡面优先用数据目录里的（可自行替换）；没有就用随包带的那份。
        assetsDir: existsSync(`${dataDir}/tarot/cards`) ? `${dataDir}/tarot/cards` : bundledAssetPath('assets', 'tarot-cards'),
    };
    const tarot = new TarotGame({
        llm,
        client: endpoint,
        logger,
        settings: tarotSettings,
        // 解读模型留空时跟随默认群聊模型（含群聊备用）；填了引用就按引用解析。
        defaultTarget: {
            provider: defaults.provider,
            model: defaults.model,
            ...(chatSlotBackup === undefined ? {} : { backup: chatSlotBackup }),
        },
        resolveRef: ref => models.resolve(ref, { provider: defaults.provider, model: defaults.model }),
    });
    if (tarotSettings.enabled) {
        logger.info('qq-groupmate: 星羽塔罗已开启（AI 解读 %s，冷却 %s 秒，人设 %s）', tarotSettings.aiEnabled ? `开（${tarotSettings.model === '' ? '跟随群聊模型' : tarotSettings.model}）` : '关（只发牌义）', String(tarotSettings.cooldownSeconds), tarotSettings.persona);
    }
    // 联网能力：模型用 `[搜索:]` `[网页:]` `[查梗:]` 触发（默认开，走 Bing 抓取免 Key）。
    const webConfig = config.web ?? {};
    const searchSettings = {
        enabled: webConfig.enabled !== false,
        searchUrl: webConfig.searchUrl?.trim() === '' || webConfig.searchUrl === undefined
            ? 'https://cn.bing.com/search'
            : webConfig.searchUrl.trim(),
        maxResults: webConfig.maxResults ?? 6,
        timeoutMs: webConfig.timeoutMs ?? 15000,
        ...(webConfig.customBaseUrl?.trim() === '' || webConfig.customBaseUrl === undefined
            ? {}
            : {
                custom: {
                    baseUrl: webConfig.customBaseUrl.trim(),
                    apiKey: webConfig.customApiKey?.trim() ?? '',
                },
            }),
    };
    // 群友档案：按 QQ 号（不是按群）存长期印象，于是同一个人的事换群也认。
    const peopleConfig = config.people ?? {};
    const peopleSettings = {
        ...defaultPeopleSettings(),
        enabled: peopleConfig.enabled !== false,
        crossGroupEnabled: peopleConfig.crossGroupEnabled !== false,
        privateToGroup: peopleConfig.privateToGroup !== false,
        crossGroupExclude: (peopleConfig.crossGroupExclude ?? []).map(key => key.trim()).filter(key => key !== ''),
        peopleMaxInject: peopleConfig.peopleMaxInject ?? 6,
        eventsMaxInject: peopleConfig.eventsMaxInject ?? 6,
        maxChars: peopleConfig.maxChars ?? 1400,
        factsPerPersonInject: peopleConfig.factsPerPersonInject ?? 3,
        decayHalfLifeDays: peopleConfig.decayHalfLifeDays ?? 30,
        decayMinWeight: peopleConfig.decayMinWeight ?? 0.08,
        decayMinAgeDays: peopleConfig.decayMinAgeDays ?? 7,
        keepImportance: peopleConfig.keepImportance ?? 4,
        maxFactsPerPerson: peopleConfig.maxFactsPerPerson ?? 12,
        maxEventsPerChat: peopleConfig.maxEventsPerChat ?? 150,
        maxEventsTotal: peopleConfig.maxEventsTotal ?? 400,
        surfaceEnabled: peopleConfig.surfaceEnabled !== false,
        surfaceTtlMs: Math.max(1, peopleConfig.surfaceTtlMinutes ?? 10) * 60_000,
        surfaceMaxPerPerson: peopleConfig.surfaceMaxPerPerson ?? 50,
        surfaceMaxInject: peopleConfig.surfaceMaxInject ?? 6,
    };
    const people = new PeopleStore({ dir: `${dataDir}/people`, settings: peopleSettings, logger });
    if (peopleSettings.enabled) {
        logger.info('qq-groupmate: 群友档案已开启（跨群 %s，遗忘曲线半衰期 %s 天，重要度 %s 以上永久保留）', peopleSettings.crossGroupEnabled ? '开' : '关', String(peopleSettings.decayHalfLifeDays), String(peopleSettings.keepImportance));
    }
    // 定时提醒：群友定好时间，到点主动开口；dsh 关着错过的会补发。
    const reminderConfig = config.reminders ?? {};
    const reminderSettings = {
        ...defaultReminderSettings(),
        enabled: reminderConfig.enabled !== false,
        minDelaySec: reminderConfig.minDelaySec ?? 30,
        catchUpMinutes: reminderConfig.catchUpMinutes ?? 720,
        maxPending: reminderConfig.maxPending ?? 200,
        maxPendingPerChat: reminderConfig.maxPendingPerChat ?? 20,
        maxPerDay: reminderConfig.maxPerDay ?? 20,
        ttlDays: reminderConfig.ttlDays ?? 400,
    };
    const reminders = new ReminderStore({
        file: `${dataDir}/reminders/reminders.json`,
        settings: reminderSettings,
        logger,
    });
    if (reminderSettings.enabled) {
        const stats = reminders.stats();
        logger.info('qq-groupmate: 定时提醒已开启（挂起 %s 条，迟到 %s 分钟内补发）', String(stats.pending), String(reminderSettings.catchUpMinutes));
    }
    reminders.prune();
    // 工具运行器：把「查资料 / 记事 / 定提醒」这三类标记接上真正的实现。
    const tools = new ToolRunner({
        logger,
        ...(searchSettings.enabled ? { search: searchSettings } : {}),
        ...(peopleSettings.enabled ? { people } : {}),
        ...(reminderSettings.enabled ? { reminders } : {}),
        // 分层记忆在线时，模型可以写 [回忆:关键词] 翻旧账。
        ...(recall.enabled ? { recall } : {}),
    });
    const manager = new GroupManager({
        llm,
        client: endpoint,
        logger,
        characters,
        defaults,
        overrides: config.groups ?? {},
        models,
        chatBackup: config.modelSlots?.chat?.backup?.trim() === '' ? undefined : config.modelSlots?.chat?.backup,
        outboundFilter,
        statePath: `${dataDir}/state.json`,
        memory,
        summaries,
        vision,
        stickers,
        imageGen,
        presets,
        policy,
        knowledge,
        learner,
        weather,
        notes,
        voice,
        desktop,
        people,
        reminders,
        tools,
        nativeVoice,
        recall,
    });
    managerRef = manager;
    const commands = new CommandHandler({
        manager,
        client: endpoint,
        logger,
        prefix: config.commandPrefix ?? '.',
        // 与 defaults.admins 用同一份 trim 后的名单，否则带空白的 QQ 号在提示词里被标成管理员、命令门禁却不认。
        admins: defaults.admins,
        stickers,
        ...(reminderSettings.enabled ? { reminders } : {}),
        ...(peopleSettings.enabled ? { people } : {}),
    });
    // 提醒调度：启动时先扫一遍（补发 dsh 关着时到点的），之后每 15 秒扫一次。
    const scheduler = new ReminderScheduler({
        store: reminders,
        client: endpoint,
        logger,
        mentionTarget: reminderConfig.mentionTarget !== false,
        voice: reminderConfig.voice !== false && voiceSettings.enabled,
        say: async (scope, text, options) => await manager.announce(scope, text, {
            ...(options.mentionUserId === undefined ? {} : { mentionUserId: options.mentionUserId }),
            voice: options.voice,
        }),
    });
    if (reminderSettings.enabled)
        scheduler.start();
    // 遗忘维护：按配置的间隔跑一次，把弱到不值得留的印象与事件清掉（只做淘汰，衰减是读取时实时算的）。
    const decayIntervalHours = peopleConfig.decayIntervalHours ?? 24;
    let decayTimer;
    if (peopleSettings.enabled && decayIntervalHours > 0) {
        const runDecay = () => {
            try {
                const result = people.decay();
                if (result.facts + result.events + result.peopleRemoved > 0) {
                    logger.info('qq-groupmate: 记忆整理完成（淘汰印象 %s 条、事件 %s 条、空档案 %s 个）', String(result.facts), String(result.events), String(result.peopleRemoved));
                }
            }
            catch (error) {
                logger.warn('qq-groupmate: 记忆整理失败：%s', String(error));
            }
        };
        // 启动后先跑一次（把离线期间该衰减的清掉），再按间隔跑。
        setTimeout(runDecay, 30_000).unref?.();
        decayTimer = setInterval(runDecay, decayIntervalHours * 3_600_000);
        decayTimer.unref?.();
    }
    dispatch = createEventDispatcher({
        manager,
        commands,
        logger,
        getSelf: () => endpoint.self,
        wife,
        tarot,
        prefix: config.commandPrefix ?? '.',
    });
    // 设置页「清空记忆」写入的令牌：新令牌才执行一次。
    const resetTokens = {};
    for (const [groupId, group] of Object.entries(config.groups ?? {})) {
        const token = group.resetToken;
        if (typeof token === 'number' && Number.isFinite(token))
            resetTokens[groupId] = token;
    }
    if (Object.keys(resetTokens).length > 0)
        manager.applyResetTokens(resetTokens);
    endpoint.start();
    const providers = llm.listProviders().map(provider => provider.id);
    logger.info('qq-groupmate: 已启动（%s 模式，数据目录 %s，模型 %s / %s，可用 provider：%s）', mode === 'forward' ? '正向 WS' : '反向 WS', dataDir, defaults.provider, defaults.model, providers.length === 0 ? '（无）' : providers.join('、'));
    return {
        manager,
        dispose() {
            logger.info('qq-groupmate: 正在停止…');
            void imageGen.disposeBrowser().catch(() => { });
            bridge.dispose();
            scheduler.dispose();
            if (decayTimer !== undefined)
                clearInterval(decayTimer);
            endpoint.close();
            manager.dispose();
            // 今日老婆的状态落盘（防抖窗口内的改动别丢）。
            wife.dispose();
        },
    };
}
/** 插件入口。 */
export function apply(ctx, config) {
    // 入口配置先校验一次：部署时的配置错误要立刻暴露，而不是悄悄降级。
    assertConfig(config);
    // 日志统一走文件：桌面客户端的 host stdout 看不见，只有文件日志可查。
    let logger = createTeeLogger(ctx.logger, resolveLogPath(config, expandHome(config.dataDir?.trim() || `${resolveDshHome()}/qq-groupmate`)));
    let source = () => config;
    let runtime;
    let builtKey = '';
    let lastStatusKey = '';
    let writtenStatusKey = '';
    let currentStatus = { state: 'idle', self: '', detail: '插件尚未启动' };
    /** 最近一次模型降级说明（主模型失败 → 备用模型）。 */
    let modelFallbackNote = '';
    /** 最近一次「拉取模型」的结果（卡片用它做候选下拉）。 */
    let modelCatalog = { provider: '', models: [], at: 0, pending: false, error: '' };
    /** 协议端动作令牌：第一次重建只记录不执行，避免重启 dsh 时重放上次的按钮。 */
    let actionTokenSeen = config.protocolSideToken ?? 0;
    let actionPrimed = false;
    /** 拉取模型令牌：同样第一次只记录不执行。 */
    let fetchTokenSeen = config.modelFetchToken ?? 0;
    let fetchPrimed = false;
    /** 解析数据目录（配置里的相对默认值）。 */
    const resolveDataDir = (value) => expandHome(value.dataDir?.trim() || `${resolveDshHome()}/qq-groupmate`);
    /** 组装完整状态：连接信息 + 群/私聊快照 + 可用角色 + 协议端进程。 */
    const buildStatus = () => {
        const snapshot = runtime?.manager.snapshot();
        const presetStore = runtime?.manager.presetStore;
        return {
            ...currentStatus,
            groups: snapshot?.groups ?? [],
            privateChats: snapshot?.privateChats ?? [],
            characters: runtime?.manager.characterIds() ?? [],
            providers: runtime?.manager.providerIds() ?? [],
            protocolSide: launcher.snapshot(),
            modelFallback: modelFallbackNote,
            modelCatalog: modelCatalog,
            presets: {
                v45: presetStore?.describe('nai-diffusion-4-5-full') ?? [],
                v5: presetStore?.describe('nai-diffusion-5-full') ?? [],
            },
        };
    };
    /** 把最新状态落进设置文档；命名空间还没注册时先记下，注册后补写。 */
    const flushStatus = (force = false) => {
        if (statusScope === undefined || lastStatusKey === '')
            return;
        const payload = buildStatus();
        const key = JSON.stringify(payload);
        if (!force && key === writtenStatusKey)
            return;
        writtenStatusKey = key;
        statusScope.update(payload).catch((error) => {
            writtenStatusKey = '';
            logger.warn('qq-groupmate: 写入运行状态失败（设置文档可能不可写）：%s', String(error));
        });
    };
    /** 状态只在真正变化时写入，避免重连抖动刷屏设置文档。 */
    const reportStatus = (status) => {
        const key = `${status.state ?? ''}|${status.self ?? ''}|${status.detail ?? ''}`;
        if (key === lastStatusKey)
            return;
        lastStatusKey = key;
        currentStatus = status;
        flushStatus();
    };
    /**
     * 询问服务商要一份模型列表，把结果写进运行状态（设置页「模型配置 → 拉取」用）。
     * 只读动作：失败也只是把原因写进状态，不影响群聊。
     * @param provider - 服务商 id（dsh 自带 provider 或自定义 API 服务商）。
     */
    const fetchModelCatalog = async (provider) => {
        const manager = runtime?.manager;
        modelCatalog = { provider, models: [], at: Date.now(), pending: true, error: '' };
        flushStatus(true);
        if (manager === undefined) {
            modelCatalog = { provider, models: [], at: Date.now(), pending: false, error: '插件还没启动完成，稍后再试' };
            flushStatus(true);
            return;
        }
        try {
            const models = await manager.listModels(provider);
            // 有些中转站的模型目录上千条：去重 + 封顶，别把设置文档写爆。
            const ids = [...new Set(models.map(model => model.id).filter(id => id !== ''))].slice(0, 500);
            modelCatalog = { provider, models: ids, at: Date.now(), pending: false, error: '' };
            logger.info('qq-groupmate: 已拉取服务商 %s 的模型列表（%s 个）', provider, String(ids.length));
        }
        catch (error) {
            const message = String(error instanceof Error ? error.message : error).slice(0, 300);
            modelCatalog = { provider, models: [], at: Date.now(), pending: false, error: message };
            logger.warn('qq-groupmate: 拉取服务商 %s 的模型列表失败：%s', provider, message);
        }
        flushStatus(true);
    };
    // 协议端托管：进程跨运行时重建保持存活，只在插件卸载时按配置收尾。
    const launcher = new ProtocolSideLauncher(resolveProtocolSide(config, resolveDataDir(config)), logger, () => { flushStatus(true); });
    /** 配置变化时整体重建运行时。 */
    const rebuild = () => {
        const next = source();
        // 拉模型是只读动作：令牌变化就执行一次，但不参与运行时指纹，
        // 免得每次「拉取」都把 OneBot 连接重建一遍。
        const fetchProvider = next.modelFetchProvider ?? '';
        const fetchToken = next.modelFetchToken ?? 0;
        const fireFetch = fetchPrimed && fetchToken !== fetchTokenSeen && fetchProvider !== '';
        fetchTokenSeen = fetchToken;
        fetchPrimed = true;
        const key = JSON.stringify({ ...next, modelFetchProvider: '', modelFetchToken: 0 });
        if (key === builtKey) {
            if (fireFetch)
                void fetchModelCatalog(fetchProvider);
            return;
        }
        builtKey = key;
        runtime?.dispose();
        runtime = undefined;
        try {
            logger = createTeeLogger(ctx.logger, resolveLogPath(next, resolveDataDir(next)));
            // 设置页按钮：令牌变化才执行一次；显式动作时跳过自动启动，避免和动作打架。
            const action = next.protocolSideAction ?? '';
            const token = next.protocolSideToken ?? 0;
            const fireAction = actionPrimed && token !== actionTokenSeen && action !== '';
            actionTokenSeen = token;
            actionPrimed = true;
            launcher.configure(resolveProtocolSide(next, resolveDataDir(next)), logger, fireAction);
            if (fireAction) {
                if (action === 'start')
                    void launcher.start('设置页');
                else if (action === 'stop')
                    void launcher.stop('设置页');
                else if (action === 'restart')
                    void launcher.restart();
                else
                    logger.warn('qq-groupmate: 未知的协议端动作 %s', action);
            }
            runtime = createRuntime(ctx, next, logger, reportStatus, (info) => {
                modelFallbackNote = `${info.from} → ${info.to}（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}，${info.reason.split(':')[0] ?? ''}）`;
                flushStatus(true);
            });
            if (fireFetch)
                void fetchModelCatalog(fetchProvider);
            flushStatus(true);
        }
        catch (error) {
            logger.error('qq-groupmate: 配置无效，插件已暂停：%s', String(error));
            reportStatus({ state: 'idle', self: '', detail: `配置无效：${String(error)}` });
        }
    };
    // 状态命名空间：插件写入、卡片只读展示。没有 settings 服务时整块跳过。
    let statusScope;
    /** 配置命名空间的作用域；会话命令改全局默认值时写它。 */
    let configScope;
    ctx.inject(['settings'], (settingsCtx) => {
        logger.info('qq-groupmate: 设置文档可用，注册配置与状态命名空间');
        statusScope = settingsCtx.settings.register(STATUS_NS, Status, { base: {} });
        // 配置命名空间：以部署配置为 base，设置页与会话命令的写入落到用户层，改完即时生效。
        const scope = settingsCtx.settings.register(NS, Config, {
            base: config,
            validate: (value) => { assertConfig(value); },
        });
        configScope = scope;
        source = () => scope.get();
        scope.watch(() => { rebuild(); });
        // 设置服务消失时回退到入口配置；插件自己卸载时不做回退。
        settingsCtx.effect(() => () => {
            const state = ctx.fiber.state;
            if (state === FIBER_UNLOADING || state === FIBER_DISPOSED)
                return;
            // 作用域已失效，清掉悬空引用：否则定时状态刷新与会话命令还往死命名空间里写。
            statusScope = undefined;
            configScope = undefined;
            source = () => config;
            rebuild();
        }, 'qq-groupmate: 设置服务回退');
        // 启动状态可能早于命名空间注册产生，这里补写一次。
        flushStatus();
        rebuild();
    });
    // 会话内快捷命令：/qq、/qq-card、/qq-model…… 在任意会话里都能用。
    ctx.inject(['commands'], (commandCtx) => {
        registerSessionCommands(commandCtx, {
            getManager: () => runtime?.manager,
            logger,
            setSetting: async (patch) => {
                if (configScope === undefined)
                    throw new Error('设置文档不可用，无法修改默认值');
                await configScope.update(patch);
            },
        });
        logger.info('qq-groupmate: 已注册会话内命令 /qq、/qq-card、/qq-model、/qq-groups、/qq-memory、/qq-reset、/qq-say');
    });
    rebuild();
    // 记忆条数会随聊天变化，定期刷新一次给设置页；内容没变则不写盘。
    const refreshTimer = setInterval(() => { flushStatus(); }, 60_000);
    refreshTimer.unref?.();
    ctx.effect(() => () => {
        clearInterval(refreshTimer);
        launcher.dispose();
        runtime?.dispose();
        runtime = undefined;
    }, 'qq-groupmate: 运行时（连接与会话）');
}
