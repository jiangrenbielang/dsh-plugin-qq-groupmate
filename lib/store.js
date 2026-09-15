/**
 * 插件持久化：dsh 数据根目录解析、JSON 读写、防抖落盘。
 * 数据布局（默认 `<dsh home>/qq-groupmate/`）：
 *   characters/            角色卡目录（可被配置覆盖）
 *   state.json             每个群的运行时覆盖（角色、模型）
 *   history/<群号>.json    群聊历史
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** 解析 dsh 数据根目录：显式配置 > `$DSH_HOME` > `~/.dsh`。 */
export function resolveDshHome(explicit) {
    const configured = explicit?.trim();
    if (configured !== undefined && configured !== '')
        return configured;
    const fromEnv = process.env.DSH_HOME?.trim();
    if (fromEnv !== undefined && fromEnv !== '')
        return fromEnv;
    return join(homedir(), '.dsh');
}
/** 展开路径中的 `~`，其余原样返回。 */
export function expandHome(path) {
    if (path === '~')
        return homedir();
    if (path.startsWith('~/') || path.startsWith('~\\'))
        return join(homedir(), path.slice(2));
    return path;
}
/** 读取 JSON 文件；文件缺失或损坏时返回 `undefined`。 */
export function readJsonFile(path) {
    if (!existsSync(path))
        return undefined;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return undefined;
    }
}
/** 原子写入 JSON（先写临时文件再重命名，避免半截文件）。 */
export function writeJsonFile(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
}
/** 带防抖的 JSON 写入器，避免高频消息把磁盘写满。 */
export class DebouncedJsonFile {
    path;
    delayMs;
    timer;
    pending;
    constructor(path, delayMs = 1500) {
        this.path = path;
        this.delayMs = delayMs;
    }
    /** 安排一次写入；连续调用只落盘最后一次。 */
    schedule(value) {
        this.pending = value;
        if (this.timer !== undefined)
            return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            const next = this.pending;
            this.pending = undefined;
            if (next === undefined)
                return;
            try {
                writeJsonFile(this.path, next);
            }
            catch {
                // 落盘失败不阻塞对话，下一次写入会重试。
            }
        }, this.delayMs);
        this.timer.unref?.();
    }
    /** 立即落盘并取消挂起的写入。 */
    flush() {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        const next = this.pending;
        this.pending = undefined;
        if (next === undefined)
            return;
        try {
            writeJsonFile(this.path, next);
        }
        catch {
            // 忽略：退出阶段的落盘失败不应中断卸载。
        }
    }
}
