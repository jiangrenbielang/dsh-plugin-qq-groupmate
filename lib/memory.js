/**
 * 人类可读的记忆：把每个群/私聊的对话记录同步写成 Markdown 文件，
 * 放在工作区里，方便直接翻看，也方便 dsh 里的 agent 读取和整理。
 *
 * 目录布局（默认 `<数据目录>/memory/`）：
 *   README.md            布局说明 + 当前运行摘要
 *   groups/<群号>.md     群聊记录
 *   private/<QQ号>.md    私聊记录
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
function pad(value) {
    return value < 10 ? `0${String(value)}` : String(value);
}
function dayKey(time) {
    const date = new Date(time);
    return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function clockKey(time) {
    const date = new Date(time);
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** 把文件名里不能用的字符换掉，保留可读性。 */
function safeName(value) {
    return value.replace(/[\\/:*?"<>|]/gu, '_').slice(0, 80);
}
/** 人类可读的记忆写入器。 */
export class MemoryWriter {
    logger;
    dir;
    lastDay = new Map();
    constructor(root, logger) {
        this.logger = logger;
        this.dir = join(root, 'memory');
    }
    /** 记忆目录绝对路径。 */
    get directory() {
        return this.dir;
    }
    fileOf(scope) {
        const folder = scope.kind === 'group' ? 'groups' : 'private';
        return join(this.dir, folder, `${safeName(scope.id)}.md`);
    }
    /** 确保目录与说明文件存在，并刷新运行摘要。 */
    writeIndex(summary) {
        try {
            mkdirSync(join(this.dir, 'groups'), { recursive: true });
            mkdirSync(join(this.dir, 'private'), { recursive: true });
            const lines = [
                '# QQ 群友记忆',
                '',
                '这个目录由 `qq-groupmate` 插件自动维护，记录机器人在每个群 / 私聊里的对话。',
                '',
                '- `groups/<群号>.md`：群聊记录，格式为 `- **时间 昵称**：内容`',
                '- `private/<QQ号>.md`：私聊记录',
                '',
                '可以直接编辑这些文件；也可以在这个工作区的 dsh 会话里让 agent 读取和整理，例如：',
                '',
                '> 看看 QQ 群最近在聊什么，把重要的记下来',
                '',
                '## 当前运行状态',
                '',
                `- 连接方式：${summary.mode}（${summary.endpoint}）`,
                `- 模型：${summary.provider} / ${summary.model}`,
                `- 默认角色：${summary.character}`,
                `- 可用角色：${summary.characters.length === 0 ? '（无）' : summary.characters.join('、')}`,
                `- 已记录群：${summary.groups.length === 0 ? '（暂无）' : summary.groups.join('、')}`,
                '',
                '在 dsh 会话里可以用斜杠命令快捷切换：`/qq`、`/qq-card`、`/qq-model`、`/qq-groups`、`/qq-memory`、`/qq-reset`、`/qq-say`。',
                '',
            ];
            writeFileSync(join(this.dir, 'README.md'), lines.join('\n'), 'utf8');
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 写入记忆说明失败：%s', String(error));
        }
    }
    /** 追加一条记录；跨天时补一个日期小标题。 */
    append(scope, entry) {
        const file = this.fileOf(scope);
        try {
            mkdirSync(dirname(file), { recursive: true });
            let header = '';
            if (!existsSync(file)) {
                header = scope.kind === 'group'
                    ? `# 群 ${scope.id}\n\n> 由 qq-groupmate 自动记录；可直接编辑，或让 dsh 里的 agent 帮你整理。\n\n`
                    : `# 私聊 ${scope.id}\n\n> 由 qq-groupmate 自动记录；可直接编辑，或让 dsh 里的 agent 帮你整理。\n\n`;
            }
            const day = dayKey(entry.time);
            // lastDay 是进程内缓存：重启后从文件里已有的最后一个日期标题恢复，避免同一天重复写标题。
            if (!this.lastDay.has(file) && existsSync(file)) {
                const existing = readFileSync(file, 'utf8');
                const days = [...existing.matchAll(/^## (\d{4}-\d{2}-\d{2})\s*$/gmu)];
                const last = days[days.length - 1];
                if (last !== undefined)
                    this.lastDay.set(file, last[1]);
            }
            if (this.lastDay.get(file) !== day) {
                this.lastDay.set(file, day);
                header += `## ${day}\n\n`;
            }
            const text = entry.text.replace(/\n/gu, ' ').trim();
            appendFileSync(file, `${header}- **${clockKey(entry.time)} ${entry.speaker}**：${text}\n`, 'utf8');
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 写入记忆文件失败：%s', String(error));
        }
    }
    /** 清空一个归属的记录文件。 */
    clear(scope) {
        const file = this.fileOf(scope);
        try {
            rmSync(file, { force: true });
            this.lastDay.delete(file);
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 清空记忆文件失败：%s', String(error));
        }
    }
    /** 读取最近若干条记录，用于会话内 `/qq-memory` 展示。 */
    tail(scope, lines) {
        const file = this.fileOf(scope);
        if (!existsSync(file))
            return [];
        try {
            return readFileSync(file, 'utf8')
                .split('\n')
                .filter(line => line.startsWith('- **'))
                .slice(-Math.max(1, lines));
        }
        catch {
            return [];
        }
    }
    /** 列出已经记录过的归属。 */
    list(kind) {
        const folder = join(this.dir, kind === 'group' ? 'groups' : 'private');
        if (!existsSync(folder))
            return [];
        try {
            return readdirSync(folder)
                .filter(name => name.endsWith('.md'))
                .map(name => name.replace(/\.md$/u, ''));
        }
        catch {
            return [];
        }
    }
}
