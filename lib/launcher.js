/**
 * QQ 协议端进程托管：把 SnowLuma 这类 OneBot 协议端交给插件拉起。
 *
 * 两种模式（设置页可切换）：
 * - `local`：本地托管——dsh 启动 QQ 群友时自动打开协议端，可随时启停、看状态
 * - `external`：外部手动——协议端由用户自己开，插件只连接、不碰进程
 *
 * 运行状态用 netstat 查监听端口判断（不打扰协议端本身）；启动后轮询端口等它就绪。
 *
 * 两种启动方式：
 * - 显示窗口（默认）：走 `cmd /c start "QQ 协议端" …`，协议端有自己的控制台窗口；
 *   这种模式下拿不到可靠 pid（cmd 立刻退出），一律用端口跟踪进程
 * - 不显示窗口：直接 spawn 并 `detached`，输出写进日志文件，可以拿到 pid 与退出事件
 *
 * 注意：Windows 上 Node 的 `detached: true` 等于 DETACHED_PROCESS，子进程**不会**拿到
 * 控制台窗口，所以「显示窗口」不能靠它，必须用 `start`。
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createConnection } from 'node:net';
const DELAY_STEP_MS = 700;
const STOP_WAIT_MS = 12_000;
const REFRESH_INTERVAL_MS = 15_000;
/** 窗口模式启动后，端口最多再等多久（QQ 冷启动可能一两分钟，超时后仍会后台等）。 */
const PENDING_GIVE_UP_SECONDS = 300;
function delay(ms) {
    return new Promise(resolve => { setTimeout(resolve, ms); });
}
/**
 * 按命令行文本切分 token，支持引号包裹的路径（Windows 路径常带空格）。
 * @param text - 完整命令行。
 * @returns token 数组；空串返回空数组。
 */
