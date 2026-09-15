/**
 * 生图网页引擎：用无头浏览器打开配置里指定的生图页面，
 * 往页面里注入桥接脚本，让**网页自己**的生图流程出图，只把出图地址拿回来。
 *
 * 为什么这么做：生图参数（模型、画师串、负面词、sampler、nocache…）都长在网页的
 * 「NAI画图正则」模板里，网页升级参数跟着变；我们不抄参数、不自己拼接口，
 * 只驱动页面，从它自己拼好的 URL 模板发起生成。
 *
 * 下载不走浏览器：这台机器上 Chromium 的网络栈不可靠（网络进程反复崩溃、
 * 实测只有个位数 KB/s），出图地址由插件侧下载（见 imagegen.ts 的中转抢跑）。
 *
 * CDP 通信零依赖：DevTools 调试协议走 WebSocket，这里自带一个最小客户端
 * （握手 + 掩码帧 + 分片重组），不引任何包。
 */
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
/** 生图页面地址（由配置的 imageGen.pageUrl 注入）；为空表示没配，网页引擎不可用。 */
/**
 * 桥接脚本位置：编译产物在 <插件>/lib/，桥接在 <插件>/rphub/qq-bridge.js。
 *
 * 不能只写死 `../rphub/`：安装后模块躺在 `plugins/qq-groupmate/` 下，
 * `../rphub/` 会指到 `plugins/rphub/`——装漏时出图直接 ENOENT 掉进直连兜底，
 * 表现就是「网页引擎主路明明开着却要等十几分钟」。
 * 所以按候选顺序探测，取第一个真实存在的文件。
 */
