/**
 * 日志双写：dsh 日志（控制台/客户端） + 可选文件。
 * 桌面客户端的 stdout 不可见，排查问题时把日志落到文件最方便。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
/** 把 printf 风格参数拼成一行文本（`%s` 依次替换，`%j`/`%o` JSON 化，其余原样追加）。 */
function formatLine(format, args) {
    const template = typeof format === 'string' ? format : String(format);
    const stringify = (value) => {
        if (typeof value === 'string')
            return value;
        try {
            return JSON.stringify(value) ?? String(value);
        }
        catch {
            return String(value);
        }
    };
    let index = 0;
    const filled = template.replace(/%[sdifjo%]/gu, (token) => {
        if (token === '%%')
            return '%';
        if (index >= args.length)
            return token;
        const value = args[index++];
        if (token === '%j' || token === '%o')
            return stringify(value);
        return typeof value === 'string' ? value : String(value);
    });
    const rest = args.slice(index).map(stringify);
    return rest.length === 0 ? filled : `${filled} ${rest.join(' ')}`;
}
/**
 * 创建同时写文件的日志器。
 * @param base - dsh 的日志服务。
 * @param logPath - 日志文件路径；为空时原样返回 `base`。
 * @returns 带时间戳与级别前缀的日志器。
 */
export function createTeeLogger(base, logPath) {
    const target = logPath?.trim();
    if (target === undefined || target === '')
        return base;
    try {
        mkdirSync(dirname(target), { recursive: true });
    }
    catch {
        return base;
    }
    const write = (level, format, args) => {
        const line = `${new Date().toISOString()} [${level}] ${formatLine(format, args)}\n`;
        try {
            appendFileSync(target, line, 'utf8');
        }
        catch {
            // 写文件失败不影响插件运行。
        }
    };
    return {
        debug(format, ...args) {
            write('debug', format, args);
            base.debug?.(format, ...args);
        },
        info(format, ...args) {
            write('info', format, args);
            base.info(format, ...args);
        },
        warn(format, ...args) {
            write('warn', format, args);
            base.warn(format, ...args);
        },
        error(format, ...args) {
            write('error', format, args);
            base.error(format, ...args);
        },
    };
}
