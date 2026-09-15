/**
 * 桌面工具：角色对本机电脑的受控操作。
 *
 * 只认「明确的、白名单内的」命令（正则与 MOD 对齐，改为简体），执行全在本机：
 * 截图、查看电量/内存/磁盘/网络、打开常用文件夹、窗口管理、复制文本到剪贴板、
 * 浏览器搜索、媒体键、锁定/睡眠、计时器提醒。
 *
 * 安全口径与 MOD 一致：
 * - 删除/关机/重启/关闭程序/任意终端命令/管理员提权 → 一律拒绝，回复固定话术；
 * - 涉及密码/API Key/验证码的内容绝不复制、不显示；
 * - 只有用户明确让「电脑睡眠/锁定」才执行，不会因为「我累了」就推断执行；
 * - 在 QQ 场景里额外收紧：只在私聊、且只对白名单用户（默认管理员名单）响应——
 *   群友不能远程操作这台电脑。
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir, freemem, totalmem, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { statfs } from 'node:fs/promises';
/** 帮我看电脑 → 能力清单（MOD 原文）。 */
const CAPABILITIES_REPLY = '我能替你截图、打开常用文件夹、切换或排列窗口、显示桌面、打开任务视图、复制指定文字，以及用浏览器搜索。'
    + '也能查看电量、内存、系统磁盘和网络状态；删除文件、关机、密码与任意终端命令不在权限内。';