function candidateBridgePaths() {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    return [
        // 常规布局：lib/*.js 或 plugins/qq-groupmate/*.js 的上一级目录下的 rphub/
        path.join(moduleDir, '..', 'rphub', 'qq-bridge.js'),
        // 模块就在 rphub/ 里（少数打包方式）。
        path.join(moduleDir, 'rphub', 'qq-bridge.js'),
        // 模块在 lib/rphub/ 子目录里。
        path.join(moduleDir, '..', '..', 'rphub', 'qq-bridge.js'),
        // 旧部署把桥接放在 plugins/rphub/（`../rphub/` 的解析结果），兼容它。
        path.join(moduleDir, '..', '..', '..', 'rphub', 'qq-bridge.js'),
    ].map(candidate => path.resolve(candidate));
}
/** 找到真实存在的桥接脚本路径；都没有返回 undefined。 */
export function resolveBridgePath() {
    return candidateBridgePaths().find(candidate => {
        try {
            return fs.statSync(candidate).isFile();
        }
        catch {
            return false;
        }
    });
}
/** 按 Windows 常见位置探测 Edge / Chrome。 */
export function detectBrowserPath() {
    const candidates = [
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        process.env.LOCALAPPDATA === undefined ? '' : `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    ].filter(item => item !== '');
    return candidates.find(candidate => {
        try {
            return fs.statSync(candidate).isFile();
        }
        catch {
            return false;
        }
    });
}
/**
 * 最小 DevTools WebSocket 客户端。
 * 只实现需要的部分：文本帧（客户端帧必须掩码）、分片重组、ping/pong、close。
 */
class DevtoolsSocket {
    port;
    targetPath;
    logger;
    socket = null;
    nextId = 1;
    pending = new Map();
    incoming = Buffer.alloc(0);
    fragments = [];
    closed = false;
    constructor(port, targetPath, logger) {
        this.port = port;
        this.targetPath = targetPath;
        this.logger = logger;
    }
    /** 建立调试连接；失败抛错。 */
    async connect(timeoutMs = 15000) {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), timeoutMs);
            const socket = net.connect(this.port, '127.0.0.1');
            const fail = (error) => {
                clearTimeout(timer);
                socket.destroy();
                reject(error);
            };
            socket.once('error', fail);
            socket.once('connect', () => {
                const key = crypto.randomBytes(16).toString('base64');
                socket.write(`GET ${this.targetPath} HTTP/1.1\r\n` +
                    `Host: 127.0.0.1:${String(this.port)}\r\n` +
                    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
            });
            // 等 101 响应头，之后进入帧解析。
            const handshake = (chunk) => {
                this.incoming = Buffer.concat([this.incoming, chunk]);
                const headerEnd = this.incoming.indexOf('\r\n\r\n');
                if (headerEnd < 0)
                    return;
                const head = this.incoming.subarray(0, headerEnd).toString('utf8');
                this.incoming = this.incoming.subarray(headerEnd + 4);
                socket.off('data', handshake);
                if (!/^HTTP\/1\.1 101/u.test(head)) {
                    fail(new Error(`WebSocket 握手被拒绝：${head.split('\r\n')[0] ?? ''}`));
                    return;
                }
                clearTimeout(timer);
                socket.on('data', chunk2 => this.onData(chunk2));
                socket.on('error', error => this.onClose(error));
                socket.on('close', () => this.onClose(new Error('连接被关闭')));
                this.socket = socket;
                resolve();
            };
            socket.on('data', handshake);
        });
    }
    /** 调一条 DevTools 命令。 */
    call(method, params = {}, timeoutMs = 60000) {
        if (this.closed || this.socket === null)
            return Promise.reject(new Error('调试连接未打开'));
        const id = this.nextId;
        this.nextId += 1;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} 超时（${String(timeoutMs)}ms）`));
            }, timeoutMs);
            timer.unref?.();
            this.pending.set(id, { resolve, reject, timer });
            this.sendFrame(0x1, Buffer.from(JSON.stringify({ id, method, params }), 'utf8'));
        });
    }
    /** 关闭连接；幂等。 */
    close() {
        this.closed = true;
        try {
            this.sendFrame(0x8, Buffer.alloc(0));
        }
        catch { /* 连接可能已断 */ }
        this.socket?.destroy();
        this.socket = null;
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(new Error('调试连接已关闭'));
        }
        this.pending.clear();
    }
    sendFrame(opcode, payload) {
        const socket = this.socket;
        if (socket === null)
            throw new Error('调试连接未打开');
        const mask = crypto.randomBytes(4);
        const masked = Buffer.from(payload);
        for (let index = 0; index < masked.length; index += 1) {
            masked[index] = masked[index] ^ mask[index % 4];
        }
        let header;
        if (payload.length < 126) {
            header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
        }
        else if (payload.length < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x80 | opcode;
            header[1] = 0x80 | 126;
            header.writeUInt16BE(payload.length, 2);
        }
        else {
            header = Buffer.alloc(10);
            header[0] = 0x80 | opcode;
            header[1] = 0x80 | 127;
            header.writeBigUInt64BE(BigInt(payload.length), 2);
        }
        socket.write(Buffer.concat([header, mask, masked]));
    }
    onData(chunk) {
        this.incoming = Buffer.concat([this.incoming, chunk]);
        while (true) {
            const frame = this.parseFrame();
            if (frame === undefined)
                break;
            this.handleFrame(frame);
        }
    }
    /** 从缓冲里解析一帧；字节不够返回 undefined（等下一段）。 */
    parseFrame() {
        const buffer = this.incoming;
        if (buffer.length < 2)
            return undefined;
        const opcode = buffer[0] & 0x0f;
        const final = (buffer[0] & 0x80) !== 0;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
            if (buffer.length < offset + 2)
                return undefined;
            length = buffer.readUInt16BE(offset);
            offset += 2;
        }
        else if (length === 127) {
            if (buffer.length < offset + 8)
                return undefined;
            const big = buffer.readBigUInt64BE(offset);
            if (big > BigInt(64 * 1024 * 1024)) {
                this.logger.error('qq-groupmate: DevTools 帧超过 64MB 上限，丢弃连接');
                this.onClose(new Error('帧过大'));
                return undefined;
            }
            length = Number(big);
            offset += 8;
        }
        let mask = Buffer.alloc(0);
        if (masked) {
            if (buffer.length < offset + 4)
                return undefined;
            mask = buffer.subarray(offset, offset + 4);
            offset += 4;
        }
        if (buffer.length < offset + length)
            return undefined;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (masked) {
            for (let index = 0; index < payload.length; index += 1) {
                payload[index] = payload[index] ^ mask[index % 4];
            }
        }
        this.incoming = buffer.subarray(offset + length);
        return { opcode, payload, final };
    }
    handleFrame(frame) {
        if (frame.opcode === 0x8) {
            this.onClose(new Error('对端发送了关闭帧'));
            return;
        }
        if (frame.opcode === 0x9) {
            // ping → pong
            try {
                this.sendFrame(0xA, frame.payload);
            }
            catch { /* 连接正在断开 */ }
            return;
        }
        if (frame.opcode === 0xA)
            return;
        if (frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) {
            this.fragments.push(frame.payload);
        }
        else {
            return;
        }
        if (!frame.final)
            return;
        const message = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = [];
        this.dispatch(message);
    }
    dispatch(message) {
        let data;
        try {
            data = JSON.parse(message);
        }
        catch {
            return;
        }
        const id = typeof data.id === 'number' ? data.id : undefined;
        const entry = id !== undefined ? this.pending.get(id) : undefined;
        if (id !== undefined && entry !== undefined) {
            this.pending.delete(id);
            clearTimeout(entry.timer);
            if (data.error !== undefined) {
                entry.reject(new Error(JSON.stringify(data.error)));
            }
            else {
                entry.resolve((data.result ?? {}));
            }
            return;
        }
        // 页面 console 里的 [qq-bridge] 日志透出来，无头排障全靠它。
        if (data.method === 'Runtime.consoleAPICalled') {
            const args = Array.isArray(data.params) ? [] : data.params.args ?? [];
            const text = args.map(arg => String(arg.value ?? arg.description ?? '')).join(' ');
            if (text.includes('[qq-bridge]'))
                this.logger.info('qq-groupmate: %s', text);
        }
    }
    onClose(error) {
        if (this.closed)
            return;
        this.closed = true;
        this.socket?.destroy();
        this.socket = null;
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this.pending.clear();
    }
}
/** 浏览器引擎：拉起无头 Edge、注入桥接、调 `window.__qqGen` 出图。 */
export class RphubBrowserEngine {
    settings;
    config;
    logger;
    edge = null;
    socket = null;
    starting = null;
    idleTimer = null;
    stopped = false;
    /** 页面上一次的完整日志（诊断用）。 */
    lastError = '';
    constructor(settings, config, logger) {
        this.settings = settings;
        this.config = config;
        this.logger = logger;
    }
    get running() {
        return this.socket !== null && !this.socket.closed && this.edge !== null && this.edge.exitCode === null;
    }
    /**
     * 出一张图：确保引擎起来，然后让页面自己的生图流程跑完，返回出图地址。
     * 引擎起不来或页面报错都会抛错，由调用方决定兜底。
     * @param prompt - 画面标签。
     * @param options - 只带 `seed`：画师串/尺寸/模型写在页面 settings 里，靠重建引擎生效。
     */
    async generateImageUrl(prompt, options = {}) {
        this.touch();
        await this.ensureStarted();
        const expression = `window.__qqGen(${JSON.stringify(prompt)}, ${JSON.stringify({
            ...(options.seed === undefined ? {} : { seed: options.seed }),
        })})`;
        const result = await this.evaluate(expression, this.settings.timeoutMs);
        const imageUrl = typeof result.imageUrl === 'string' ? result.imageUrl : '';
        const jobId = typeof result.jobId === 'string' ? result.jobId : '';
        if (imageUrl === '')
            throw new Error(`页面生图完成但没有给地址：${JSON.stringify(result).slice(0, 200)}`);
        this.touch();
        return { imageUrl, jobId };
    }
    /** 停引擎：杀浏览器、断连接；幂等。 */
    async dispose() {
        this.stopped = true;
        if (this.idleTimer !== null) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this.socket?.close();
        this.socket = null;
        this.killEdge();
        this.starting = null;
    }
    /** 空闲自动停：15 分钟没出图就杀掉浏览器（下次用时冷启动几秒，省内存）。 */
    touch() {
        if (this.idleTimer !== null)
            clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            void this.dispose();
        }, 15 * 60 * 1000);
        this.idleTimer.unref?.();
    }
    /** 确保浏览器和调试连接都活着（带并发去重）。 */
    async ensureStarted() {
        if (this.stopped)
            throw new Error('引擎已停止');
        if (this.running)
            return;
        if (this.starting !== null)
            return this.starting;
        this.starting = this.start();
        try {
            await this.starting;
        }
        finally {
            this.starting = null;
        }
    }
    async start() {
        this.killEdge();
        const browserPath = this.settings.browserPath !== '' ? this.settings.browserPath : detectBrowserPath();
        if (browserPath === undefined)
            throw new Error('没找到 Edge/Chrome，请在设置里填浏览器路径');
        const profileDir = path.join(os.tmpdir(), 'qq-groupmate-rphub-profile');
        const args = [
            '--headless=new',
            '--disable-gpu',
            '--disable-quic',
            // 关键：绕开系统代理。用户 VPN 的代理会把 unpkg/jsdelivr 挡掉，
            // 页面拿不到 Vue 就白屏；直连是好的。
            '--no-proxy-server',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-extensions',
            '--disable-sync',
            '--window-size=1100,1400',
            `--remote-debugging-port=${String(this.settings.browserPort)}`,
            `--user-data-dir=${profileDir}`,
            this.settings.pageUrl,
        ];
        this.logger.info('qq-groupmate: 启动生图浏览器（%s）', browserPath);
        this.edge = spawn(browserPath, args, { stdio: 'ignore', windowsHide: true });
        // ENOENT 等启动失败会发 error 事件，没有监听器会崩掉整个插件进程。
        this.edge.once('error', error => {
            this.logger.warn('qq-groupmate: 生图浏览器进程出错：%s', String(error));
            this.socket?.close();
            this.socket = null;
        });
        this.edge.once('exit', () => {
            // 进程退出时把连接标记为断开，下次 ensureStarted 会重新拉起。
            this.socket?.close();
            this.socket = null;
        });
        const page = await this.waitForPage();
        const wsUrl = new URL(page.webSocketDebuggerUrl);
        const socket = new DevtoolsSocket(this.settings.browserPort, `${wsUrl.pathname}${wsUrl.search}`, this.logger);
        await socket.connect();
        this.socket = socket;
        await socket.call('Runtime.enable');
        await socket.call('Page.enable');
        // 注入必须发生在页面脚本之前：先注册配置、再注册桥接（同一次导航里按注册顺序执行）。
        await socket.call('Page.addScriptToEvaluateOnNewDocument', {
            source: `window.__qqConfig = ${JSON.stringify(this.config)};`,
        });
        const bridgePath = resolveBridgePath();
        if (bridgePath === undefined) {
            const searched = candidateBridgePaths().join('、');
            throw new Error(`桥接脚本缺失（找过：${searched}）；重装插件时确保 rphub/qq-bridge.js 一起拷过去`);
        }
        const bridge = await fs.promises.readFile(bridgePath, 'utf8');
        await socket.call('Page.addScriptToEvaluateOnNewDocument', { source: bridge });
        await socket.call('Page.reload');
        await this.waitForBridgeReady(socket);
        this.logger.info('qq-groupmate: 生图页面就绪，生图走网页主路');
    }
    /** 等 DevTools 出现生图页面。 */
    async waitForPage() {
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            if (this.edge?.exitCode !== null && this.edge?.exitCode !== undefined) {
                throw new Error(`浏览器启动后立即退出（code ${String(this.edge.exitCode)}）`);
            }
            try {
                const response = await fetch(`http://127.0.0.1:${String(this.settings.browserPort)}/json/list`, {
                    signal: AbortSignal.timeout(3000),
                });
                const targets = await response.json();
                const page = targets.find(item => item.type === 'page' && (item.url ?? '').startsWith(this.settings.pageUrl));
                if (page?.webSocketDebuggerUrl !== undefined) {
                    return { webSocketDebuggerUrl: page.webSocketDebuggerUrl };
                }
            }
            catch { /* 端口还没起来，继续等 */ }
            await new Promise(resolve => {
                const timer = setTimeout(resolve, 500);
                timer.unref?.();
            });
        }
        throw new Error('等不到生图页面的调试端口（60 秒）');
    }
    /** 等桥接就绪：页面 Vue 挂载 + 生图模板可读（CDN 慢时要等一会）。 */
    async waitForBridgeReady(socket) {
        const deadline = Date.now() + 120000;
        let lastInfo = '';
        while (Date.now() < deadline) {
            try {
                const result = await this.evaluate('window.__qqInfo ? window.__qqInfo() : null', 10000, socket);
                lastInfo = JSON.stringify(result);
                if (result !== null && result !== undefined && result.ready === true && result.template !== '')
                    return;
            }
            catch { /* 导航中 evaluate 会失败，继续等 */ }
            await new Promise(resolve => {
                const timer = setTimeout(resolve, 1000);
                timer.unref?.();
            });
        }
        throw new Error(`生图页面桥接 120 秒没就绪（最后状态：${lastInfo.slice(0, 200)}）`);
    }
    /** 在页面里执行一段 JS 并返回值。 */
    async evaluate(expression, timeoutMs, socketOverride) {
        const socket = socketOverride ?? this.socket;
        if (socket === null)
            throw new Error('调试连接未打开');
        const result = await socket.call('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
        }, timeoutMs);
        if (result.exceptionDetails !== undefined) {
            const detail = result.exceptionDetails;
            throw new Error(detail.exception?.description ?? '页面执行出错');
        }
        // Runtime.evaluate 的 returnByValue 结果是 RemoteObject 包装（{type, value}），剥掉取 value。
        const remote = (result.result ?? {});
        return (remote.value ?? remote);
    }
    killEdge() {
        this.socket?.close();
        this.socket = null;
        const edge = this.edge;
        this.edge = null;
        if (edge === null || edge.exitCode !== null)
            return;
        try {
            edge.kill();
        }
        catch { /* 进程可能已退出 */ }
    }
}
/** 供测试注入假桥接路径用（真实环境用探测结果）。 */
export function bridgePathForTest() {
    return resolveBridgePath();
}
