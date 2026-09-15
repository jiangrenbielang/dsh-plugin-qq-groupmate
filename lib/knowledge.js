/**
 * 知识库：从 knowledge/ 目录加载 Markdown 知识文档，按关键词命中检索。
 * 群友消息命中某条知识时，只把相关条目注入提示词，不占常驻上下文。
 * 文档格式：`## 标题` 分节，节内 `### 小节` 为条目；标题行即关键词来源。
 *
 * ⚠️ 默认关闭（`knowledge.enabled`，见 resolveKnowledgeSettings）。2026-09-11 事故：
 * 仓库自带的 FAQ 写的是**别的项目**（RP-Hub / QQ Agent）的报错，群里聊别的服务时
 * 消息里的「ui」命中了「八、UI 模板 / 变量」整节，机器人把别人的文档当群内事实讲，
 * 被管理员当成造谣关停。要用请先换成自己社群的内容。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
/**
 * 解析知识库设置：目录优先级 `knowledge.dir` → 旧 `knowledgeDir` → `<数据目录>/knowledge`；
 * 开关只看 `knowledge.enabled`，**默认关闭**。
 * @param config - 插件配置（只读这两个字段）。
 * @param dataDir - 数据目录（用于拼默认路径）。
 * @returns 是否启用 + 生效目录。
 */
export function resolveKnowledgeSettings(config, dataDir) {
    const dir = config.knowledge?.dir?.trim() || config.knowledgeDir?.trim() || `${dataDir}/knowledge`;
    return { enabled: config.knowledge?.enabled === true, dir };
}
/** 知识库：加载 + 检索。 */
export class KnowledgeBase {
    logger;
    dir;
    entries = [];
    constructor(dir, logger) {
        this.dir = dir;
        this.logger = logger;
        this.reload();
    }
    /** 重新扫描目录（改知识文档后调用；配置重建时也会重建实例）。 */
    reload() {
        this.entries = loadKnowledgeDir(this.dir, this.logger);
    }
    /** 已加载条目数。 */
    get size() {
        return this.entries.length;
    }
    /**
     * 按关键词检索：返回命中的条目（最多 limit 条，按得分排序）。
     * 计分：强关键词 2 分、弱关键词（2 字窗口）1 分，**总分 ≥2 才算命中**——
     * 单个 2 字窗口太容易误命中（「不出」「ui」这类），不足以把一条知识塞进提示词。
     */
    search(text, limit = 3) {
        const query = String(text || '').toLowerCase();
        if (query === '')
            return [];
        const scored = [];
        for (const entry of this.entries) {
            let score = 0;
            for (const keyword of entry.keywords) {
                if (query.includes(keyword))
                    score += 2;
            }
            if (score < 2) {
                for (const hint of entry.hints) {
                    if (query.includes(hint))
                        score += 1;
                }
            }
            if (score >= 2)
                scored.push({ entry, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, Math.max(1, limit)).map(item => item.entry);
    }
}
/** 把标题拆成检索词。返回强/弱两组：完整词进强组，中文 2 字窗口进弱组。 */
function splitKeywords(title) {
    const cleaned = title
        .replace(/^#+\s*/u, '')
        .replace(/^\d+(\.\d+)*[\.、\s]+/u, '')
        .replace(/[「」『』【】\[\]（）()：:，,。.!！?？/\\|`*_~#]/gu, ' ')
        .trim();
    const parts = cleaned.split(/\s+/u).filter(part => part.length >= 2);
    const strong = [];
    const weak = [];
    for (const part of parts) {
        const lowered = part.toLowerCase();
        // 纯拉丁/数字的短词（ui、ai、api 这种两三个字母）太容易误命中，直接不要。
        if (/^[a-z0-9._-]+$/u.test(lowered) && lowered.length < 3)
            continue;
        strong.push(lowered);
        // 中文长标题按 2 字窗口再切一次，提高命中率（如「生图失败」→「生图」「图失」「失败」）。
        // 只留**含中文**的窗口：纯拉丁窗口（「八、UI」里的 `ui`）是 2026-09-11 事故的直接扳机。
        if (/[\u4e00-\u9fff]/u.test(part) && part.length >= 4) {
            for (let i = 0; i + 2 <= lowered.length; i += 1) {
                const window = lowered.slice(i, i + 2);
                if (!/[\u4e00-\u9fff]/u.test(window))
                    continue;
                if (!strong.includes(window) && !weak.includes(window))
                    weak.push(window);
            }
        }
    }
    return { strong, weak };
}
/** 解析一份 Markdown 知识文档。 */
function parseKnowledgeDoc(filePath, source) {
    const text = readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/u);
    const entries = [];
    let sectionTitle = '';
    let currentTitle = '';
    let currentBody = [];
    let explicitKeywords = [];
    const flush = () => {
        const body = currentBody.join('\n').trim();
        if (currentTitle !== '' && body !== '') {
            const split = splitKeywords(currentTitle);
            entries.push({
                source,
                title: currentTitle,
                content: body,
                keywords: [...split.strong, ...explicitKeywords],
                hints: split.weak,
            });
        }
        currentBody = [];
        explicitKeywords = [];
    };
    for (const line of lines) {
        const heading = /^(#{2,3})\s+(.+)$/u.exec(line);
        if (heading !== null) {
            flush();
            const level = heading[1].length;
            const title = heading[2].trim();
            if (level === 2) {
                sectionTitle = title;
                currentTitle = title;
            }
            else {
                currentTitle = sectionTitle === '' ? title : `${sectionTitle}｜${title}`;
            }
            continue;
        }
        const keywordLine = /^关键词[:：]\s*(.+)$/u.exec(line);
        if (keywordLine !== null) {
            // 检索时 query 会整体小写，关键词也必须小写，否则含大写的词永远匹配不上。
            explicitKeywords = keywordLine[1].split(/[,，、\s]+/u).map(k => k.trim().toLowerCase()).filter(k => k !== '');
            continue;
        }
        currentBody.push(line);
    }
    flush();
    return entries;
}
/** 扫描 knowledge 目录下所有 .md 文件。 */
function loadKnowledgeDir(dir, logger) {
    if (!existsSync(dir))
        return [];
    let files;
    try {
        files = readdirSync(dir).filter(name => name.toLowerCase().endsWith('.md')).sort();
    }
    catch (error) {
        logger.warn('qq-groupmate: 读取知识库目录失败：%s', String(error));
        return [];
    }
    const entries = [];
    for (const file of files) {
        try {
            entries.push(...parseKnowledgeDoc(join(dir, file), file.replace(/\.md$/iu, '')));
        }
        catch (error) {
            logger.warn('qq-groupmate: 解析知识文档 %s 失败：%s', file, String(error));
        }
    }
    return entries;
}
