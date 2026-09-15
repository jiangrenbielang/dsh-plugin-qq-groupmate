/**
 * 极简 WebSocket 服务端（仅文本帧），用于反向 WS 模式：
 * QQ 协议端（NapCat / SnowLuma / LLOneBot）主动连进来，插件在这里收事件、发 API。
 * 只实现握手 + 文本帧收发 + ping/pong/close，零第三方依赖。
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
function acceptKey(key) {
    return createHash('sha1').update(key + GUID).digest('base64');
}
function encodeFrame(text) {
    const payload = Buffer.from(text, 'utf8');
    const length = payload.length;
    if (length < 126)
        return Buffer.concat([Buffer.from([0x81, length]), payload]);
    if (length < 65536) {
        const header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(length, 2);
        return Buffer.concat([header, payload]);
    }
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
    return Buffer.concat([header, payload]);
}
class Connection {
    socket;
    onMessage;
    onClose;
    closed = false;
    buffer = Buffer.alloc(0);
    /** 分片消息的已收片段与起始 opcode（RFC 6455：FIN=0 起头，0x0 续帧，FIN=1 收尾）。 */
    fragments = [];
    fragmentOpcode = 0;
    /** 分片消息累计字节数：单帧有上限，但连续 FIN=0 帧的总量必须另行封顶，否则内存无界增长。 */
    fragmentBytes = 0;
    constructor(socket) {
        this.socket = socket;
        socket.on('data', (chunk) => this.feed(chunk));
        socket.on('close', () => this.finish());
        socket.on('error', () => this.finish());
    }
    /** 清空分片状态：消息收完、连接结束时都要复位，防止残留内存。 */
    resetFragments() {
        this.fragments = [];
        this.fragmentOpcode = 0;
        this.fragmentBytes = 0;
    }
    /** 收下一个分片；累计超过整体上限时按协议违规断开并返回 false。 */
    pushFragment(payload) {
        if (this.fragmentBytes + payload.length > MAX_PAYLOAD_BYTES) {
            console.warn(`qq-groupmate: WebSocket 分片消息累计超过 ${String(MAX_PAYLOAD_BYTES)} 字节上限，断开连接`);
            this.close();
            return false;
        }
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
        return true;
    }
    finish() {
        if (this.closed)
            return;
        this.closed = true;
        this.resetFragments();
        this.buffer = Buffer.alloc(0);
        this.onClose?.();
    }
    feed(chunk) {
        // 连接已关闭（含刚因超限被断开）后不再解析任何数据。
        if (this.closed)
            return;
        // 对端持续推数据但不构成完整帧时，缓冲不能无界增长。
        if (this.buffer.length + chunk.length > MAX_PAYLOAD_BYTES + 64 * 1024) {
            this.close();
            return;
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 2) {
            const first = this.buffer[0] ?? 0;
            const second = this.buffer[1] ?? 0;
            const fin = (first & 0x80) !== 0;
            const opcode = first & 0x0f;
            const masked = (second & 0x80) !== 0;
            let length = second & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (this.buffer.length < 4)
                    return;
                length = this.buffer.readUInt16BE(2);
                offset = 4;
            }
            else if (length === 127) {
                if (this.buffer.length < 10)
                    return;
                const big = this.buffer.readBigUInt64BE(2);
                if (big > BigInt(MAX_PAYLOAD_BYTES)) {
                    this.close();
                    return;
                }
                length = Number(big);
                offset = 10;
            }
            // 16 位路径同样要查上限，否则超大文本帧会被收下。
            if (length > MAX_PAYLOAD_BYTES) {
                this.close();
                return;
            }
            const maskLength = masked ? 4 : 0;
            if (this.buffer.length < offset + maskLength + length)
                return;
            const maskKey = masked ? this.buffer.subarray(offset, offset + 4) : undefined;
            const start = offset + maskLength;
            const payload = Buffer.from(this.buffer.subarray(start, start + length));
            this.buffer = this.buffer.subarray(start + length);
            if (maskKey !== undefined) {
                for (let index = 0; index < payload.length; index += 1) {
                    payload[index] = (payload[index] ?? 0) ^ (maskKey[index % 4] ?? 0);
                }
            }
            // 控制帧（close/ping/pong）可以插在分片消息中间，优先处理。
            if (opcode === 0x8) {
                this.close();
                return;
            }
            if (opcode === 0x9) {
                if (payload.length > 125) {
                    // 控制帧载荷超过 125 违反协议，没法正确回 pong，直接断开。
                    this.close();
                    return;
                }
                const pong = Buffer.alloc(2 + payload.length);
                pong[0] = 0x8a;
                pong[1] = payload.length;
                payload.copy(pong, 2);
                try {
                    this.socket.write(pong);
                }
                catch {
                    // 连接已断开。
                }
                continue;
            }
            if (opcode === 0xa)
                continue;
            if (opcode === 0x0) {
                // 分片消息的续帧。
                if (this.fragments.length === 0) {
                    this.close();
                    return;
                }
                if (!this.pushFragment(payload))
                    return;
            }
            else if (opcode === 0x1 || opcode === 0x2) {
                if (this.fragments.length > 0 || this.fragmentOpcode !== 0) {
                    // 上一条分片还没收完又来新消息，协议错误。
                    this.close();
                    return;
                }
                if (fin) {
                    if (opcode === 0x1)
                        this.onMessage?.(payload.toString('utf8'));
                    continue;
                }
                this.fragmentOpcode = opcode;
                if (!this.pushFragment(payload))
                    return;
                continue;
            }
            else {
                // 不认识的 opcode，协议错误。
                this.close();
                return;
            }
            if (fin) {
                const whole = Buffer.concat(this.fragments);
                const startOpcode = this.fragmentOpcode;
                this.resetFragments();
                if (startOpcode === 0x1)
                    this.onMessage?.(whole.toString('utf8'));
            }
        }
    }
    send(text) {
        if (this.closed)
            return;
        try {
            this.socket.write(encodeFrame(text));
        }
        catch {
            this.finish();
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        // 连接结束，分片与解析缓冲都不再需要，尽早释放。
        this.resetFragments();
        this.buffer = Buffer.alloc(0);
        try {
            this.socket.end(Buffer.from([0x88, 0x00]));
        }
        catch {
            // 忽略关闭异常。
        }
        this.onClose?.();
    }
}
/** 反向 WS 服务端：接受 OneBot 协议端连接。 */
export class OneBotWebSocketServer {
    onConnection;
    expectedToken;
    server;
    constructor(onConnection, 
    /** 期望的 access token；为空表示不校验。 */
    expectedToken) {
        this.onConnection = onConnection;
        this.expectedToken = expectedToken;
    }
    /** 开始监听；端口被占用时抛错。 */
    listen(port, host) {
        const server = createServer();
        this.server = server;
        server.on('upgrade', (request, socket) => {
            const key = request.headers['sec-websocket-key'];
            if (typeof key !== 'string') {
                socket.destroy();
                return;
            }
            if (!this.authorized(request)) {
                socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }
            socket.write([
                'HTTP/1.1 101 Switching Protocols',
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Accept: ${acceptKey(key)}`,
                '',
                '',
            ].join('\r\n'));
            this.onConnection(new Connection(socket), request);
        });
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => {
                server.off('error', reject);
                resolve();
            });
        });
    }
    authorized(request) {
        const expected = this.expectedToken?.trim();
        if (expected === undefined || expected === '')
            return true;
        const url = new URL(request.url ?? '/', 'http://localhost');
        const provided = url.searchParams.get('access_token')
            ?? request.headers.authorization?.replace(/^Bearer\s+/iu, '');
        return provided === expected;
    }
    /** 停止监听。 */
    close() {
        const server = this.server;
        this.server = undefined;
        if (server === undefined)
            return Promise.resolve();
        return new Promise((resolve) => {
            server.close(() => resolve());
        });
    }
}
