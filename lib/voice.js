/**
 * QQ 语音输出：把角色的回复用本地 GPT-SoVITS 合成语音，发成 QQ 语音消息。
 *
 * 行为对齐莉莉丝 AI Mod 的 RequestSpeechAsync / EnsureLocalVoiceHost：
 * - 调用本地 api_v2 TTS 接口（默认 http://127.0.0.1:9880/tts），返回 WAV 字节；
 * - **中文 / 日文两套音色各自独立（2026-09-15 补齐）**：端点、参考音目录、prompt 文本、
 *   宿主 --language、api_v2 配置（zh-*.yaml / ja-*.yaml）全按语言分开，和 mod 一样互不影响；
 * - 主参考音是 calm，情绪参考音走 aux_ref_audio_paths（excited / wronged / sleepy）；
 *   日文的 calm 另外挂 calm-aux-reference.wav，对应 mod 的 JapaneseCalmAuxVoiceReferencePath；
 * - 情绪判定移植 ChooseAiEmotion 的正则（晚安→困倦、被逗→开心、难过→委屈……）；
 * - autoStart 开着且端点是本机回环时，自动拉起本地语音服务（隐藏窗口），
 *   服务没就绪时最多重试 7 次、每次 5 秒（与 mod 一致）；
 * - 合成失败只记日志、跳过语音——文字回复已经发出去了，聊天不受影响。
 *
 * 参考音目录：先用设置里的 refsDir，找不到就照着 mod 的部署结构自动探测
 * （`…/LilithTextInjector/voice` 与 `…/LilithTextInjector/voice/jp`，就在语音运行时的隔壁）。
 *
 * 拉起方式有两条，**按顺序都试**：
 *   ① 随包宿主可执行文件（自带运行时检查）；
 *   ② 直接用运行时的 venv 跑 GPT-SoVITS api_v2.py（手工部署时更可靠）。
 * 从前只在「宿主文件不存在」时才用 ②；宿主存在但起不来（就绪标记过期、打印
 * `Voice runtime is not ready` 后秒退）就彻底没救了——群里表现为「语音没了」。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
/** 情绪 → 语气（简繁都认）。 */
const STYLE_RULES = [
    { style: 'sleepy', pattern: /(想睡|睏|困了|睡觉|晚安|眠い|寝る|sleepy|good night)/iu },
    { style: 'wronged', pattern: /(生氣|生气|討厭|讨厌|笨蛋|不准|不許|不许|怒|angry|mad|害怕|可怕|恐怖|擔心|担心|scared|afraid|難過|难过|傷心|伤心|哭|寂寞|孤單|孤单|sad|lonely|委屈|不理我|忘記我|忘记我|不要走|wronged|leave me)/iu },
    { style: 'excited', pattern: /(真的嗎|真的吗|居然|竟然|沒想到|没想到|驚訝|惊讶|really|surpris|開心|开心|喜歡|喜欢|愛|爱|謝謝|谢谢|草莓蛋糕|可愛|可爱|happy|love|cute|thank)/iu },
];
/** 按用户消息与回复选语气：困倦 > 委屈/生气 > 开心 > 平静（后命中优先级低）。 */
export function chooseVoiceStyle(userText, reply) {
    const input = userText + '\n' + reply;
    for (const rule of STYLE_RULES) {
        if (rule.pattern.test(input))
            return rule.style;
    }
    return 'calm';
}
/** 每种语言的主参考音提示文本（零样本合成的 prompt），与 mod 的两段原文一致。 */
const PROMPT_TEXT = {
    zh: '你的选择创造了我，所以我的存在本身就是你的善意。',
    ja: 'これは儀式でもあるの。君に私の存在を感じてもらうための儀式ね。',
};
/** 每种语言的参考音文件名（放在各自的参考音目录里）。 */
const REFERENCE_FILES = {
    zh: {
        calm: 'calm-reference.wav',
        calmAux: undefined,
        excited: 'excited-reference.wav',
        wronged: 'wronged-reference.wav',
        sleepy: 'sleepy-reference.wav',
    },
    ja: {
        calm: 'calm-reference.wav',
        calmAux: 'calm-aux-reference.wav',
        excited: 'excited-reference.wav',
        wronged: 'wronged-reference.wav',
        sleepy: 'sleepy-reference.wav',
    },
};
/** 语言 id 归一：只认 zh / ja / auto。 */
export function normalizeVoiceLanguage(value) {
    const text = String(value ?? '').trim().toLowerCase();
    if (text === 'ja' || text === 'jp' || text === 'japanese' || text === '日文' || text === '日语' || text === '日語')
        return 'ja';
    if (text === 'zh' || text === 'cn' || text === 'chinese' || text === '中文' || text === '简体' || text === '繁體')
        return 'zh';
    return 'auto';
}
/** 回复里有没有假名：auto 模式据此挑中文还是日文音色。 */
const KANA_RE = /[\u3040-\u30ff]/u;
/** 单次合成请求的超时（毫秒）：本地推理，正常几秒；给足余量但别让挂住的请求堵住队列。 */
const SYNTHESIS_TIMEOUT_MS = 180_000;
/** 自动拉起 api_v2 时监听的总秒数（模型加载慢，给足）。 */
const API_V2_READY_SECONDS = 90;
/** 自动拉起随包宿主时等待监听的秒数（宿主几秒就绪，起不来会立刻退出）。 */
const HOST_READY_SECONDS = 12;
/** 常见的宿主安装位置；没有就靠设置里的 hostPath 指路。 */
const HOST_CANDIDATES = [];
/**
 * 清理发给 TTS 的文本：去标记、去 Markdown、去链接与引用角标，压成一整段。
 * （mod 的 PrepareTextForSpeech 的精简移植。）
 */