const BLOCKED_REPLY = '这类操作可能删除数据、丢失未保存内容或暴露凭证，所以不在角色的电脑操作权限内。';
const NOT_ENABLED_REPLY = '要先在设置中打开「高级电脑操作」，我才能执行这个动作。';
/** 内容像凭证就不复制/不播报（与 mod 的 ContainsSensitiveNoteData 同款）。 */
function looksLikeCredential(text) {
    return /(api[ _-]?key|密码|验证码|信用卡|身份证|护照|passport|password|token|secret)/iu.test(text)
        || /\b(?:\d[ -]*?){12,19}\b/u.test(text)
        || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(text);
}
function formatGiB(bytes) {
    return (bytes / 1073741824).toFixed(1);
}
/** PowerShell 执行器：脚本经 UTF-16LE base64 编码传入，避免转义问题。 */
export function powerShellExec(script, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
            windowsHide: true,
        });
        let stdout = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                child.kill();
                reject(new Error('命令超时'));
            }
        }, timeoutMs);
        child.stdout?.on('data', chunk => { stdout += String(chunk); });
        child.on('error', (error) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(error);
            }
        });
        child.on('exit', (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (code === 0)
                resolve(stdout.trim());
            else
                reject(new Error(`PowerShell 退出码 ${String(code)}`));
        });
    });
}
/** 桌面工具路由器。 */
export class DesktopAgent {
    deps;
    exec;
    timers = [];
    constructor(deps, exec = powerShellExec) {
        this.deps = deps;
        this.exec = exec;
    }
    /** 当前还有几个在等的计时器。 */
    get timerCount() {
        return this.timers.length;
    }
    /**
     * 尝试把一条私聊消息路由成本机操作。
     * @returns undefined = 不是电脑命令（交给模型当普通聊天）。
     */
    async handle(text, scope) {
        if (isDeniedCommand(text))
            return { reply: BLOCKED_REPLY };
        if (describesCapabilities(text))
            return { reply: CAPABILITIES_REPLY };
        const status = await this.trySystemStatus(text);
        if (status !== undefined)
            return status;
        const folder = this.tryOpenKnownFolder(text);
        if (folder !== undefined)
            return this.gate(folder);
        const window = this.tryWindowCommand(text);
        if (window !== undefined)
            return this.gate(await window);
        const clipboard = await this.tryClipboard(text);
        if (clipboard !== undefined)
            return this.gate(clipboard);
        const search = this.tryBrowserSearch(text);
        if (search !== undefined)
            return this.gate(search);
        const media = await this.tryMediaCommand(text);
        if (media !== undefined)
            return this.gate(media);
        const lockOrSleep = this.tryLockOrSleep(text);
        if (lockOrSleep !== undefined)
            return this.gate(lockOrSleep);
        const timer = this.tryTimer(text, scope);
        if (timer !== undefined)
            return this.gate(timer);
        const screenshot = await this.tryScreenshot(text);
        if (screenshot !== undefined)
            return this.gate(screenshot);
        return undefined;
    }
    /** MOD 口径：开关没开时白名单动作一律不执行，只回提示（危险拦截/能力清单/状态查询除外）。 */
    gate(result) {
        if (this.deps.advancedEnabled())
            return result;
        return { reply: NOT_ENABLED_REPLY };
    }
    /** 开关没开时在执行前拦下（返回提示）；开着返回 undefined 表示放行。 */
    notEnabled() {
        return this.deps.advancedEnabled() ? undefined : { reply: NOT_ENABLED_REPLY };
    }
    /** 电量/内存/磁盘/网络（移植 MOD 的 TryReportSystemStatus）。 */
    async trySystemStatus(text) {
        if (/(电池|电量|battery).{0,12}(多少|几|剩|状态|level)|((多少|几|剩).{0,8}(电量|battery))/iu.test(text)) {
            try {
                const out = await this.exec('(Get-CimInstance Win32_Battery | Select-Object -First 1 | ForEach-Object { "{0}|{1}" -f $_.EstimatedChargeRemaining, $_.BatteryStatus })');
                const [percent, status] = out.split('|');
                if (percent === undefined || percent === '')
                    throw new Error('no battery');
                const charging = status === '2' || status === '6' || status === '7' || status === '8';
                return { reply: `目前电量是 ${percent}%${charging ? '，正在接电' : ''}。` };
            }
            catch {
                return { reply: '这台电脑没有报告可用的电池信息。' };
            }
        }
        if (/((系统|电脑|PC).{0,5}(内存|memory|RAM)|(内存|memory|RAM).{0,8}(使用|剩|状态|usage|status))/iu.test(text)) {
            const load = Math.round((1 - freemem() / totalmem()) * 100);
            return { reply: `内存使用率约 ${String(load)}%，可用 ${formatGiB(freemem())} GB，共 ${formatGiB(totalmem())} GB。` };
        }
        if (/((系统|C盘|磁盘|硬盘|disk|storage).{0,10}(空间|剩|可用|free))/iu.test(text)) {
            try {
                const stats = await statfs('C:');
                const free = Number(stats.bsize) * Number(stats.bavail);
                const total = Number(stats.bsize) * Number(stats.blocks);
                return { reply: `系统磁盘还有 ${formatGiB(free)} GB 可用，共 ${formatGiB(total)} GB。` };
            }
            catch {
                return { reply: '没有读到系统磁盘状态。' };
            }
        }
        if (/((网络|internet|network).{0,10}(连接|状态|通|connected|status))/iu.test(text)) {
            const online = Object.values(networkInterfaces()).some(list => (list ?? []).some(item => !item.internal && item.address !== ''));
            return { reply: online ? '本机目前有可用的网络连接。' : '本机目前没有检测到可用的网络连接。' };
        }
        return undefined;
    }
    /** 打开常用文件夹（MOD 的清单：截图/下载/桌面/文档/图片/音乐/视频/回收站）。 */
    tryOpenKnownFolder(text) {
        if (!/(打开|开启|帮我开|open|show)/iu.test(text))
            return undefined;
        const folders = [
            { pattern: /(截图|screenshot).{0,5}(文件夹|folder)/iu, path: () => this.screenshotsDir(true), label: '截图文件夹' },
            { pattern: /(下载|downloads?)/iu, path: () => join(homedir(), 'Downloads'), label: '下载文件夹' },
            { pattern: /(桌面|desktop)/iu, path: () => join(homedir(), 'Desktop'), label: '桌面文件夹' },
            { pattern: /(文档|文檔|documents?)/iu, path: () => join(homedir(), 'Documents'), label: '文档文件夹' },
            { pattern: /(图片|照片|pictures?|photos?)/iu, path: () => join(homedir(), 'Pictures'), label: '图片文件夹' },
            { pattern: /(音乐|music)/iu, path: () => join(homedir(), 'Music'), label: '音乐文件夹' },
            { pattern: /(影片|视频|videos?)/iu, path: () => join(homedir(), 'Videos'), label: '视频文件夹' },
            { pattern: /(回收站|recycle bin)/iu, path: () => 'shell:RecycleBinFolder', label: '回收站', shell: true },
        ];
        for (const folder of folders) {
            if (!folder.pattern.test(text))
                continue;
            const gate = this.notEnabled();
            if (gate !== undefined)
                return gate;
            try {
                const target = folder.path();
                if (!folder.shell && !folder.pattern.source.includes('截图'))
                    mkdirSync(target, { recursive: true });
                const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false });
                child.unref();
                return { reply: `好，替你打开${folder.label}。` };
            }
            catch (error) {
                this.deps.logger.warn('qq-groupmate: 打开文件夹失败：%s', String(error));
                return { reply: `${folder.label}没有成功打开。` };
            }
        }
        return undefined;
    }
    /** 截图存放目录（ Pictures\\QQGroupmate Screenshots）。 */
    screenshotsDir(create = false) {
        const dir = join(homedir(), 'Pictures', 'QQGroupmate Screenshots');
        if (create)
            mkdirSync(dir, { recursive: true });
        return dir;
    }
    /** 窗口管理：显示桌面 / 任务视图 / 切换窗口 / 最小化 / 最大化 / 还原 / 左右分屏。 */
    tryWindowCommand(text) {
        const actions = [
            { pattern: /显示桌面|顯示桌面|show desktop/iu, reply: '好，显示桌面。', script: '(New-Object -ComObject Shell.Application).ToggleDesktop()' },
            { pattern: /任务视图|任務視圖|task view/iu, reply: '任务视图打开了。', script: sendKeyScript([[0x5B, 0x09]]) },
            { pattern: /(切换窗口|切換窗口|alt.?tab|切换程序|切換程序)/iu, reply: '替你切到上一个窗口。', script: sendKeyScript([[0x12, 0x09]]) },
            { pattern: /(最小化|minimize)/iu, reply: '把刚才的窗口最小化了。', script: showWindowScript(6) },
            { pattern: /(最大化|maximize)/iu, reply: '把刚才的窗口最大化了。', script: showWindowScript(3) },
            { pattern: /(还原窗口|還原窗口|restore window)/iu, reply: '窗口已经恢复。', script: showWindowScript(9) },
            { pattern: /(排到左侧|排到左側|snap left|分屏左|分屏左邊)/iu, reply: '把刚才的窗口排到左侧了。', script: snapScript(0x25) },
            { pattern: /(排到右侧|排到右側|snap right|分屏右|分屏右邊)/iu, reply: '把刚才的窗口排到右侧了。', script: snapScript(0x27) },
        ];
        for (const action of actions) {
            if (!action.pattern.test(text))
                continue;
            const gate = this.notEnabled();
            if (gate !== undefined)
                return Promise.resolve(gate);
            return this.exec(action.script, 8000)
                .then(() => ({ reply: action.reply }))
                .catch((error) => {
                this.deps.logger.warn('qq-groupmate: 窗口操作失败：%s', String(error));
                return { reply: '这次没有找到能操作的窗口。' };
            });
        }
        return undefined;
    }
    /** 复制文本到剪贴板（凭证内容直接拒绝；只认引号或「复制这段：」里给的内容）。 */
    async tryClipboard(text) {
        if (!/(複製|复制|copy)/iu.test(text))
            return undefined;
        if (/(檔案|文件|資料夾|文件夹|file|folder)/iu.test(text) && !/[「『"']/u.test(text))
            return undefined;
        let value = '';
        const quoted = text.match(/[「『"'](?<value>.+?)[」』"']/u);
        if (quoted?.groups?.value !== undefined) {
            value = quoted.groups.value;
        }
        else {
            const colon = text.match(/(?:帮我|幫我|请|請)?(?:复制|複製)(?:这段|這段|文字|内容|內容)?[：:\s]+(?<value>.+)$/iu);
            if (colon?.groups?.value !== undefined)
                value = colon.groups.value.trim();
        }
        if (value === '' || value.length > 4000)
            return undefined;
        if (looksLikeCredential(value)) {
            return { reply: '为了避免凭证泄露，我不会代为复制看起来像密码、API Key 或验证码的内容。' };
        }
        const gate = this.notEnabled();
        if (gate !== undefined)
            return gate;
        const encoded = Buffer.from(value, 'utf8').toString('base64');
        const script = `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); Set-Clipboard -Value $t`;
        try {
            await this.exec(script);
            return { reply: '已经替你复制到剪贴板了。' };
        }
        catch (error) {
            this.deps.logger.warn('qq-groupmate: 写剪贴板失败：%s', String(error));
            return { reply: '剪贴板没有写成。' };
        }
    }
    /** 浏览器搜索（Google，与 MOD 一致）。 */
    tryBrowserSearch(text) {
        const match = text.match(/(?:用|在)?(?:浏览器|瀏覽器|Google|谷歌).{0,5}(?:搜索|搜尋|搜索|查詢|查询)[：:\s]*(?<query>.+)$/iu)
            ?? text.match(/(?:search|google)(?:\s+the\s+web)?(?:\s+for)?\s+(?<query>.+)$/iu);
        if (match?.groups?.query === undefined)
            return undefined;
        const query = match.groups.query.replace(/[。.!！?？\s]+$/u, '');
        if (query === '' || query.length > 500)
            return undefined;
        const gate = this.notEnabled();
        if (gate !== undefined)
            return gate;
        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        try {
            const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' });
            child.unref();
            return { reply: '好，已经在浏览器搜索了。' };
        }
        catch (error) {
            this.deps.logger.warn('qq-groupmate: 浏览器搜索失败：%s', String(error));
            return { reply: '浏览器没有成功打开。' };
        }
    }
    /** 媒体键（VK 码与 MOD 一致）。 */
    async tryMediaCommand(text) {
        if (/(不要|别|別|don't|do not)/iu.test(text))
            return undefined;
        const keys = [
            { pattern: /(下一首|下一曲|下一个|next song|next track)/iu, vk: 176, reply: '好，换到下一首。' },
            { pattern: /(上一首|上一曲|上一个|previous song|previous track)/iu, vk: 177, reply: '好，回到上一首。' },
            { pattern: /(停止音乐|停止音樂|停止播放|音乐停掉|音樂停掉|stop music|stop playback)/iu, vk: 178, reply: '音乐停下来了。' },
            { pattern: /(暂停音乐|暫停音樂|暂停播放|暫停播放|先停一下|pause music|pause playback)/iu, vk: 179, reply: '嗯，先暂停一下。' },
            { pattern: /(继续播放|繼續播放|恢复播放|恢復播放|接着播|接著播|resume music|play music)/iu, vk: 179, reply: '好，继续播放。' },
            { pattern: /(静音|靜音|关掉声音|關掉聲音|mute)/iu, vk: 173, reply: '好，静音了。' },
            { pattern: /(音量大一点|音量大一點|提高音量|调大声|調大聲|volume up|louder)/iu, vk: 175, reply: '音量调高一点了。' },
            { pattern: /(音量小一点|音量小一點|降低音量|调小声|調小聲|volume down|quieter)/iu, vk: 174, reply: '音量调低一点了。' },
        ];
        for (const key of keys) {
            if (!key.pattern.test(text))
                continue;
            const gate = this.notEnabled();
            if (gate !== undefined)
                return gate;
            try {
                await this.exec(sendKeyScript([[key.vk]]), 8000);
                return { reply: key.reply };
            }
            catch (error) {
                this.deps.logger.warn('qq-groupmate: 媒体键发送失败：%s', String(error));
                return { reply: '媒体控制没有成功。' };
            }
        }
        return undefined;
    }
    /** 锁定 / 睡眠：只有明确让电脑这么做才执行（绝不说「累了」就推断）。 */
    tryLockOrSleep(text) {
        if (/(锁屏|鎖屏|锁定电脑|鎖定電腦|锁定屏幕|鎖定屏幕|lock (?:the )?(?:computer|pc|screen))/iu.test(text)) {
            const gate = this.notEnabled();
            if (gate !== undefined)
                return gate;
            try {
                const child = spawn('rundll32.exe', ['user32.dll,LockWorkStation'], { detached: true, stdio: 'ignore' });
                child.unref();
                return { reply: '好，电脑锁好了。' };
            }
            catch {
                return { reply: '这次没有锁上。' };
            }
        }
        if (/((电脑|電腦|computer|pc).{0,6})?(睡眠|休眠|sleep|hibernate)/iu.test(text)
            && /(睡眠|休眠|sleep|hibernate)/iu.test(text)
            && /(让|讓|使|把|进去|进入|马上|现在|立即|sleep now)/iu.test(text)) {
            const gate = this.notEnabled();
            if (gate !== undefined)
                return gate;
            try {
                const child = spawn('rundll32.exe', ['powrprof.dll,SetSuspendState 0,1,0'], { detached: true, stdio: 'ignore' });
                child.unref();
                return { reply: '好，让它睡一会儿。' };
            }
            catch {
                return { reply: '这次没能让电脑睡下。' };
            }
        }
        return undefined;
    }
    /** 计时器：X 分钟后提醒我（做 Y）；到点播报；支持取消。 */
    tryTimer(text, scope) {
        if (/(取消|清除).{0,6}(计时器|計時器|提醒|timer)/iu.test(text)) {
            const count = this.cancelTimers();
            if (count > 0)
                return { reply: `已取消 ${String(count)} 个计时器。` };
            return undefined;
        }
        const match = text.match(/(?:过|過)?\s*(?<minutes>\d+(?:\.\d+)?)\s*(?:分钟|分鐘|分钟之后|分钟后|分鐘後|minutes?).{0,8}(?:提醒我|叫我|计时|計時|timer)(?:[：:\s]*(?<task>.+))?/iu);
        if (match === null || match.groups?.minutes === undefined)
            return undefined;
        const minutes = Number(match.groups.minutes);
        if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440)
            return undefined;
        const gate = this.notEnabled();
        if (gate !== undefined)
            return gate;
        const task = (match.groups.task ?? '').trim().replace(/[。.!！?？]/gu, '');
        const message = task === '' ? '计时器到时间了。' : `计时器到时间了：${task}。`;
        const timeout = setTimeout(() => {
            void this.deps.announce(scope, message);
            this.removeTimer(fireAt);
        }, minutes * 60_000);
        timeout.unref?.();
        const fireAt = Date.now() + minutes * 60_000;
        this.timers.push({ scope, message, fireAt, timeout });
        return { reply: `已设置 ${Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1)} 分钟的计时器。` };
    }
    removeTimer(fireAt) {
        const index = this.timers.findIndex(item => item.fireAt === fireAt);
        if (index >= 0)
            this.timers.splice(index, 1);
    }
    cancelTimers() {
        const count = this.timers.length;
        for (const timer of this.timers)
            clearTimeout(timer.timeout);
        this.timers.length = 0;
        return count;
    }
    /** 截图：全屏位图存到 Pictures\\QQGroupmate Screenshots，并作为图片发回私聊。 */
    async tryScreenshot(text) {
        if (!/^(?:(?:可以)?(?:帮我|幫我|请|請|替我)\s*)?(?:截(?:个|個|一张|一張)?图|截图|擷取(?:一下)?畫面|截取(?:一下)?屏幕)(?:一下|一张|一張|吧|吗|嗎|好吗|好嗎)?[。.!！?？]*$|^(?:take|capture)(?:\s+me)?\s+(?:a\s+)?(?:screenshot|screen shot|the screen)[.!?]*$/iu.test(text.trim())) {
            return undefined;
        }
        const gate = this.notEnabled();
        if (gate !== undefined)
            return gate;
        const dir = this.screenshotsDir(true);
        const file = join(dir, `screenshot-${Date.now()}.png`);
        const script = [
            'Add-Type -AssemblyName System.Windows.Forms',
            'Add-Type -AssemblyName System.Drawing',
            '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen',
            '$bmp=New-Object System.Drawing.Bitmap $b.Width, $b.Height',
            '$g=[System.Drawing.Graphics]::FromImage($bmp)',
            '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
            `$bmp.Save('${file.replace(/'/gu, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
            '$g.Dispose(); $bmp.Dispose()',
        ].join('; ');
        try {
            await this.exec(script, 20000);
            return { reply: `截好了，保存在「图片\\QQGroupmate Screenshots」里，也发你一份。`, imagePath: file };
        }
        catch (error) {
            this.deps.logger.warn('qq-groupmate: 截图失败：%s', String(error));
            return { reply: '这台电脑目前没有可用的截图方式。' };
        }
    }
}
/** 构造「按下一组键再松开」的 PowerShell 片段（keybd_event）。 */
function sendKeyScript(chords) {
    const body = chords.map(vk => `[W.N]::keybd_event(${String(vk)},0,0,[UIntPtr]::Zero); [W.N]::keybd_event(${String(vk)},0,2,[UIntPtr]::Zero)`).join('; ');
    return `${USER32_DECL}; ${body}`;
}
/** 显示桌面 / 任务视图 / 切换窗口的组合键。 */
function showWindowScript(cmd) {
    return `${USER32_DECL}; $h=[W.N]::GetForegroundWindow(); [W.N]::ShowWindow($h, ${String(cmd)})`;
}
/** 把当前前台窗口贴到左/右半屏（Win+方向键）。 */
function snapScript(vk) {
    return `${USER32_DECL}; $h=[W.N]::GetForegroundWindow(); [W.N]::SetForegroundWindow($h);`
        + ` [W.N]::keybd_event(0x5B,0,0,[UIntPtr]::Zero); [W.N]::keybd_event(${String(vk)},0,0,[UIntPtr]::Zero);`
        + ` [W.N]::keybd_event(${String(vk)},0,2,[UIntPtr]::Zero); [W.N]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)`;
}
const USER32_DECL = 'Add-Type -Namespace W -Name N -MemberDefinition \''
    + '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e); '
    + '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); '
    + '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); '
    + '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\'';
/** 危险/越权命令识别（与 MOD 的 TryHandleBlockedComputerCommand 同款正则）。 */
export function isDeniedCommand(text) {
    if (/(不要|別|别|不准|don't|do not)/iu.test(text))
        return false;
    const destructive = /((删除|刪除|清空|永久删|delete|erase|empty).{0,12}(文件|文件夾|文件夹|资料|資料|回收站|回收筒|file|folder|recycle bin)|关机|關機|重新启动|重新啟動|重启|重開機|shutdown|restart|reboot)/iu.test(text);
    const shell = /((关闭|關閉|强制结束|強制結束|kill|terminate|close).{0,8}(程序|進程|进程|应用|應用|窗口|視窗|window|process|app)|PowerShell|命令提示字元|命令提示符|CMD|terminal|终端|終端|管理员权限|管理員權限|administrator)/iu.test(text);
    const credential = /((输入|輸入|粘贴|貼上|显示|顯示|读取|讀取|enter|paste|show|read).{0,8}(密码|密碼|API.?KEY|token|验证码|驗證碼|password|OTP))/iu.test(text);
    return destructive || shell || credential;
}
/** 「你能对电脑做什么」识别。 */
export function describesCapabilities(text) {
    return /((你|妳).{0,5}(能|可以|会|會).{0,8}(操作|控制).{0,5}(电脑|電腦|PC)|(高级|高級|advanced).{0,5}(功能|controls)|what can you (?:do|control))/iu.test(text);
}
