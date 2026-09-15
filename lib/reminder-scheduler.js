/**
 * 定时提醒的调度器：到点把机器人叫醒、主动在群里开口，并处理迟到补偿。
 *
 * 与「AI 信件」（notes.ts）的区别：信件是机器人自己想说话（等群里安静、有冷却），
 * 提醒是**群友明确要求**的（「明天九点提醒我交作业」），所以到点就发、不看群安不安静。
 *
 * 关键行为（都是真踩过的坑）：
 * - **启动后先扫一遍**：dsh 关着的时候到点的提醒不会凭空消失，`catchUpMinutes` 窗口内补发，
 *   超窗口的标记 missed（下次被问到能如实说「那条错过了」）。
 * - **先占位再发**：`claim` 会立刻落盘 running，发完才 `markFired`。
 *   执行到一半进程被杀，下次启动按僵尸回收重试——而不是当成功丢掉。
 * - **周期提醒基准不漂移**：见 reminders.ts 的 markFired。
 */
import { describeReminder, formatClock } from "./reminders.js";
/** 扫描间隔：提醒是分钟级的，15 秒足够精确又不费电。 */
const TICK_MS = 15_000;
/** 调度器：tick 里挑出到点的提醒并投递。 */
export class ReminderScheduler {
    deps;
    timer;
    running = false;
    disposed = false;
    constructor(deps) {
        this.deps = deps;
    }
    /** 启动：立刻扫一遍（补发迟到），然后按间隔扫。 */
    start() {
        if (this.disposed || this.timer !== undefined)
            return;
        if (!this.deps.store)
            return;
        // 启动扫描异步跑，别拖住插件启动。
        void this.tick();
        this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
        this.timer.unref?.();
    }
    /** 停止调度。 */
    dispose() {
        this.disposed = true;
        if (this.timer !== undefined)
            clearInterval(this.timer);
        this.timer = undefined;
    }
    /**
     * 扫一次：回收僵尸、挑出该执行的、标记错过的。
     * 重入保护：上一轮还没跑完就不再开一轮（提醒发送可能慢）。
     */
    async tick() {
        if (this.disposed || this.running)
            return;
        this.running = true;
        const now = this.deps.now?.() ?? Date.now();
        try {
            const swept = this.deps.store.sweep(now);
            for (const id of swept.recovered) {
                this.deps.logger.warn('qq-groupmate: 提醒 %s 上次执行到一半就中断了，已放回队列重试', id);
            }
            for (const item of swept.missed) {
                // 错过的只记日志：主动去说「你那条错过了」反而像刷屏，等群友问起再答。
                this.deps.logger.warn('qq-groupmate: 提醒「%s」已错过（到点 %s，超出补发窗口）', item.text, formatClock(item.dueAt));
            }
            for (const item of swept.fired)
                await this.deliver(item, now);
        }
        catch (error) {
            this.deps.logger.error('qq-groupmate: 提醒调度出错: %s', String(error));
        }
        finally {
            this.running = false;
        }
    }
    /** 投递一条提醒。 */
    async deliver(item, now) {
        if (!this.deps.store.claim(item.id, now))
            return;
        const late = now - item.dueAt;
        const text = renderReminderMessage(item, late, this.deps.mentionTarget);
        let ok = false;
        try {
            ok = await this.deps.say(item.chatKey, text, {
                ...(this.deps.mentionTarget && item.targetUserId !== '' ? { mentionUserId: item.targetUserId } : {}),
                voice: this.deps.voice,
            });
        }
        catch (error) {
            this.deps.logger.warn('qq-groupmate: 提醒「%s」发送异常：%s', item.text, String(error));
            ok = false;
        }
        if (ok) {
            this.deps.store.markFired(item.id, { at: now });
            this.deps.logger.info('qq-groupmate: 提醒已发出（%s）：「%s」%s', item.chatKey, item.text, late > 60_000 ? `（迟到 ${String(Math.round(late / 60_000))} 分钟）` : '');
        }
        else {
            // 发失败就放回队列下轮重试，不消耗重试次数（可能是协议端临时不通）。
            this.deps.store.release(item.id, now);
            this.deps.logger.warn('qq-groupmate: 提醒「%s」没能发出，放回队列重试', item.text);
        }
    }
}
/**
 * 组装一条提醒的正文。
 * 迟到的会自然带一句解释（不然群友会奇怪为什么时间对不上）；
 * 周期提醒会把「下次什么时候」也说清楚。
 */
export function renderReminderMessage(item, lateMs, mentionTarget) {
    const who = mentionTarget && item.targetUserId !== '' ? `[CQ:at,qq=${item.targetUserId}] ` : '';
    const head = lateMs > 120_000
        ? `（这条是补发的：本来该在 ${formatClock(item.dueAt)} 提醒你）`
        : '';
    const body = `提醒一下：${item.text}`;
    const note = item.note === '' ? '' : `（${item.note}）`;
    const repeat = item.repeat.kind === 'none' ? '' : '（周期提醒，到点我还会说）';
    return [head, `${who}${body}${note}${repeat}`].filter(part => part !== '').join('\n');
}
/** 提醒状态的文字摘要（命令回复用）。 */
export function renderReminderList(items, now = Date.now()) {
    if (items.length === 0)
        return '当前没有挂着的提醒。';
    const lines = [`挂着 ${String(items.length)} 条提醒：`];
    for (const item of items) {
        const id = item.id.replace(/^r_/u, '').slice(-6);
        lines.push(`- [${id}] ${describeReminder(item, now)}`);
    }
    lines.push('取消：发「提醒取消 <编号后 6 位>」。');
    return lines.join('\n');
}