export function prepareSpeechText(text) {
    return text
        .replace(/\[(?:表情|生图|語音|语音|record)[^\]]*\]/giu, ' ')
        .replace(/https?:\/\/\S+/giu, ' ')
        .replace(/https?%3A%2F%2F\S+/giu, ' ')
        .replace(/\[\d+\]/gu, ' ')
        .replace(/[`*_#>~|]/gu, ' ')
        .replace(/<[^>]{1,40}>/gu, ' ')
        .replace(/(https?|http)[^\s，。！？]*[/\\][^\s，。！？]*/giu, ' ')
        .replace(/["“'」』」]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
}
/** 人类可读的字节数（日志用）。 */
function formatBytes(bytes) {
    return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : (bytes / 1024).toFixed(0) + ' KB';
}
/**
 * 从标准 PCM WAV 头估算时长（秒）；拿不到就返回 0。
 * WAV 头里 28 字节处是 byteRate，之后的数据就是采样数据。
 */
export function wavSeconds(buffer) {
    if (buffer.length < 44)
        return 0;
    const byteRate = buffer.readUInt32LE(28);
    if (!Number.isFinite(byteRate) || byteRate <= 0)
        return 0;
    return Math.max(0, buffer.length - 44) / byteRate;
}
/** 从对象里按候选键名取第一个非空字符串（模型偶尔会换键名）。 */
function pickString(source, keys) {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim() !== '')
            return value.trim();
    }
    return '';
}
/**
 * 解析「日文语音模式」下模型输出的 JSON（移植自莉莉丝 AI Mod 的 display_text / speech_ja 双字段）。
 *
 * 为什么需要它：日文音色只能读日文。让模型一次给出两份文本——给群友看的中文（display_text）、
 * 拿来合成的日文（speech_ja）——语音才不会变成「日文模型念中文」的残缺念白。
 * 容错：允许 ```json 围栏、前后有解释文字、键名写成驼峰；解析不出来就返回 undefined，
 * 由调用方按普通文本处理（此时 resolveLanguage 会回退中文音色）。
 * @param text - 模型输出的原始文本。
 * @returns `{ display, speech }`；不是这种 JSON 时返回 `undefined`。
 */
export function parseVoiceModeJson(text) {
    const raw = String(text ?? '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(raw.slice(start, end + 1));
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return undefined;
    const display = pickString(parsed, ['display_text', 'displayText', 'display', 'text']);
    const speech = pickString(parsed, ['speech_ja', 'speechJa', 'speech', 'ja']);
    if (display === '' && speech === '')
        return undefined;
    return {
        display: display === '' ? speech : display,
        speech: speech === '' ? display : speech,
    };
}
/** 校验响应确实是 WAV（RIFF 头），对应 mod 的「TTS response is not a WAV file」。 */
export function assertWav(buffer) {
    if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
        throw new Error('TTS 响应不是 WAV 文件');
    }
}
/** 语音客户端：合成 + 宿主托管（中文、日文两套服务互不干扰）。 */
export class VoiceClient {
    settings;
    logger;
    /** 已经尝试拉起过的语言（每种语言只拉一次，失败后放开闸门下次再试）。 */
    hostSpawned = new Set();
    /** 全局串行：TTS 是本地推理，并发多了排队反而更慢。 */
    chain = Promise.resolve();
    constructor(settings, logger, nativeVoice) {
        this.settings = settings;
        this.logger = logger;
        // 原声台词库（可选）：非 calm 情绪时从里面挑两段同情绪的原声当辅助参考音，
        // 音色与情绪都比只挂一条 <style>-reference.wav 更贴近原作。
        this.nativeVoice = nativeVoice;
    }
    get enabled() {
        return this.settings.enabled;
    }
    /** 当前是不是「日文语音模式」：配置点名 ja 时，正文与语音要分两路（见 parseVoiceModeJson）。 */
    get japaneseVoiceMode() {
        return normalizeVoiceLanguage(this.settings.language) === 'ja';
    }
    /**
     * 本次回复该用哪套音色。
     *
     * 2026-09-17 修正（用户报「语音有时偏短」）：以前配置点名 ja 就无条件用日文音色，
     * 中文正文被喂给日文模型，GPT-SoVITS 只读得出零星汉字，听起来很短甚至断掉。
     * 现在只要文本里没有假名，就说明它不是日文（正文是中文，或模型没按日文语音模式给出
     * speech_ja），一律回退中文音色——宁可音色不对，也不要念半句。
     */
    resolveLanguage(reply) {
        const configured = normalizeVoiceLanguage(this.settings.language);
        if (configured === 'zh')
            return 'zh';
        // auto 与 ja 都按文本本身判定：有假名才是日文。
        return KANA_RE.test(reply) ? 'ja' : 'zh';
    }
    /** 这条回复要不要发语音。 */
    shouldSpeak(reply) {
        if (!this.settings.enabled)
            return false;
        const text = prepareSpeechText(reply);
        if (text.length === 0 || text.length > this.settings.maxChars)
            return false;
        return Math.random() < this.settings.probability;
    }
    /** 某种语言用的 TTS 端点（日文默认 9881，与 mod 的 JapaneseVoiceEndpoint 一致）。 */
    endpointFor(language) {
        if (language === 'ja') {
            const configured = this.settings.japaneseEndpoint?.trim();
            return configured === undefined || configured === '' ? 'http://127.0.0.1:9881/tts' : configured;
        }
        return this.settings.endpoint;
    }
    /**
     * 某种语言的参考音目录：设置里的路径优先，找不到就照 mod 的部署结构探测。
     * mod 的结构是 `BepInEx/data/LilithTextInjector/voice[/jp]`，与 `voice-runtime` 同级。
     */
    refsDirFor(language) {
        const configured = language === 'ja' ? this.settings.japaneseRefsDir : this.settings.refsDir;
        if (configured !== undefined && configured !== '' && existsSync(configured))
            return configured;
        for (const candidate of this.refsCandidates(language)) {
            if (existsSync(candidate))
                return candidate;
        }
        return configured === undefined || configured === '' ? undefined : configured;
    }
    /** 自动探测候选：语音运行时的隔壁（voice / voice/jp），再退一步看运行时目录里。 */
    refsCandidates(language) {
        const hostPath = this.resolveHostPath();
        if (hostPath === undefined)
            return [];
        const runtimeDir = join(hostPath, '..');
        const roots = [join(runtimeDir, '..', 'voice'), join(runtimeDir, 'voice')];
        return language === 'ja' ? roots.map(root => join(root, 'jp')) : roots;
    }
    /** 解析某种语言本次要用的参考音（主参考音 + 情绪参考音），全部校验存在性。 */
    resolveReferences(language, style) {
        const files = REFERENCE_FILES[language] ?? REFERENCE_FILES.zh;
        const refsDir = this.refsDirFor(language);
        if (refsDir === undefined)
            throw new Error('没找到' + (language === 'ja' ? '日文' : '中文') + '参考音目录（可在设置里填 refsDir）');
        const calm = join(refsDir, files.calm);
        if (!existsSync(calm))
            throw new Error('主参考音不存在：' + calm);
        const auxiliary = [];
        if (style !== 'calm') {
            const styled = join(refsDir, files[style] ?? '');
            if (files[style] !== undefined && existsSync(styled))
                auxiliary.push(styled);
            // 再从原声库里补两段同情绪的原声：情绪更准，也不至于只靠一条参考音。
            for (const extra of this.nativeVoice?.refsFor(style, 2) ?? []) {
                if (!auxiliary.includes(extra))
                    auxiliary.push(extra);
            }
        }
        else if (files.calmAux !== undefined) {
            const calmAux = join(refsDir, files.calmAux);
            if (existsSync(calmAux))
                auxiliary.push(calmAux);
        }
        return { calm, auxiliary };
    }
    /**
     * 合成一段语音，返回 WAV 字节；失败抛错由调用方决定降级。
     * 请求体与 mod 的 RequestSpeechAsync 一致（含中日双语文案与情绪参考音）。
     * @param text - 要读的文本。
     * @param style - 语气（calm / excited / wronged / sleepy）。
     * @param language - 用哪套音色（zh / ja）。
     */
    async synthesize(text, style = 'calm', language = 'zh') {
        const spoken = prepareSpeechText(text);
        if (spoken.length === 0)
            throw new Error('语音文本为空');
        const { calm, auxiliary } = this.resolveReferences(language, style);
        const payload = {
            text: spoken,
            text_lang: language,
            ref_audio_path: calm,
            aux_ref_audio_paths: auxiliary,
            prompt_lang: language,
            prompt_text: PROMPT_TEXT[language] ?? PROMPT_TEXT.zh,
            text_split_method: 'cut0',
            batch_size: 1,
            media_type: 'wav',
            streaming_mode: false,
            seed: 42,
        };
        const endpoint = this.endpointFor(language);
        // 本地服务可能还在启动：autoStart + 回环地址时最多重试 7 次、间隔 5 秒（与 mod 一致）。
        const maxAttempts = this.isLocalEndpoint(endpoint) && this.settings.autoStart ? 7 : 1;
        let lastError = undefined;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                if (this.settings.autoStart && this.isLocalEndpoint(endpoint) && attempt === 1) {
                    await this.ensureHost(language);
                }
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload),
                    // 本地推理也要给上限：请求挂住会把后面的语音全堵在串行队列里。
                    signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
                });
                if (!response.ok) {
                    const detail = (await response.text()).slice(0, 200);
                    throw new Error('TTS HTTP ' + String(response.status) + ': ' + detail);
                }
                const buffer = Buffer.from(await response.arrayBuffer());
                assertWav(buffer);
                // 记一条成功的日志：排查「语音偏短」时，看字数和秒数就能判断是文本被削了还是模型没读完。
                this.logger.info('qq-groupmate: 语音合成完成（%s，%s 字，%s，约 %s 秒）', language, String(spoken.length), formatBytes(buffer.length), wavSeconds(buffer).toFixed(1));
                return buffer;
            }
            catch (error) {
                lastError = error;
                if (attempt < maxAttempts) {
                    this.logger.info('qq-groupmate: 本地语音服务（%s）还没就绪，5 秒后重试（%s/%s）', language, String(attempt), String(maxAttempts));
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    /** 排队合成（串行），失败只记日志。 */
    speak(text, style) {
        const language = this.resolveLanguage(text);
        const next = this.chain.then(async () => {
            try {
                return await this.synthesize(text, style, language);
            }
            catch (error) {
                this.logger.warn('qq-groupmate: 语音合成失败，跳过语音（文字不受影响）：%s', String(error));
                return undefined;
            }
        });
        this.chain = next.catch(() => undefined);
        return next;
    }
    /**
     * 开机预热：插件启动时就把本地语音服务拉起来，别等第一条回复才冷启动
     * （api_v2 要加载 BERT/CNHuBERT 与权重，冷启动二十几秒，那条回复会来不及出声）。
     * 不阻塞启动——失败了只记日志，等真正要说话时还会再试一次。
     */
    warmup() {
        if (!this.settings.enabled || !this.settings.autoStart)
            return;
        const configured = normalizeVoiceLanguage(this.settings.language);
        const languages = configured === 'auto' ? ['zh'] : [configured];
        for (const language of languages) {
            const endpoint = this.endpointFor(language);
            if (!this.isLocalEndpoint(endpoint))
                continue;
            void (async () => {
                try {
                    if (await this.probeService(endpoint)) {
                        this.logger.info('qq-groupmate: 本地语音服务已在运行（%s，%s）', endpoint, language);
                        return;
                    }
                    await this.ensureHost(language);
                }
                catch (error) {
                    this.logger.warn('qq-groupmate: 语音服务预热失败（不影响文字）：%s', String(error));
                }
            })();
        }
    }
    /**
     * 拉起某种语言的本地语音服务（每种语言只做一次）。
     *
     * 两条路按顺序都试，每条拉起后都**确认端口真的监听了**才算成功：
     *   ① 宿主可执行文件（随包）
     *   ② .venv 直接跑 GPT-SoVITS api_v2.py（按语言挑 zh 或 ja 的 cuda/cpu 配置）
     */
    async ensureHost(language = 'zh') {
        if (this.hostSpawned.has(language))
            return;
        this.hostSpawned.add(language);
        const endpoint = this.endpointFor(language);
        if (!this.settings.autoStart || !this.isLocalEndpoint(endpoint))
            return;
        // 端口已经有人在听就不拉起（外部手动模式）：api_v2 对空请求回 5xx，也算「活着」。
        if (await this.probeService(endpoint)) {
            this.logger.info('qq-groupmate: 本地语音服务已在运行（%s，%s）', endpoint, language);
            return;
        }
        const hostPath = this.resolveHostPath();
        const runtimeDir = hostPath === undefined ? undefined : join(hostPath, '..');
        const hasRuntime = runtimeDir !== undefined && existsSync(join(runtimeDir, 'gpt-sovits', 'api_v2.py'));
        // ① 随包宿主：只给 12 秒。宿主正常情况下几秒就监听；起不来时会打印
        //    `Voice runtime is not ready` 然后立刻退出（就绪标记过期就是这样），
        //    等满 30 秒纯属浪费——群友正等着语音。
        if (hostPath !== undefined && existsSync(hostPath)) {
            this.spawnHost(hostPath, language);
            if (await this.waitForService(endpoint, HOST_READY_SECONDS))
                return;
            this.logger.warn('qq-groupmate: 语音宿主 12 秒内没监听（%s），改用 venv 直接跑 api_v2', language);
        }
        // ② venv 直接跑 api_v2（宿主不可用时的主路，不再是「文件缺失」才走的兜底）。
        if (hasRuntime && runtimeDir !== undefined) {
            this.spawnApiV2(runtimeDir, language);
            if (await this.waitForService(endpoint, API_V2_READY_SECONDS))
                return;
            this.logger.warn('qq-groupmate: %s 的 api_v2 拉起后 %s 秒仍没监听（模型加载慢或依赖缺失），语音暂不可用', language, String(API_V2_READY_SECONDS));
            // 这次没拉起来：放开闸门，下一条回复再试一次，别因为一次失败就永久哑掉。
            this.hostSpawned.delete(language);
            return;
        }
        this.logger.info('qq-groupmate: 未找到本地语音运行时（宿主 / api_v2.py），语音只在服务已就绪时可用');
    }
    /**
     * 探一次端口：能连上就算活着。
     *
     * 用空 POST 探活（不是 GET）：api_v2 只注册了 POST /tts，GET 回 404 会让人误判成「没起」；
     * 空 POST 会因缺参数回 4xx/5xx，但**连得上**才是我们关心的。
     */
    async probeService(endpoint = this.settings.endpoint, timeoutMs = 3000) {
        try {
            await fetch(endpoint, {
                method: 'POST',
                body: '{}',
                headers: { 'content-type': 'application/json' },
                signal: AbortSignal.timeout(timeoutMs),
            });
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * 等端口监听；`totalSeconds` 秒内没等到返回 false。
     * 首次调用在 30/90 秒这个量级——api_v2 要加载 BERT/CNHuBERT 与两个权重，冷启动十几秒起步。
     */
    async waitForService(endpoint, totalSeconds) {
        const deadline = Date.now() + totalSeconds * 1000;
        let reported = 0;
        while (Date.now() < deadline) {
            if (await this.probeService(endpoint)) {
                this.logger.info('qq-groupmate: 本地语音服务已就绪（%s）', endpoint);
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
            reported += 1;
            if (reported % 15 === 0) {
                this.logger.info('qq-groupmate: 还在等本地语音服务就绪（已 %s 秒）', String(reported));
            }
        }
        return false;
    }
    /** 拉起随包语音宿主（隐藏窗口、独立进程），按语言传 --language（与 mod 一致）。 */
    spawnHost(hostPath, language) {
        try {
            const child = spawn(hostPath, ['--voice-host', '--parent', String(process.pid), '--language', language], {
                cwd: join(hostPath, '..'),
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            });
            child.unref();
            this.logger.info('qq-groupmate: 已拉起本地语音宿主（%s，%s）', hostPath, language);
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 拉起本地语音宿主失败：%s', String(error));
        }
    }
    /**
     * 兜底：直接用运行时自带的 venv 跑 GPT-SoVITS api_v2（与宿主包的是同一个服务）。
     * 配置按语言挑 zh 或 ja 的 cuda/cpu 配置（mod 就是每套音色一份配置、一个端口），宿主依赖安装器
     * 写的就绪标记，手工部署的运行时走这条路更可靠。
     */
    spawnApiV2(runtimeDir, language) {
        const python = join(runtimeDir, '.venv', 'Scripts', 'python.exe');
        const api = join(runtimeDir, 'gpt-sovits', 'api_v2.py');
        if (!existsSync(python) || !existsSync(api)) {
            this.logger.info('qq-groupmate: 运行时缺少 venv 或 api_v2.py，无法自动拉起语音服务');
            return;
        }
        const cudaConfig = join(runtimeDir, 'config', language + '-cuda.yaml');
        const config = existsSync(cudaConfig) ? cudaConfig : join(runtimeDir, 'config', language + '-cpu.yaml');
        const port = this.endpointPort(this.endpointFor(language));
        try {
            const child = spawn(python, ['api_v2.py', '-a', '127.0.0.1', '-p', String(port), '-c', config], {
                cwd: join(runtimeDir, 'gpt-sovits'),
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            });
            child.unref();
            this.logger.info('qq-groupmate: 已直接拉起 GPT-SoVITS api_v2（%s，端口 %s，%s）', config, String(port), language);
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 拉起 api_v2 失败：%s', String(error));
        }
    }
    /** 从端点里取端口（api_v2 的 -p 要跟配置的端点一致）；取不到用 9880。 */
    endpointPort(endpoint = this.settings.endpoint) {
        try {
            const url = new URL(endpoint);
            const port = Number(url.port);
            return Number.isFinite(port) && port > 0 ? port : 9880;
        }
        catch {
            return 9880;
        }
    }
    resolveHostPath() {
        const configured = this.settings.hostPath?.trim();
        if (configured !== undefined && configured !== '')
            return configured;
        for (const candidate of HOST_CANDIDATES) {
            if (existsSync(candidate))
                return candidate;
        }
        return undefined;
    }
    isLocalEndpoint(endpoint) {
        try {
            const url = new URL(endpoint);
            return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
        }
        catch {
            return false;
        }
    }
}
