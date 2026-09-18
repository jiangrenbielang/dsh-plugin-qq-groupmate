/**
 * 原声台词库：把本机的角色原声接进群聊。
 *
 * 素材来源：本机的原声素材（自己导出的游戏配音、社区补音包等）
 * 一句台词一个音频文件，配一份关键词 → 文件 + 原文 + 情绪的索引。
 * 每条台词都有 line_id、情绪标签和音频文件，索引放在
 * `<数据目录>/native-voice/index.json`（关键词 → 文件 + 原文 + 情绪）。
 *
 * 两个用途：
 *   ① 原声快捷回复：模型输出 `[原声:关键词]` 时直接把那条原声发进群，
 *      群友听到的是她本人的声音，而不是当场合成的；
 *   ② 情绪参考音：按台词的情绪标签挑几段，给本地 TTS 当辅助参考音。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/** 原声库。 */
export class NativeVoiceLibrary {
    dir;
    logger;
    lines = new Map();
    constructor(dataDir, logger) {
        this.dir = join(dataDir, 'native-voice');
        this.logger = logger;
        this.reload();
    }
    /** 读索引（缺文件、坏 JSON 都只记日志，不影响聊天）。 */
    reload() {
        this.lines.clear();
        const indexFile = join(this.dir, 'index.json');
        if (!existsSync(indexFile))
            return;
        try {
            const parsed = JSON.parse(readFileSync(indexFile, 'utf8'));
            for (const [keyword, entry] of Object.entries(parsed.lines ?? {})) {
                const file = String(entry?.file ?? '');
                if (file === '')
                    continue;
                const path = join(this.dir, file);
                if (!existsSync(path))
                    continue;
                this.lines.set(keyword, {
                    keyword,
                    path,
                    file,
                    text: String(entry?.text ?? ''),
                    style: String(entry?.style ?? 'calm'),
                });
            }
        }
        catch (error) {
            this.logger?.warn('qq-groupmate: 原声索引解析失败（%s）：%s', indexFile, String(error));
        }
    }
    get available() {
        return this.lines.size > 0;
    }
    /** 全部关键词（提示词里列给模型看）。 */
    keywords() {
        return [...this.lines.keys()];
    }
    /**
     * 按关键词取一条原声。模型可能写成「原声: 我 在」或带标点，所以先精确、再宽松匹配。
     * @returns 命中的条目；没有就返回 `undefined`。
     */
    find(keyword) {
        const key = String(keyword ?? '').trim();
        if (key === '')
            return undefined;
        const direct = this.lines.get(key);
        if (direct !== undefined)
            return direct;
        const norm = key.replace(/[\s，。！？、：；「」【】"'`·]/gu, '');
        if (norm === '')
            return undefined;
        for (const [name, entry] of this.lines) {
            if (name === norm || name.includes(norm) || norm.includes(name))
                return entry;
        }
        return undefined;
    }
    /** 某个情绪下可用的原声片段（给 TTS 当辅助参考音）；calm 不额外加，保持现状。 */
    refsFor(style, max = 2) {
        if (style === 'calm')
            return [];
        return [...this.lines.values()]
            .filter(entry => entry.style === style)
            .slice(0, Math.max(0, max))
            .map(entry => entry.path);
    }
    /** 提示词里用的关键词清单。 */
    describe(limit = 70) {
        return this.keywords().slice(0, Math.max(1, limit)).join('、');
    }
}
