/**
 * Agent 生命周期桥接：
 * Codex / dsh 的钩子把「会话开始了 / 需要你确认 / 跑完了」三个生命周期事件写成
 * JSON 文件丢进事件目录，插件轮询这个目录，用角色的口吻播报给你（可选语音）。
 *
 * 事件目录默认就是
 * `%LOCALAPPDATA%\\QQGroupmate\\Bridge\\events`（外部工具的生命周期钩子把事件写到这里），
 * 插件只读「事件名 / 会话与轮次的短 id / 时间戳」，
 * 不读任何提示词、对话内容、API Key 或登录凭据；文件读完即删。
 *
 * 要把某个工具接进来时，把它的 hook 事件 JSON 写进上面的事件目录即可。
 */
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
/** 每种事件的播报文案（简体取自 MOD 的 ProcessPendingCodexSignal）。 */
export const BRIDGE_ANNOUNCEMENTS = {
    UserPromptSubmit: '嗯，我看看……',
    PermissionRequest: '这一步要你点头，我才能继续。',
    Stop: '做好了。你来看看吧。',
};
/** 事件文件里认得的事件名（与 MOD 的 switch 一致）。 */
const KNOWN_EVENTS = new Set(['UserPromptSubmit', 'PermissionRequest', 'Stop']);
/** 比 5 分钟旧的信号直接丢（MOD 同款；机器对时错误也不会刷屏）。 */
const EVENT_MAX_AGE_MS = 5 * 60 * 1000;
/** 信号队列上限。 */
const QUEUE_LIMIT = 24;
/** 每次轮询最多处理几个事件文件。 */
const BATCH_LIMIT = 16;
/** 默认的事件目录。 */
export function defaultBridgeEventsDir() {
    const localAppData = process.env.LOCALAPPDATA?.trim() ?? join(homedir(), 'AppData', 'Local');
    return join(localAppData, 'QQGroupmate', 'Bridge', 'events');
}
/** 解析一个事件文件；不是认得的事件/太旧就返回 undefined。 */
export function parseBridgeEvent(raw, now) {
    let json;
    try {
        json = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    const eventName = typeof json.hookEventName === 'string' ? json.hookEventName : '';
    if (!KNOWN_EVENTS.has(eventName))
        return undefined;
    if (typeof json.timestampUtc === 'string') {
        const timestamp = Date.parse(json.timestampUtc);
        // 时间戳解析得出来且确实太旧：丢弃（解析不了就按「刚刚发生」处理，宁可播报）。
        if (!Number.isNaN(timestamp) && now - timestamp > EVENT_MAX_AGE_MS)
            return undefined;
    }
    return {
        eventName: eventName,
        sessionId: typeof json.sessionId === 'string' ? json.sessionId : '',
        turnId: typeof json.turnId === 'string' ? json.turnId : '',
    };
}
/** 桥接轮询器。 */
export class BridgeWatcher {
    settings;
    logger;
    deliver;
    queue = [];
    timer;
    nextSignalAt = 0;
    disposed = false;
    constructor(settings, logger, deliver) {
        this.settings = settings;
        this.logger = logger;
        this.deliver = deliver;
    }
    get enabled() {
        return this.settings.enabled;
    }
    /** 启动轮询（1 秒一次；目录不存在会自动创建，与 MOD 一致）。 */
    start() {
        if (this.timer !== undefined || !this.settings.enabled)
            return;
        this.timer = setInterval(() => { void this.tick(); }, 1000);
        this.timer.unref?.();
    }
    dispose() {
        this.disposed = true;
        if (this.timer !== undefined)
            clearInterval(this.timer);
        this.timer = undefined;
    }
    /** 一轮：扫事件目录 + 播报队列（导出以便测试注入时钟）。 */
    async tick(now = Date.now()) {
        this.poll(now);
        await this.drain(now);
    }
    /** 扫一遍事件目录。 */
    poll(now = Date.now()) {
        if (this.disposed || !this.settings.enabled)
            return 0;
        let handled = 0;
        try {
            const dir = this.eventsDir();
            // 目录不存在就建（与 MOD 的 Directory.CreateDirectory 一致），别让 ENOENT 每秒刷日志。
            try {
                readdirSync(dir);
            }
            catch {
                mkdirSync(dir, { recursive: true });
                return 0;
            }
            const files = readdirSync(dir)
                .filter(name => name.toLowerCase().endsWith('.json'))
                .sort()
                .slice(0, BATCH_LIMIT);
            for (const name of files) {
                const path = join(dir, name);
                try {
                    const signal = parseBridgeEvent(readFileSync(path, 'utf8'), now);
                    if (signal !== undefined) {
                        this.queue.push(signal);
                        while (this.queue.length > QUEUE_LIMIT)
                            this.queue.shift();
                        this.logger.info('qq-groupmate: 桥接收到 %s 事件（session=%s）', signal.eventName, signal.sessionId.slice(0, 8) || 'none');
                        handled += 1;
                    }
                }
                catch (error) {
                    this.logger.warn('qq-groupmate: 读桥接事件 %s 失败：%s', name, String(error));
                }
                finally {
                    // 读完就删：MOD 同款语义，事件只消费一次。
                    try {
                        rmSync(path, { force: true });
                    }
                    catch { /* 下轮再清 */ }
                }
            }
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 桥接事件目录轮询失败：%s', String(error));
        }
        return handled;
    }
    /** 播报队列（0.8 秒节流，与 MOD 一致）。 */
    async drain(now) {
        while (!this.disposed) {
            if (now < this.nextSignalAt)
                return;
            const signal = this.queue.shift();
            if (signal === undefined)
                return;
            this.nextSignalAt = now + 800;
            const message = BRIDGE_ANNOUNCEMENTS[signal.eventName];
            const sent = await this.deliver(message);
            if (!sent)
                this.logger.info('qq-groupmate: 桥接播报没有送达（没有配置播报对象或发送失败）');
        }
    }
    eventsDir() {
        const configured = this.settings.eventsDir?.trim() ?? '';
        return configured === '' ? defaultBridgeEventsDir() : configured;
    }
}
