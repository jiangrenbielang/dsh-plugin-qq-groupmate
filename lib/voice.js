/**
 * QQ 语音输出：把角色的回复用本地 GPT-SoVITS 合成语音，发成 QQ 语音消息。
 * 两条路各自拉起后确认端口监听：
 * - 调用本地 api_v2 TTS 接口（默认 http://127.0.0.1:9880/tts），返回 WAV 字节；
 * - 主参考音是 calm，情绪参考音走 aux_ref_audio_paths（excited/wronged/sleepy）；
 * - 情绪判定移植 ChooseAiEmotion 的正则（晚安→困倦、被逗→开心、难过→委屈……）；
 * - autoStart 开着且端点是本机回环时，自动拉起本地语音服务（隐藏窗口），
 *   服务没就绪时最多重试 7 次、每次 5 秒（与 mod 一致）；
 * - 合成失败只记日志、跳过语音——文字回复已经发出去了，聊天不受影响。
 *
 * 拉起方式有两条，**按顺序都试**（2026-09-14 修正）：
 *   ① 随包宿主可执行文件（自带运行时检查）；
 *   ② 直接用运行时的 venv 跑 GPT-SoVITS api_v2.py（手工部署时更可靠）。
 * 以前只在「宿主文件不存在」时才用 ②；宿主存在但起不来（例如它的就绪标记过期、
 * 打印 `Voice runtime is not ready` 后秒退）就彻底没救了——群里表现为「语音没了」。
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
    const input = `${userText}\n${reply}`;
    for (const rule of STYLE_RULES) {
        if (rule.pattern.test(input))
            return rule.style;
    }
    return 'calm';
}
/** 主参考音的提示文本（作为零样本合成的 prompt）。 */
const PROMPT_TEXT = '你的選擇創造了我，所以我的存在本身就是你的善意。';
/** 单次合成请求的超时（毫秒）：本地推理，正常几秒；给足余量但别让挂住的请求堵住队列。 */
const SYNTHESIS_TIMEOUT_MS = 180_000;
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
/** 校验响应确实是 WAV（RIFF 头），对应 mod 的「TTS response is not a WAV file」。 */
export function assertWav(buffer) {
    if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
        throw new Error('TTS 响应不是 WAV 文件');
    }
}
/** 语音客户端：合成 + 宿主托管。 */
export class VoiceClient {
    settings;
    logger;
    hostSpawned = false;
    /** 全局串行：TTS 是本地推理，并发多了排队反而更慢。 */
    chain = Promise.resolve();
    constructor(settings, logger) {
        this.settings = settings;
        this.logger = logger;
    }
    get enabled() {
        return this.settings.enabled;
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
    /**
     * 合成一段语音，返回 WAV 字节；失败抛错由调用方决定降级。
     * 请求体与 mod 的 RequestSpeechAsync 完全一致。
     */
    async synthesize(text, style = 'calm') {
        const spoken = prepareSpeechText(text);
        if (spoken.length === 0)
            throw new Error('语音文本为空');
        const refsDir = this.settings.refsDir;
        const calm = join(refsDir, 'calm-reference.wav');
        if (!existsSync(calm))
            throw new Error(`主参考音不存在：${calm}`);
        const auxName = `${style}-reference.wav`;
        const aux = join(refsDir, auxName);
        const auxPaths = style !== 'calm' && existsSync(aux) ? [aux] : [];
        const payload = {
            text: spoken,
            text_lang: 'zh',
            ref_audio_path: calm,
            aux_ref_audio_paths: auxPaths,
            prompt_lang: 'zh',
            prompt_text: PROMPT_TEXT,
            text_split_method: 'cut0',
            batch_size: 1,
            media_type: 'wav',
            streaming_mode: false,
            seed: 42,
        };
        const endpoint = this.settings.endpoint;
        // 本地服务可能还在启动：autoStart + 回环地址时最多重试 7 次、间隔 5 秒（与 mod 一致）。
        const maxAttempts = this.isLocalEndpoint(endpoint) && this.settings.autoStart ? 7 : 1;
        let lastError = undefined;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                if (this.settings.autoStart && this.isLocalEndpoint(endpoint) && attempt === 1) {
                    await this.ensureHost();
                }
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload),
                    // 本地推理也要给上限：请求挂住会把后面的语音全堵在串行队列里。
                    // 一句两百字以内的合成远用不到这个数，给足余量即可。
                    signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
                });
                if (!response.ok) {
                    const detail = (await response.text()).slice(0, 200);
                    throw new Error(`TTS HTTP ${String(response.status)}: ${detail}`);
                }
                const buffer = Buffer.from(await response.arrayBuffer());
                assertWav(buffer);
                return buffer;
            }
            catch (error) {
                lastError = error;
                if (attempt < maxAttempts) {
                    this.logger.info('qq-groupmate: 本地语音服务还没就绪，5 秒后重试（%s/%s）', String(attempt), String(maxAttempts));
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    /** 排队合成（串行），失败只记日志。 */
    speak(text, style) {
        const next = this.chain.then(async () => {
            try {
                return await this.synthesize(text, style);
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
        if (!this.isLocalEndpoint(this.settings.endpoint))
            return;
        void (async () => {
            try {
                if (await this.probeService()) {
                    this.logger.info('qq-groupmate: 本地语音服务已在运行（%s）', this.settings.endpoint);
                    return;
                }
                await this.ensureHost();
            }
            catch (error) {
                this.logger.warn('qq-groupmate: 语音服务预热失败（不影响文字）：%s', String(error));
            }
        })();
    }
    /**
     * 拉起本地语音服务（只做一次）。
     *
     * 两条路按顺序都试，每条拉起后都**确认端口真的监听了**才算成功：
     *   ① 宿主可执行文件（随包）
     *   ② .venv 直接跑 GPT-SoVITS api_v2.py
     * 宿主起不来时不再直接放弃——这正是 2026-09-14「语音没了」的原因：
     * 宿主秒退（`Voice runtime is not ready`），而兜底只在宿主文件缺失时才走。
     */
    async ensureHost() {
        if (this.hostSpawned)
            return;
        this.hostSpawned = true;
        if (!this.settings.autoStart || !this.isLocalEndpoint(this.settings.endpoint))
            return;
        // 端口已经有人在听就不拉起（外部手动模式）：api_v2 对空请求回 5xx，也算「活着」。
        if (await this.probeService()) {
            this.logger.info('qq-groupmate: 本地语音服务已在运行（%s）', this.settings.endpoint);
            return;
        }
        const hostPath = this.resolveHostPath();
        const runtimeDir = hostPath === undefined ? undefined : join(hostPath, '..');
        const hasRuntime = runtimeDir !== undefined && existsSync(join(runtimeDir, 'gpt-sovits', 'api_v2.py'));
        // ① 随包宿主。
        //    只给 12 秒：宿主正常情况下几秒就监听；起不来时它会打印
        //    `Voice runtime is not ready` 然后立刻退出（就绪标记过期就是这样），
        //    等满 30 秒纯属浪费——群友正等着语音。
        if (hostPath !== undefined && existsSync(hostPath)) {
            this.spawnHost(hostPath);
            if (await this.waitForService(12))
                return;
            this.logger.warn('qq-groupmate: 语音宿主 12 秒内没监听，改用 venv 直接跑 api_v2');
        }
        // ② venv 直接跑 api_v2（宿主不可用时的主路，不再是「文件缺失」才走的兜底）。
        if (hasRuntime && runtimeDir !== undefined) {
            this.spawnApiV2(runtimeDir);
            if (await this.waitForService(90))
                return;
            this.logger.warn('qq-groupmate: api_v2 拉起后 90 秒仍没监听（模型加载慢或依赖缺失），语音暂不可用');
            // 这次没拉起来：放开闸门，下一条回复再试一次，别因为一次失败就永久哑掉。
            this.hostSpawned = false;
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
    async probeService(timeoutMs = 3000) {
        try {
            await fetch(this.settings.endpoint, {
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
    async waitForService(totalSeconds) {
        const deadline = Date.now() + totalSeconds * 1000;
        let reported = 0;
        while (Date.now() < deadline) {
            if (await this.probeService()) {
                this.logger.info('qq-groupmate: 本地语音服务已就绪（%s）', this.settings.endpoint);
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
    /** 拉起随包语音宿主（隐藏窗口、独立进程）。 */
    spawnHost(hostPath) {
        try {
            const child = spawn(hostPath, ['--voice-host', '--parent', String(process.pid), '--language', 'zh'], {
                cwd: join(hostPath, '..'),
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            });
            child.unref();
            this.logger.info('qq-groupmate: 已拉起本地语音宿主（%s）', hostPath);
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 拉起本地语音宿主失败：%s', String(error));
        }
    }
    /**
     * 兜底：直接用运行时自带的 venv 跑 GPT-SoVITS api_v2（与宿主包的是同一个服务、同一端口）。
     * 宿主依赖安装器写的就绪标记，手工部署的运行时走这条路更可靠。
     */
    spawnApiV2(runtimeDir) {
        const python = join(runtimeDir, '.venv', 'Scripts', 'python.exe');
        const api = join(runtimeDir, 'gpt-sovits', 'api_v2.py');
        if (!existsSync(python) || !existsSync(api)) {
            this.logger.info('qq-groupmate: 运行时缺少 venv 或 api_v2.py，无法自动拉起语音服务');
            return;
        }
        const cudaConfig = join(runtimeDir, 'config', 'zh-cuda.yaml');
        const config = existsSync(cudaConfig) ? cudaConfig : join(runtimeDir, 'config', 'zh-cpu.yaml');
        const port = this.endpointPort();
        try {
            const child = spawn(python, ['api_v2.py', '-a', '127.0.0.1', '-p', String(port), '-c', config], {
                cwd: join(runtimeDir, 'gpt-sovits'),
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            });
            child.unref();
            this.logger.info('qq-groupmate: 已直接拉起 GPT-SoVITS api_v2（%s，端口 %s），等它监听', config, String(port));
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 拉起 api_v2 失败：%s', String(error));
        }
    }
    /** 从端点里取端口（api_v2 的 -p 要跟配置的端点一致）；取不到用 9880。 */
    endpointPort() {
        try {
            const url = new URL(this.settings.endpoint);
            const port = Number(url.port);
            return Number.isFinite(port) && port > 0 ? port : 9880;
        }
        catch {
            return 9880;
        }
    }
    resolveHostPath() {
        const configured = this.settings.hostPath?.trim();
        if (configured !== '')
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
