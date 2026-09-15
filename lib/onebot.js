/**
 * OneBot 11 接入层，支持两种连接方式：
 *
 * - 正向 WS（forward）：插件作为客户端，连接 NapCat / SnowLuma / LLOneBot 的 WS 服务端
 * - 反向 WS（reverse）：插件作为服务端，QQ 协议端主动连进来（NapCat 默认推荐方式）
 *
 * 两种方式共用同一套事件分派与 API 调用（echo 关联请求响应）。
 * 使用 Node 内置 WebSocket（Node 22+）与本仓库自带的极简 WS 服务端，零第三方依赖。
 */
import { OneBotWebSocketServer } from "./ws-server.js";
function resolveWebSocket() {
    const ctor = globalThis.WebSocket;
    if (typeof ctor !== 'function') {
        throw new Error('qq-groupmate: 当前 Node 运行时缺少内置 WebSocket，请使用 Node 22 及以上版本');
    }
    return ctor;
}
/**
 * OneBot 协议层：与传输方式无关的 echo RPC、事件分派与登录信息维护。
 * 子类只需在连接就绪时调用 {@link attach}，断开时调用 {@link detach}。
 */
class OneBotProtocol {
    options;
    logger;
    selfId;
    pending = new Map();
    echoSeq = 0;
    sendText;
    constructor(options) {
        this.options = options;
        this.logger = options.logger;
    }
    get self() {
        return this.selfId;
    }
    /** 传输就绪：登记发送通道并拉取登录信息。 */
    attach(send, connected) {
        this.sendText = send;
        void this.loadLoginInfo(connected);
    }
    /** 传输断开：清空挂起调用与登录信息。 */
    detach() {
        this.sendText = undefined;
        this.selfId = undefined;
        for (const call of this.pending.values()) {
            clearTimeout(call.timer);
            call.reject(new Error('qq-groupmate: 连接已断开，调用被取消'));
        }
        this.pending.clear();
    }
    /** 处理一条原始报文（事件或 API 响应）。 */
    handleRaw(raw) {
        if (typeof raw !== 'string')
            return;
        let payload;
        try {
            payload = JSON.parse(raw);
        }
        catch {
            this.logger.warn('qq-groupmate: 收到无法解析的报文，已忽略');
            return;
        }
        if (typeof payload !== 'object' || payload === null)
            return;
        const record = payload;
        if (typeof record.echo === 'string') {
            const call = this.pending.get(record.echo);
            if (call === undefined)
                return;
            this.pending.delete(record.echo);
            clearTimeout(call.timer);
            const response = record;
            if (response.status === 'ok' || response.retcode === 0)
                call.resolve(response.data);
            else {
                call.reject(new Error(`OneBot 调用失败 retcode=${String(response.retcode)} ${response.message ?? response.wording ?? ''}`.trim()));
            }
            return;
        }
        try {
            this.options.onEvent(record);
        }
        catch (error) {
            this.logger.error('qq-groupmate: 事件处理异常: %s', String(error));
        }
    }
    async loadLoginInfo(connected) {
        try {
            const info = await this.call('get_login_info');
            if (!connected())
                return;
            this.selfId = info.user_id;
            this.options.onStateChange?.(true, info.user_id);
            this.logger.info('qq-groupmate: 已登录 QQ %s（%s）', String(info.user_id), info.nickname);
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 获取登录信息失败: %s', String(error));
        }
    }
    /**
     * 调用一个 OneBot API。
     * @param action - OneBot 动作名。
     * @param params - 动作参数。
     * @param timeoutMs - 本次调用的超时覆盖（毫秒）；发图这类协议端要下载大文件的动作需要更久。
     */
    call(action, params = {}, timeoutMs) {
        const send = this.sendText;
        if (send === undefined) {
            return Promise.reject(new Error(`qq-groupmate: 尚未连接 OneBot 协议端，无法调用 ${action}`));
        }
        const echo = `qgm-${String(++this.echoSeq)}`;
        const limitMs = timeoutMs ?? this.options.callTimeoutMs ?? 15000;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(echo);
                reject(new Error(`qq-groupmate: 调用 ${action} 超时（${String(limitMs)}ms）`));
            }, limitMs);
            timer.unref?.();
            this.pending.set(echo, {
                resolve: value => resolve(value),
                reject,
                timer,
            });
            try {
                send(JSON.stringify({ action, params, echo }));
            }
            catch (error) {
                this.pending.delete(echo);
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    sendGroupMessage(groupId, message, timeoutMs) {
        return this.call('send_group_msg', {
            group_id: typeof groupId === 'string' ? Number(groupId) : groupId,
            message,
        }, timeoutMs);
    }
    sendPrivateMessage(userId, message, timeoutMs) {
        return this.call('send_private_msg', {
            user_id: typeof userId === 'string' ? Number(userId) : userId,
            message,
        }, timeoutMs);
    }
    getGroupInfo(groupId) {
        return this.call('get_group_info', {
            group_id: typeof groupId === 'string' ? Number(groupId) : groupId,
            no_cache: false,
        });
    }
    getGroupMemberInfo(groupId, userId) {
        return this.call('get_group_member_info', {
            group_id: typeof groupId === 'string' ? Number(groupId) : groupId,
            user_id: typeof userId === 'string' ? Number(userId) : userId,
            no_cache: false,
        });
    }
}
/** 正向 WS：插件主动连接 OneBot 服务端。 */
export class OneBotClient extends OneBotProtocol {
    clientOptions;
    socket;
    closedByUser = false;
    reconnectDelay;
    reconnectTimer;
    connected = false;
    constructor(clientOptions) {
        super(clientOptions);
        this.clientOptions = clientOptions;
        this.reconnectDelay = clientOptions.reconnectMinMs ?? 1000;
    }
    get isConnected() {
        return this.connected;
    }
    start() {
        if (this.socket !== undefined || this.closedByUser)
            return;
        this.connect();
    }
    close() {
        this.closedByUser = true;
        if (this.reconnectTimer !== undefined) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        const socket = this.socket;
        this.socket = undefined;
        this.connected = false;
        this.detach();
        try {
            socket?.close(1000, 'plugin disposed');
        }
        catch {
            // 忽略关闭阶段的异常。
        }
    }
    connect() {
        const ctor = resolveWebSocket();
        const url = this.buildUrl();
        this.logger.debug?.('qq-groupmate: 正在建立连接 %s', this.safeUrl());
        let socket;
        try {
            socket = new ctor(url);
        }
        catch (error) {
            this.logger.error('qq-groupmate: 创建 WebSocket 失败: %s', String(error));
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        socket.addEventListener('open', () => {
            this.connected = true;
            this.reconnectDelay = this.clientOptions.reconnectMinMs ?? 1000;
            this.logger.info('qq-groupmate: 已连接 OneBot 服务端 %s', this.safeUrl());
            this.attach(text => socket.send(text), () => this.connected && this.socket === socket);
        });
        socket.addEventListener('message', (event) => {
            this.handleRaw(event.data);
        });
        socket.addEventListener('close', (event) => {
            this.logger.debug?.('qq-groupmate: 连接关闭事件 code=%s reason=%s', String(event.code ?? ''), String(event.reason ?? ''));
            this.connected = false;
            this.detach();
            this.options.onStateChange?.(false);
            if (this.socket === socket)
                this.socket = undefined;
            if (this.closedByUser)
                return;
            this.logger.warn('qq-groupmate: 与 OneBot 的连接断开 (code=%s)，%sms 后重连', String(event.code ?? ''), String(this.reconnectDelay));
            this.scheduleReconnect();
        });
        socket.addEventListener('error', (event) => {
            this.logger.warn('qq-groupmate: WebSocket 错误: %s', String(event.message ?? 'unknown'));
        });
    }
    buildUrl() {
        const token = this.clientOptions.accessToken?.trim();
        if (token === undefined || token === '')
            return this.clientOptions.wsUrl;
        const separator = this.clientOptions.wsUrl.includes('?') ? '&' : '?';
        return `${this.clientOptions.wsUrl}${separator}access_token=${encodeURIComponent(token)}`;
    }
    safeUrl() {
        const token = this.clientOptions.accessToken?.trim();
        if (token === undefined || token === '')
            return this.clientOptions.wsUrl;
        return this.clientOptions.wsUrl.replace(token, '***');
    }
    scheduleReconnect() {
        if (this.closedByUser || this.reconnectTimer !== undefined)
            return;
        const base = this.reconnectDelay;
        const jitter = Math.floor(Math.random() * Math.min(1000, base / 2));
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (this.closedByUser)
                return;
            this.connect();
        }, base + jitter);
        this.reconnectTimer.unref?.();
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.clientOptions.reconnectMaxMs ?? 30000);
    }
}
/** 反向 WS：插件监听端口，QQ 协议端连进来。 */
export class OneBotServer extends OneBotProtocol {
    serverOptions;
    server;
    connection;
    connected = false;
    closing = false;
    constructor(serverOptions) {
        super(serverOptions);
        this.serverOptions = serverOptions;
    }
    get isConnected() {
        return this.connected;
    }
    start() {
        if (this.server !== undefined || this.closing)
            return;
        const host = this.serverOptions.listenHost ?? '127.0.0.1';
        const server = new OneBotWebSocketServer((connection, request) => this.accept(connection, request.url ?? '/'), this.serverOptions.accessToken);
        this.server = server;
        server.listen(this.serverOptions.listenPort, host).then(() => {
            this.logger.info('qq-groupmate: 反向 WS 已监听 ws://%s:%s（等待 QQ 协议端接入）', host, String(this.serverOptions.listenPort));
        }).catch((error) => {
            this.logger.error('qq-groupmate: 反向 WS 监听 %s:%s 失败: %s', host, String(this.serverOptions.listenPort), String(error));
        });
    }
    accept(connection, url) {
        // 同一时刻只保留最新接入的连接：OneBot 协议端重连时旧连接可能还在。
        const previous = this.connection;
        if (previous !== undefined && !previous.closed) {
            this.logger.warn('qq-groupmate: 新的协议端连接接入，关闭旧连接');
            previous.onClose = undefined;
            previous.close();
        }
        this.connection = connection;
        this.connected = true;
        this.logger.info('qq-groupmate: 协议端已接入（%s）', url);
        connection.onMessage = (text) => this.handleRaw(text);
        connection.onClose = () => {
            if (this.connection !== connection)
                return;
            this.connection = undefined;
            this.connected = false;
            this.detach();
            this.options.onStateChange?.(false);
            this.logger.warn('qq-groupmate: 协议端连接已断开，等待重新接入');
        };
        this.attach((text) => connection.send(text), () => this.connected && this.connection === connection);
    }
    close() {
        this.closing = true;
        this.connected = false;
        this.detach();
        const connection = this.connection;
        this.connection = undefined;
        connection?.close();
        void this.server?.close();
        this.server = undefined;
    }
}