export function splitCommandLine(text) {
    const tokens = [];
    let current = '';
    let quote;
    for (const char of text) {
        if (quote !== undefined) {
            if (char === quote)
                quote = undefined;
            else
                current += char;
            continue;
        }
        if (char === '"' || char === '\'') {
            quote = char;
            continue;
        }
        if (char === ' ' || char === '\t') {
            if (current !== '') {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }
    if (current !== '')
        tokens.push(current);
    return tokens;
}
/**
 * 构造「在新控制台窗口里启动」的 cmd.exe 参数。
 * @param exe - 可执行文件或脚本路径。
 * @param args - 参数。
 * @returns cmd.exe 的参数数组。
 */
export function buildConsoleStartArgs(exe, args) {
    // start 会把第一个带引号的参数当窗口标题；exe 与参数全部显式加引号，
    // 否则路径里的 & | % 等 cmd 元字符会被当成命令分隔符。
    const quote = (value) => `"${value.replace(/"/gu, '""')}"`;
    return ['/d', '/c', 'start', '"QQ 协议端"', quote(exe), ...args.map(quote)];
}
/**
 * 窗口模式 spawn cmd.exe 时的选项。
 *
 * **必须带 `windowsVerbatimArguments`**：Node 默认会按 MSVCRT 规则再给每个参数
 * 加引号/转义（参数里的引号变成 `\"`），而 cmd.exe 不认 `\"`——它会把这些反斜杠
 * 当普通字符，于是 `start` 的「标题 / 命令」切分错位，表现为**没有窗口、只听到
 * 系统报错音**（本插件 2026-09-10 踩过）。这里让 Node 原样透传我们自己拼好的引号。
 *
 * @param cwd - 工作目录；未指定时用调用方当前目录。
 * @returns spawn 选项。
 */
export function buildConsoleSpawnOptions(cwd) {
    return {
        ...(cwd === undefined ? {} : { cwd }),
        windowsHide: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
    };
}
/**
 * 查某端口当前是否有进程在监听。
 * @param port - 端口号。
 * @returns 监听进程 pid；查不到或平台不支持时返回 undefined。
 */
export function findListeningPid(port) {
    try {
        if (process.platform === 'win32') {
            const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
            for (const line of output.split(/\r?\n/u)) {
                const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/iu.exec(line);
                if (match !== null && Number(match[1]) === port)
                    return Number(match[2]);
            }
            return undefined;
        }
        const output = execFileSync('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 5000 });
        const pid = Number(output.trim().split(/\r?\n/u)[0]);
        return Number.isFinite(pid) && pid > 0 ? pid : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * TCP 连一下端口，判断是否有人监听。
 * @param port - 端口号。
 * @param host - 主机，默认 127.0.0.1。
 * @param timeoutMs - 超时毫秒。
 * @returns 能连上为 true。
 */
export function probePort(port, host = '127.0.0.1', timeoutMs = 1000) {
    return new Promise((resolve) => {
        const socket = createConnection({ port, host });
        let settled = false;
        const finish = (ok) => {
            if (settled)
                return;
            settled = true;
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs, () => { finish(false); });
        socket.once('connect', () => { finish(true); });
        socket.once('error', () => { finish(false); });
    });
}
/** 结束进程树：Windows 用 taskkill，其它平台先试进程组。 */
function killTree(pid) {
    if (pid <= 0)
        return;
    try {
        if (process.platform === 'win32') {
            execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
        }
        else {
            process.kill(-pid, 'SIGTERM');
        }
    }
    catch {
        try {
            process.kill(pid, 'SIGTERM');
        }
        catch { /* 进程已经没了 */ }
    }
}
/** 已知的协议端安装位置（按顺序探测）。 */
function defaultProtocolSideDirs() {
    const candidates = [
        process.env.SNOWLUMA_HOME,
        join(homedir(), 'snowluma'),
    ];
    const dirs = candidates.filter((dir) => typeof dir === 'string' && dir.trim() !== '');
    // 兜底：扫一眼各盘根目录里名字带 snowluma 的文件夹。
    for (const root of ['C:/', 'D:/', 'E:/']) {
        try {
            for (const entry of readdirSync(root, { withFileTypes: true })) {
                if (entry.isDirectory() && /snowluma/iu.test(entry.name))
                    dirs.push(join(root, entry.name));
            }
        }
        catch {
            // 盘不存在或没权限，跳过。
        }
    }
    return dirs;
}
/**
 * 在候选目录里找协议端入口。
 * @param extraDirs - 优先探测的目录（一般放用户配置里的目录）。
 * @returns 可直接执行的命令行与工作目录；找不到返回 undefined。
 */
export function detectProtocolSideCommand(extraDirs = []) {
    for (const dir of [...extraDirs, ...defaultProtocolSideDirs()]) {
        if (dir.trim() === '')
            continue;
        const nodeExe = join(dir, 'node.exe');
        const entry = join(dir, 'index.mjs');
        if (existsSync(nodeExe) && existsSync(entry)) {
            return { command: `"${nodeExe}" "${entry}"`, workDir: dir };
        }
        for (const name of ['启动 SnowLuma.bat', 'start.bat', 'launcher.bat']) {
            const bat = join(dir, name);
            if (existsSync(bat))
                return { command: `"${bat}"`, workDir: dir };
        }
    }
    return undefined;
}
/**
 * 协议端进程托管器：一个插件实例一个，跨运行时重建保持存活。
 */
export class ProtocolSideLauncher {
    settings;
    logger;
    onChange;
    /** 隐藏窗口模式下直接 spawn 的子进程；窗口模式下为空（靠端口跟踪）。 */
    child;
    /** 插件拉起来的协议端 pid；用来区分「我们托管」与「外部进程」。 */
    ownedPid;
    /** 窗口模式已拉起、但端口还没就绪的等待状态（冷启动可能一两分钟）。 */
    pending;
    state = 'stopped';
    detail = '协议端未运行';
    pid = 0;
    /** 自动启动只做一次；用户手动停了或切了模式才重置。 */
    autoStarted = false;
    /** 启动/停止进行中，避免重入。 */
    busy = false;
    cachedCommand;
    timer;
    lastKey = '';
    /**
     * @param settings - 初始托管设置。
     * @param logger - 日志器。
     * @param onChange - 状态变化回调（插件用它刷新设置页状态）。
     */
    constructor(settings, logger, onChange) {
        this.settings = settings;
        this.logger = logger;
        this.onChange = onChange;
        this.timer = setInterval(() => { void this.refresh(); }, REFRESH_INTERVAL_MS);
        this.timer.unref?.();
    }
    /**
     * 应用新设置（每次插件配置变化时调用）。
     * @param settings - 新的托管设置。
     * @param logger - 新的日志器（日志文件路径可能变了）。
     * @param suppressAutoStart - 本次是显式动作，跳过自动启动，避免和动作打架。
     */
    configure(settings, logger, suppressAutoStart = false) {
        const previous = this.settings;
        this.settings = settings;
        this.logger = logger;
        // 模式或自动启动开关变了，允许再自动拉起一次。
        if (settings.mode !== previous.mode || settings.autoStart !== previous.autoStart)
            this.autoStarted = false;
        // 切到外部手动：把进程控制权交还用户，不杀它。
        if (settings.mode === 'external' && previous.mode === 'local' && this.ownedPid !== undefined) {
            this.logger.info('qq-groupmate: 协议端改为外部手动模式，插件不再管理进程（PID %s 继续运行）', String(this.ownedPid));
            this.child = undefined;
            this.ownedPid = undefined;
            this.pending = undefined;
        }
        if (settings.command !== previous.command || settings.workDir !== previous.workDir)
            this.cachedCommand = undefined;
        void this.refresh();
        if (!suppressAutoStart && settings.mode === 'local' && settings.autoStart && !this.autoStarted) {
            this.autoStarted = true;
            void this.start('自动启动');
        }
    }
    /**
     * 启动协议端：已经在跑就直接认领状态，否则按配置的命令拉起并等端口就绪。
     * @param reason - 触发原因，写进日志。
     */
    async start(reason = '手动') {
        if (this.settings.mode !== 'local') {
            this.logger.warn('qq-groupmate: 当前是外部手动模式，插件不启动协议端（设置页切到「本地托管」后再试）');
            return;
        }
        if (this.busy)
            return;
        this.busy = true;
        try {
            const port = this.settings.readyPort;
            const existing = findListeningPid(port);
            if (existing !== undefined) {
                this.ownedPid = this.ownedPid === existing ? existing : undefined;
                this.mark('running', existing, this.ownedPid === existing, `协议端已在运行（PID ${String(existing)}）`);
                return;
            }
            const resolved = this.resolveCommand();
            if (resolved === undefined) {
                this.mark('error', 0, false, '没找到协议端启动命令：请在设置页填写协议端启动命令');
                this.logger.error('qq-groupmate: 找不到协议端启动命令，请在设置页配置 protocolSide.command');
                return;
            }
            this.mark('starting', 0, false, `正在启动协议端（${reason}）…`);
            if (this.settings.showConsole) {
                if (!this.spawnWithConsole(resolved))
                    return;
                this.mark('starting', 0, true, '协议端启动中（新窗口）…');
                const ready = await this.waitReady();
                if (!ready) {
                    // 冷启动时 QQ 客户端也要跟着起，几十秒很正常：不判失败，继续后台等端口。
                    this.pending = { port, since: Date.now() };
                    this.mark('starting', 0, true, `协议端还在启动（QQ 冷启动可能要一两分钟），继续等端口 ${String(port)}…`);
                    this.logger.warn('qq-groupmate: 协议端窗口已打开，%s 秒内端口 %s 还没监听，继续后台等', String(this.settings.readyTimeoutSeconds), String(port));
                    return;
                }
                const listening = findListeningPid(port);
                this.ownedPid = listening;
                this.pending = undefined;
                this.mark('running', listening ?? 0, true, `协议端已启动（PID ${String(listening ?? 0)}）`);
                this.logger.info('qq-groupmate: 协议端已就绪（%s 端口已监听，PID %s）', String(port), String(listening ?? 0));
                return;
            }
            const child = this.spawnHidden(resolved);
            if (child === undefined)
                return;
            this.child = child;
            this.ownedPid = child.pid ?? undefined;
            const pid = child.pid ?? 0;
            this.mark('starting', pid, true, `协议端启动中（PID ${String(pid)}）…`);
            const ready = await this.waitReady(child);
            if (ready) {
                const listening = findListeningPid(port) ?? pid;
                this.ownedPid = listening;
                this.mark('running', listening, true, `协议端已启动（PID ${String(listening)}）`);
                this.logger.info('qq-groupmate: 协议端已就绪（%s 端口已监听，PID %s）', String(port), String(listening));
                return;
            }
            if (child.exitCode !== null) {
                this.child = undefined;
                this.ownedPid = undefined;
                this.mark('error', 0, false, `协议端启动后退出（代码 ${String(child.exitCode)}），看看它的日志`);
                this.logger.error('qq-groupmate: 协议端启动后退出（代码 %s）', String(child.exitCode));
                return;
            }
            // 进程还活着但端口没起来：冷启动可能很慢，不判失败，继续后台等。
            this.pending = { port, since: Date.now() };
            this.mark('starting', pid, true, `协议端还在启动（PID ${String(pid)}），继续等端口 ${String(port)}…`);
            this.logger.warn('qq-groupmate: 协议端进程在（PID %s），%s 秒内端口 %s 还没监听，继续后台等', String(pid), String(this.settings.readyTimeoutSeconds), String(port));
        }
        finally {
            this.busy = false;
        }
    }
    /**
     * 停止协议端：只杀插件自己拉起的进程（ownedPid / child）。
     * 特意不兜底杀「占用端口的进程」——那可能是用户自己手动开的协议端，
     * 按端口反查把别人的进程杀掉，用户 QQ 就掉线了。
     */
    async stop(reason = '手动') {
        if (this.settings.mode !== 'local') {
            this.logger.warn('qq-groupmate: 当前是外部手动模式，插件不停止协议端');
            return;
        }
        if (this.busy)
            return;
        this.busy = true;
        try {
            const port = this.settings.readyPort;
            const pid = this.ownedPid ?? this.child?.pid;
            if (pid === undefined) {
                this.child = undefined;
                this.ownedPid = undefined;
                this.pending = undefined;
                this.mark('stopped', 0, false, '插件没有托管的协议端进程（外部开的协议端请到它自己的窗口里关）');
                this.autoStarted = true;
                return;
            }
            this.mark('stopping', pid, this.ownedPid === pid, `正在停止协议端（PID ${String(pid)}）…`);
            this.logger.info('qq-groupmate: 停止协议端（%s，PID %s）', reason, String(pid));
            killTree(pid);
            const deadline = Date.now() + STOP_WAIT_MS;
            while (Date.now() < deadline) {
                if (await probePort(port, '127.0.0.1', 500)) {
                    await delay(400);
                    continue;
                }
                break;
            }
            this.child = undefined;
            this.ownedPid = undefined;
            this.pending = undefined;
            const lingering = findListeningPid(port);
            if (lingering === undefined) {
                this.mark('stopped', 0, false, '协议端已停止');
                this.logger.info('qq-groupmate: 协议端已停止');
            }
            else {
                this.mark('error', lingering, false, `端口 ${String(port)} 仍被 PID ${String(lingering)} 占用`);
                this.logger.warn('qq-groupmate: 停止后端口 %s 仍被 PID %s 占用', String(port), String(lingering));
            }
            // 用户主动停了，别被自动启动立刻拉起来。
            this.autoStarted = true;
        }
        finally {
            this.busy = false;
        }
    }
    /** 重启：先停后起。 */
    async restart() {
        await this.stop('重启');
        this.autoStarted = true;
        await this.start('重启');
    }
    /** 重新探测一次运行状态（定时调用，也可由动作触发）。 */
    async refresh() {
        if (this.busy)
            return;
        const port = this.settings.readyPort;
        const pid = findListeningPid(port);
        if (pid !== undefined) {
            // 等端口的这段时间里端口起来了：认领成自己拉起的进程。
            const owned = this.ownedPid === pid || this.pending !== undefined;
            if (owned) {
                this.ownedPid = pid;
                this.pending = undefined;
            }
            this.mark('running', pid, owned, owned
                ? `协议端运行中（PID ${String(pid)}）`
                : `协议端运行中（外部进程 PID ${String(pid)}）`);
            return;
        }
        if (this.pending !== undefined) {
            const waited = Math.round((Date.now() - this.pending.since) / 1000);
            if (waited > PENDING_GIVE_UP_SECONDS) {
                this.pending = undefined;
                this.mark('error', 0, false, `协议端窗口打开后 ${String(waited)} 秒，端口 ${String(port)} 仍未监听，看看窗口里的报错`);
                this.logger.error('qq-groupmate: 协议端窗口打开后 %s 秒端口 %s 仍未监听', String(waited), String(port));
            }
            else {
                this.mark('starting', 0, true, `协议端还在启动（已等 ${String(waited)} 秒），继续等端口 ${String(port)}…`);
            }
            return;
        }
        // 自己拉起的进程还活着但端口没起：等 start() 收尾，别覆盖状态。
        if (this.child !== undefined && this.child.exitCode === null)
            return;
        if (this.state === 'starting' || this.state === 'stopping')
            return;
        this.ownedPid = undefined;
        this.mark('stopped', 0, false, this.settings.mode === 'external' ? '协议端未运行（外部手动模式）' : '协议端未运行');
    }
    /** 状态快照，供设置页展示。 */
    snapshot() {
        return {
            mode: this.settings.mode,
            state: this.state,
            pid: this.pid,
            owned: this.state === 'running' && this.ownedPid !== undefined && this.ownedPid === this.pid,
            detail: this.detail,
            webuiUrl: this.settings.webuiUrl,
            command: this.settings.command,
        };
    }
    /** 插件卸载：按 autoStop 决定是否关掉自己拉起的协议端。 */
    dispose() {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        if (this.settings.mode === 'local' && this.settings.autoStop && this.ownedPid !== undefined) {
            this.logger.info('qq-groupmate: 插件停止，按配置关闭协议端（PID %s）', String(this.ownedPid));
            killTree(this.ownedPid);
        }
        this.child = undefined;
        this.ownedPid = undefined;
        this.pending = undefined;
    }
    /** 解析启动命令：优先用户配置，其次自动探测。 */
    resolveCommand() {
        const configured = this.settings.command.trim();
        if (configured !== '') {
            const first = splitCommandLine(configured)[0] ?? '';
            const workDir = this.settings.workDir.trim() !== '' ? this.settings.workDir.trim() : dirname(first);
            return { command: configured, workDir };
        }
        if (this.cachedCommand !== undefined)
            return this.cachedCommand;
        const detected = detectProtocolSideCommand(this.settings.workDir.trim() !== '' ? [this.settings.workDir.trim()] : []);
        if (detected !== undefined) {
            this.cachedCommand = detected;
            this.logger.info('qq-groupmate: 自动探测到协议端：%s', detected.command);
        }
        return detected;
    }
    /** 显示窗口：用 cmd 的 start 打开独立控制台（拿不到 pid，靠端口跟踪）。 */
    spawnWithConsole(resolved) {
        const tokens = splitCommandLine(resolved.command);
        const exe = tokens[0];
        if (exe === undefined) {
            this.mark('error', 0, false, '启动命令是空的');
            return false;
        }
        const args = tokens.slice(1);
        const cwd = resolved.workDir !== '' && existsSync(resolved.workDir) ? resolved.workDir : undefined;
        try {
            const child = spawn('cmd.exe', buildConsoleStartArgs(exe, args), buildConsoleSpawnOptions(cwd));
            child.unref();
            this.logger.info('qq-groupmate: 已拉起协议端（新窗口）：%s（工作目录 %s）', resolved.command, resolved.workDir === '' ? '默认' : resolved.workDir);
            return true;
        }
        catch (error) {
            this.logger.error('qq-groupmate: 协议端启动失败：%s', String(error));
            this.mark('error', 0, false, `协议端启动失败：${String(error)}`);
            return false;
        }
    }
    /** 不显示窗口：直接 spawn（detached），输出落到日志文件。 */
    spawnHidden(resolved) {
        const tokens = splitCommandLine(resolved.command);
        const exe = tokens[0];
        if (exe === undefined) {
            this.mark('error', 0, false, '启动命令是空的');
            return undefined;
        }
        const args = tokens.slice(1);
        const cwd = resolved.workDir !== '' && existsSync(resolved.workDir) ? resolved.workDir : undefined;
        const options = {
            cwd,
            detached: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        };
        try {
            const child = /\.(bat|cmd)$/iu.test(exe)
                ? spawn('cmd.exe', ['/d', '/c', 'call', exe, ...args], options)
                : spawn(exe, args, options);
            this.pipeOutput(child);
            child.once('error', (error) => {
                if (this.child !== child)
                    return;
                this.logger.error('qq-groupmate: 协议端启动失败：%s', String(error));
                this.child = undefined;
                this.ownedPid = undefined;
                this.mark('error', 0, false, `协议端启动失败：${String(error)}`);
            });
            child.once('exit', (code) => { this.onChildExit(child, code); });
            // 让协议端在 dsh 退出后继续活着（autoStop 时由 dispose 主动关）。
            child.unref();
            this.logger.info('qq-groupmate: 已拉起协议端：%s（工作目录 %s，PID %s）', resolved.command, resolved.workDir === '' ? '默认' : resolved.workDir, String(child.pid ?? 0));
            return child;
        }
        catch (error) {
            this.logger.error('qq-groupmate: 协议端启动失败：%s', String(error));
            this.mark('error', 0, false, `协议端启动失败：${String(error)}`);
            return undefined;
        }
    }
    /** 把子进程输出追加到日志文件。 */
    pipeOutput(child) {
        const logPath = this.settings.logFile.trim();
        if (logPath === '')
            return;
        try {
            mkdirSync(dirname(logPath), { recursive: true });
        }
        catch {
            return;
        }
        const write = (chunk) => {
            try {
                appendFileSync(logPath, chunk);
            }
            catch {
                // 写日志失败不影响协议端运行。
            }
        };
        child.stdout?.on('data', write);
        child.stderr?.on('data', write);
    }
    /** 轮询端口等待就绪；传了子进程还会盯着它是否提前退出。 */
    async waitReady(child) {
        const port = this.settings.readyPort;
        const deadline = Date.now() + Math.max(5, this.settings.readyTimeoutSeconds) * 1000;
        while (Date.now() < deadline) {
            if (await probePort(port, '127.0.0.1', 800))
                return true;
            if (child !== undefined && child.exitCode !== null)
                return false;
            await delay(DELAY_STEP_MS);
        }
        return false;
    }
    /** 子进程退出：只处理当前这个子进程，stop() 已收尾的迟到退出直接忽略。 */
    onChildExit(child, code) {
        if (this.child !== child)
            return;
        if (this.state === 'stopping')
            return;
        const pid = this.pid;
        this.child = undefined;
        this.ownedPid = undefined;
        // 等待端口就绪的标记一并清掉：进程都没了，refresh() 不该再把状态盖回「启动中」。
        this.pending = undefined;
        this.mark(code === 0 ? 'stopped' : 'error', 0, false, code === 0 ? '协议端已退出' : `协议端异常退出（代码 ${String(code)}）`);
        this.logger.warn('qq-groupmate: 协议端进程退出（PID %s，代码 %s）', String(pid), String(code));
    }
    /** 更新状态并通知（内容没变不通知，避免刷设置文档）。 */
    mark(state, pid, owned, detail) {
        this.state = state;
        this.pid = pid;
        this.detail = detail;
        const key = `${state}|${String(pid)}|${owned ? '1' : '0'}|${detail}`;
        if (key === this.lastKey)
            return;
        this.lastKey = key;
        this.onChange();
    }
}
