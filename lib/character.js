/**
 * 角色卡：从目录加载 JSON 角色卡，支持原生格式与 SillyTavern V2 角色卡。
 * 每个角色卡可以覆盖模型、温度、触发规则，实现"独立模型切换"。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const CARD_EXTENSIONS = ['.json'];
function asString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
function asStringArray(value) {
    if (Array.isArray(value))
        return value.filter((item) => typeof item === 'string' && item.trim() !== '');
    const single = asString(value);
    return single === undefined ? [] : [single];
}
function asNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
/** 把 SillyTavern V2 角色卡的 `data` 段翻译成本插件的字段。 */
function fromSillyTavern(data, id) {
    const name = asString(data.name) ?? id;
    const parts = [];
    const description = asString(data.description);
    const personality = asString(data.personality);
    if (description !== undefined)
        parts.push(description);
    // ST 的 mes_example 用 <START> 分隔多段示例对话，整段塞进去会把分隔符带给模型。
    const mesExample = asString(data.mes_example);
    return {
        id,
        name,
        aliases: [],
        persona: parts.join('\n') || `你是「${name}」。`,
        personality,
        background: asString(data.scenario),
        speakingStyle: undefined,
        scenario: asString(data.scenario),
        greeting: asString(data.first_mes),
        exampleDialogues: mesExample === undefined
            ? []
            : mesExample.split(/<START>/iu).map(section => section.trim()).filter(section => section !== ''),
        extraPrompt: [asString(data.system_prompt), asString(data.post_history_instructions)]
            .filter((item) => item !== undefined)
            .join('\n\n') || undefined,
    };
}
/**
 * 解析一张角色卡；识别原生格式与 SillyTavern V2 格式。
 * @param raw - 已解析的 JSON 值。
 * @param id - 卡片 id（文件名）。
 * @returns 规范化后的角色卡，缺少必要字段时返回 `undefined`。
 */
export function parseCharacterCard(raw, id) {
    const root = asRecord(raw);
    if (root === undefined)
        return undefined;
    // SillyTavern V2：{ spec: 'chara_card_v2', data: {...} }
    const spec = asString(root.spec);
    const data = asRecord(root.data);
    if (data !== undefined && (spec?.startsWith('chara_card') === true || asString(data.name) !== undefined && asString(root.name) === undefined)) {
        return fromSillyTavern(data, id);
    }
    const name = asString(root.name) ?? id;
    const persona = asString(root.persona) ?? asString(root.description);
    if (persona === undefined)
        return undefined;
    const trigger = asRecord(root.trigger);
    const triggerCard = trigger === undefined ? undefined : {
        prefixes: asStringArray(trigger.prefixes),
        randomChance: asNumber(trigger.randomChance),
        mention: typeof trigger.mention === 'boolean' ? trigger.mention : undefined,
    };
    return {
        id,
        name,
        aliases: asStringArray(root.aliases),
        persona,
        personality: asString(root.personality),
        background: asString(root.background),
        speakingStyle: asString(root.speakingStyle),
        scenario: asString(root.scenario),
        greeting: asString(root.greeting) ?? asString(root.first_mes),
        exampleDialogues: asStringArray(root.exampleDialogues ?? root.mes_example),
        extraPrompt: asString(root.extraPrompt),
        adminTag: asString(root.adminTag),
        provider: asString(root.provider),
        model: asString(root.model),
        temperature: asNumber(root.temperature),
        maxTokens: asNumber(root.maxTokens),
        trigger: triggerCard,
    };
}
/**
 * 读取角色卡目录下的全部 JSON 角色卡。
 * @param dir - 角色卡目录。
 * @returns 以 id 为键的角色卡表（按文件名排序）。
 */
export function loadCharacterCards(dir, logger) {
    const cards = new Map();
    if (!existsSync(dir))
        return cards;
    let entries;
    try {
        entries = readdirSync(dir).filter(name => CARD_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext)));
    }
    catch {
        return cards;
    }
    entries.sort();
    for (const file of entries) {
        const id = file.replace(/\.json$/iu, '');
        try {
            const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
            const card = parseCharacterCard(parsed, id);
            if (card !== undefined)
                cards.set(id, card);
            else
                logger?.warn('qq-groupmate: 角色卡「%s」缺少必填字段（name/persona），已跳过', file);
        }
        catch (error) {
            // 单张卡片损坏不影响其他卡片加载，但得让用户知道哪张坏了。
            logger?.warn('qq-groupmate: 角色卡「%s」解析失败，已跳过：%s', file, String(error));
        }
    }
    return cards;
}
