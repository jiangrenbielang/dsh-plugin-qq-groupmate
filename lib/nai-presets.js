/**
 * 生图画风预设：V4.5 预设与 V5 画风分开管理，互不覆盖。
 *
 * 移植自大佬的 AstrBot 插件 astrbot_plugin_nai2api（v1.1.0）：
 *   - V4.5 预设：内置 Nai2API 前端 app.js 里的 artistPresets（2.5D唯美风等）
 *     + 用户自定义，存 presets.json
 *   - V5 画风：按模型隔离的另一套，内置画风只有名字和描述、画师串留空待填
 *     （作者的分发包不带 v5_presets.json，画师串是个人数据），
 *     用户自定义存 v5_custom_presets.json
 *
 * 「画师串」就是 NovelAI 的质量前缀 / artist prompt，拼在提示词前面。
 * V5 模型只认自己的画风，V4.5 只认自己的预设——混用会画出错误的画。
 */
import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from "./store.js";
/** V4.5 模型 id（1 点/张，不限量）。 */
export const V4_MODEL = 'nai-diffusion-4-5-full';
/** V5 模型 id（5 点/张，默认每 24 小时限 4 张）。 */
export const V5_MODEL = 'nai-diffusion-5-full';
/**
 * 单独画师预设（用户从画师库 nai-artists.vercel.app 挑的 15 位）。
 *
 * 为什么两套表共用同一份：这些是**裸画师名**，不带 `-2::`、`{}` 这类
 * 模型专属权重写法，V4.5 与 V5 都认。所以不做版本区分——不管群友当前在哪个模型下，
 * `-p aka_kan` 都能用上。
 *
 * 每一条都带一段通用质量词：找到预设时画师串会**替换**掉全局默认画师串
 * （见 outbound.ts 的 resolveOverrides），只写裸名字会把质量词一起丢掉、出图会明显变差。
 * 格式跟内置的「GalGame风」一致（质量词 + `artist:` 前缀），`artist:` 是 NAI 里
 * 显式指向画师嵌入的写法，比裸名字更不容易被当成角色或普通标签。
 *
 * 必须声明在两张表之前（`const` 有暂时性死区，下面的 spread 会先读到它）。
 * 新增名字前先去画师库（`artist_data.json`，708 位）核对拼写，别有手误。
 */
const ARTIST_PRESETS = {
    aka_kan: { artist: 'masterpiece, best quality, very aesthetic, absurdres, artist:aka_kan', desc: '画师预设' },
    akakura: { artist: 'masterpiece, best quality, very aesthetic, absurdres, artist:akakura', desc: '画师预设' },
    'alphonse_(white_datura)': { artist: 'masterpiece, best quality, very aesthetic, absurdres, artist:alphonse_(white_datura)', desc: '画师预设' },
    amashiro_natsuki: { artist: 'masterpiece, best quality, very aesthetic, absurdres, artist:amashiro_natsuki', desc: '画师预设' },
    ameto_yuki: { artist: 'masterpiece, best quality, very aesthetic, absurdres, artist:ameto_yuki', desc: '画师预设' },
    'bae.c': { artist: 'masterpiece, best quality, very aesthetic, absurdres, artist:bae.c', desc: '画师预设' },
    chen_bin: { artist: 'masterpiece, best quality, very aesthetic, absurdres, artist:chen_bin', desc: '画师预设' },
    deyui: { artist: 'masterpiece, best quality, very aesthetic, absurdres, artist:deyui', desc: '画师预设' },
    'eip_(pepai)': { artist: 'masterpiece, best quality, very aesthetic, absurdres, artist:eip_(pepai)', desc: '画师预设' },
    'himitsu_(hi_mi_tsu_2)': { artist: 'masterpiece, best quality, very aesthetic, absurdres, artist:himitsu_(hi_mi_tsu_2)', desc: '画师预设' },
    kedama_milk: { artist: 'masterpiece, best quality, very aesthetic, absurdres, artist:kedama_milk', desc: '画师预设' },
    kobuichi: { artist: 'masterpiece, best quality, very aesthetic, absurdres, artist:kobuichi', desc: '画师预设' },
    'maccha_(mochancc)': { artist: 'masterpiece, best quality, very aesthetic, absurdres, artist:maccha_(mochancc)', desc: '画师预设' },
    misyune: { artist: 'masterpiece, best quality, very aesthetic, absurdres, artist:misyune', desc: '画师预设' },
    modare: { artist: 'masterpiece, best quality, very aesthetic, absurdres, artist:modare', desc: '画师预设' },
};
/**
 * V4.5 内置预设（取自 Nai2API 前端 app.js 的 artistPresets，与作者插件同源）。
 * 这些是公开的服务端默认值，不是个人数据。
 */
export const BUILTIN_V4_PRESETS = {
    '韩漫小清新风': {
        artist: 'masterpiece, best quality,[[[artist:dishwasher1910]]], {{yd_(orange_maru)}}, [artist:ciloranko], [artist:sho_(sho_lwlw)], [ningen mame], soft lighting,year 2024',
        desc: '韩漫小清新风格',
    },
    '动漫同人风': {
        artist: 'masterpiece, best quality, very aesthetic, modern Japanese anime, official anime art, anime key visual, anime screencap, soft cel shading, soft anime coloring, smooth color transitions, natural skin tones, restrained color palette, slightly desaturated, muted colors, soft ambient lighting, gentle contrast, subtle gradients, subtle bloom, detailed anime background',
        desc: '动画截图质感的同人风',
    },
    '2.5D唯美风': {
        artist: "0.9::misaka_12003-gou ::, dino_(dinoartforame), wanke, liduke, year 2025, realistic, 4k, -2::green ::, textless version, The image is highly intricate finished drawn. Only the character's face is in anime style, but their body is in realistic style. 1.35::A highly finished photo-style artwork that has lively color, graphic texture, realistic skin surface, and lifelike flesh with little obliques::. 1.63::photorealistic::, 1.63::photo(medium)::, \\n20::best quality, absurdres, very aesthetic, detailed, masterpiece::,, very aesthetic, masterpiece, no text,",
        desc: '2.5D 半写实唯美风（Nai2API 默认）',
    },
    '2.5D唯美风（萝）': {
        artist: '20::best quality, absurdres, very aesthetic, detailed, masterpiece::, 20::highly finished::, 10::ultra detailed::, 5::masterpiece::, 5::best quality::, 2.4::kidmo::, 1.2::omone hokoma agm::, 1.1::dino, wanke, liduke::, 0.8::rurudo, mignon, artist:pottsness, artist:toosaka asagi::, 0.7::misaka_12003-gou::, 0.6::artist:chocoan, artist:ciloranko, artist:rhasta, artist:sho_sho_lwlw::, dino_(dinoartforame), agoto, akakura, 0.9::rurudo(Only body shape), mignon(Only body shape) :: year 2025, textless version, {{petite,loli}}, Petite figure, no text, The image is highly intricate finished drawn. Only the character\'s face is in anime style, but their body is in realistic style. 1.35::A highly finished photo-style artwork that has graphic texture, realistic skin surface, and lifelike flesh with little obliques::, smooth line, glossy skin, realistic, 4k, 1.63::photorealistic::, 1.63::photo(medium)::, 3::simple background::, 2::depth of field::, 1.5::vivid color, lively color::, desaturated, muted tones, cinematic desaturation, pale aesthetic, silver-toned, -2::green::, -1.5::vibrant, colorful, saturated::',
        desc: '2.5D 唯美风的娇小体型版本',
    },
    '本子里番风': {
        artist: '1.4::asanagi::,{{{{{artist:asanagi}}}}},1.2::xiaoluo_xl::,1.3::Artist: misaka_12003-gou::,1.2::Artist:shexyo::,0.7::Artist:b.sa_(bbbs)::,1::Artist:qiandaiyiyu::,1.05::artist:natedecock::,1.05::artist:kunaboto::,0.75::artist:kandata_nijou::,1.05::artist:zer0.zer0 ::,1.05::artist:jasony::,0.75::misaka_12003-gou ::, dino_(dinoartforame), wanke, liduke, year 2025, realistic, 4k, -2::green ::, {textless version, The image is highly intricate finished drawn,write realistically,true to life}, 1.35::A highly finished photo-style artwork that has graphic texture, realistic skin surface, and lifelike flesh with little obliques::, 1.63::photorealistic::, 1.63::photo(medium)::, {{very aesthetic}}, masterpiece, no text,',
        desc: '日系本子风格，多画师混合',
    },
    'GalGame风': {
        artist: 'masterpiece, best quality, very aesthetic, [[[artist:ningen mame]]], [artist:rhasta], [artist:ciloranko], [ningen mame], [artist:sho_(sho_lwlw)], year 2024',
        desc: '游戏 CG 风格（ningen_mame 等画师）',
    },
    ...ARTIST_PRESETS,
};
/**
 * V5 内置画风（名字与描述照搬作者插件的 README，画师串留空）。
 *
 * 为什么不填画师串：作者的分发包不含 v5_presets.json（DISTRIBUTION.md 写明
 * 「不包含任何账号密钥、个人预设」），那份数据在他的 AstrBot 数据目录里。
 * 编一份假的会画出完全不对的画——宁可在设置页里让用户自己贴。
 * 留空时按 `v5FallbackArtist` 处理（见 resolveStyle）。
 */
export const BUILTIN_V5_STYLES = {
    '黑白中的色彩': { artist: '', desc: '黑白水墨与赛璐璐肖像，仅保留彩色头发和眼睛' },
    '2.5油油风': { artist: '', desc: '高完成度 2.5D 油润写实人物' },
    '高质量写实风': { artist: '', desc: '柔和通透的半写实电影氛围' },
    '游戏风': { artist: '', desc: '游戏 CG 的 3D 赛璐珞渲染风' },
    '宝石成了赝品，你的眼睛才是真迹': { artist: '', desc: '电影级半身构图、戏剧光影与宝石般眼神' },
    '绝区零游戏风': { artist: '', desc: '低饱和 3D 赛璐珞角色渲染、雾化光影与动态模糊' },
    '梦幻炫彩是爱的魔法色': { artist: '', desc: '高饱和虹彩、彩色粒子与电影颗粒的梦幻视觉效果' },
    // 单独画师预设两套表共用（见 ARTIST_PRESETS 的说明）。
    ...ARTIST_PRESETS,
};
/** 一份能直接用的 V5 兜底画师串（用户没填自定义时用，避免空串导致模型报错）。 */
export const DEFAULT_V5_ARTIST = 'masterpiece, best quality, very aesthetic, absurdres, highly detailed';
/**
 * 把设置页填的画师串覆盖到预设表上。
 * 只覆盖库里有、并且值非空的名字——写错名字不该凭空造出一个画风来。
 * @param presets - 已经合并好的预设表（原地改）。
 * @param overrides - `画风名 → 画师串`。
 */
function applyArtistOverrides(presets, overrides) {
    for (const [name, artist] of Object.entries(overrides ?? {})) {
        const value = artist.trim();
        const current = presets[name];
        if (value === '' || current === undefined)
            continue;
        presets[name] = { artist: value, desc: current.desc };
    }
    return presets;
}
/**
 * 画风预设库：内置 + 自定义，V4.5 与 V5 分开存取。
 * 自定义预设落盘（presets.json / v5_custom_presets.json），与作者插件同名，
 * 方便从 AstrBot 那边把文件直接拷过来。
 */
export class PresetStore {
    settings;
    logger;
    v4 = {};
    v5 = {};
    constructor(settings, logger) {
        this.settings = settings;
        this.logger = logger;
        this.v4 = this.load('presets.json');
        this.v5 = this.load('v5_custom_presets.json');
        if (Object.keys(this.v4).length > 0 || Object.keys(this.v5).length > 0) {
            this.logger.info('qq-groupmate: 已加载生图自定义预设（V4.5 %s 个、V5 %s 个）', String(Object.keys(this.v4).length), String(Object.keys(this.v5).length));
        }
    }
    /** 列出某个模型可用的全部画风（内置 + 自定义 + 设置页的覆盖）。 */
    list(model) {
        const merged = model === V5_MODEL
            ? this.listV5()
            : { ...BUILTIN_V4_PRESETS, ...this.v4 };
        return applyArtistOverrides(merged, this.settings.presetArtists);
    }
    /**
     * 给设置页/日志看的一份画风清单：名字、说明、内置与否、有没有画师串。
     * 不带整段画师串（有的上千字），给个开头当预览——卡片里真正的值从设置文档读。
     */
    describe(model) {
        const overrides = this.settings.presetArtists ?? {};
        return Object.entries(this.list(model)).map(([name, preset]) => {
            const artist = preset.artist.trim();
            return {
                name,
                desc: preset.desc,
                builtin: this.isBuiltin(model, name),
                overridden: (overrides[name] ?? '').trim() !== '',
                filled: artist !== '',
                preview: artist.slice(0, 40),
            };
        });
    }
    /** 设置页有没有给这个名字填覆盖画师串。 */
    hasArtistOverride(name) {
        return ((this.settings.presetArtists ?? {})[name] ?? '').trim() !== '';
    }
    /** 覆盖表里那些库里没有的名字（Host 启动时提示用户，免得白填）。 */
    unknownArtistOverrides() {
        const known = new Set([
            ...Object.keys(BUILTIN_V4_PRESETS),
            ...Object.keys(BUILTIN_V5_STYLES),
            ...Object.keys(this.v4),
            ...Object.keys(this.v5),
        ]);
        return Object.keys(this.settings.presetArtists ?? {}).filter(name => !known.has(name));
    }
    listV5() {
        const merged = { ...BUILTIN_V5_STYLES };
        for (const [name, preset] of Object.entries(this.v5)) {
            // 内置画风的画师串留空：自定义同名项只补画师串，不顶掉官方描述。
            const builtin = merged[name];
            merged[name] = builtin !== undefined && builtin.artist === ''
                ? { artist: preset.artist, desc: builtin.desc }
                : preset;
        }
        return merged;
    }
    /** 名字在这个模型下存不存在。 */
    has(model, name) {
        return this.list(model)[name] !== undefined;
    }
    /** 是不是内置项（内置不可删改）。 */
    isBuiltin(model, name) {
        return model === V5_MODEL ? BUILTIN_V5_STYLES[name] !== undefined : BUILTIN_V4_PRESETS[name] !== undefined;
    }
    /**
     * 解析一个画风名到实际画师串。
     * V5 内置画风没填画师串时退回兜底串（设置页可改），保证请求不空转。
     */
    resolve(model, name) {
        if (name === '')
            return { artist: '', builtin: false, found: false };
        const preset = this.list(model)[name];
        if (preset === undefined)
            return { artist: '', builtin: false, found: false };
        const builtin = this.isBuiltin(model, name);
        if (preset.artist.trim() !== '')
            return { artist: preset.artist, builtin, found: true };
        const fallback = this.settings.v5FallbackArtist.trim();
        return { artist: fallback === '' ? DEFAULT_V5_ARTIST : fallback, builtin, found: true };
    }
    /**
     * 保存自定义画风（同名覆盖；内置名会被调用方拦下）。
     * @returns 之前是否已存在（用来区分「已保存」和「已更新」）。
     */
    save(model, name, artist, desc = '') {
        const table = model === V5_MODEL ? this.v5 : this.v4;
        const existed = table[name] !== undefined;
        table[name] = {
            artist: artist.trim(),
            desc: desc.trim() === '' ? (model === V5_MODEL ? '自定义 V5 画师串' : '自定义预设') : desc.trim(),
        };
        this.persist(model);
        this.logger.info('qq-groupmate: 已%s生图预设「%s」（%s）', existed ? '更新' : '保存', name, model === V5_MODEL ? 'V5' : 'V4.5');
        return existed;
    }
    /** 改自定义预设的画师串；内置或不存在返回 false。 */
    update(model, name, artist) {
        const table = model === V5_MODEL ? this.v5 : this.v4;
        if (table[name] === undefined || this.isBuiltin(model, name))
            return false;
        table[name] = { ...table[name], artist: artist.trim() };
        this.persist(model);
        return true;
    }
    /** 删自定义预设；内置或不存在返回 false。 */
    remove(model, name) {
        const table = model === V5_MODEL ? this.v5 : this.v4;
        if (table[name] === undefined || this.isBuiltin(model, name))
            return false;
        delete table[name];
        this.persist(model);
        return true;
    }
    /** 渲染一份画风列表文本（给聊天里看）。 */
    render(model, onlyName = '') {
        const label = model === V5_MODEL ? 'V5 画风' : 'V4.5 预设';
        const all = this.list(model);
        if (onlyName !== '') {
            const preset = all[onlyName];
            if (preset === undefined)
                return `${label}「${onlyName}」不存在。发「V5画风」看 V5 列表。`;
            const builtinTag = this.isBuiltin(model, onlyName) ? '内置' : '自定义';
            const fromPanel = this.hasArtistOverride(onlyName) ? '（来自设置页「画风预设」）' : '';
            const artist = preset.artist.trim() === ''
                ? '（画师串还没填：管理员在设置页「生图 → 画风预设」里贴一条，或用「.存画风 <名字> <画师串>」）'
                : `${fromPanel}${preset.artist}`;
            return `${label}「${onlyName}」[${builtinTag}]\n${preset.desc}\n画师串：\n${artist}`;
        }
        const entries = Object.entries(all);
        if (entries.length === 0)
            return `${label}列表是空的。`;
        const lines = entries.map(([name, preset], index) => {
            const builtinTag = this.isBuiltin(model, name) ? ' [内置]' : '';
            const missing = preset.artist.trim() === '' ? '（待填画师串）' : '';
            return `${String(index + 1)}. ${name}${builtinTag} - ${preset.desc}${missing}`;
        });
        const tail = model === V5_MODEL
            ? ['', `用法：用V5画一张 <描述> -p <画风名>；群友也可以直接说「<画风名>，画个xxx」。`]
            : ['', `用法：-p <预设名> 加在生图标签末尾，例如 [生图:1girl, silver hair -p GalGame风]。`];
        return [`${label}（共 ${String(entries.length)} 个）：`, ...lines, ...tail].join('\n');
    }
    pathOf(file) {
        return join(this.settings.dir, file);
    }
    load(file) {
        const path = this.pathOf(file);
        const raw = readJsonFile(path);
        if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
            // 文件不存在是常态（还没存过自定义预设），不吵。
            return {};
        }
        const out = {};
        for (const [name, value] of Object.entries(raw)) {
            if (name.trim() === '' || value === null || typeof value !== 'object')
                continue;
            const record = value;
            const artist = typeof record.artist === 'string' ? record.artist.trim() : '';
            if (artist === '')
                continue;
            out[name] = {
                artist,
                desc: typeof record.desc === 'string' && record.desc.trim() !== ''
                    ? record.desc.trim()
                    : (file === 'v5_custom_presets.json' ? '自定义 V5 画师串' : '自定义预设'),
            };
        }
        return out;
    }
    persist(model) {
        const file = model === V5_MODEL ? 'v5_custom_presets.json' : 'presets.json';
        const table = model === V5_MODEL ? this.v5 : this.v4;
        try {
            writeJsonFile(this.pathOf(file), table);
        }
        catch (error) {
            this.logger.warn('qq-groupmate: 生图预设落盘失败（%s）：%s', this.pathOf(file), String(error));
        }
    }
}
/** 尺寸前缀：写在标签最前面。 */
const SIZE_PREFIX = /^(2K竖图|2K横图|2K方图|4K竖图|4K横图|4K方图|竖图|横图|方图)\s+/iu;
/** `-p 名字` / `--preset 名字`。 */
const PRESET_ARG = /(?:-p|--preset)\s+(\S+)/iu;
/** `--artist ...`（吃到下一个参数或结尾）。 */
const ARTIST_ARG = /--artist\s+(.+?)(?=\s+(?:--negative|-p|--preset|--seed)\s+|$)/isu;
/** `--negative ...`。 */
const NEGATIVE_ARG = /--negative\s+(.+?)(?=\s+(?:--artist|-p|--preset|--seed)\s+|$)/isu;
/** `--seed 数字`。 */
const SEED_ARG = /--seed\s+(\d+)/iu;
const VALID_SIZES = [
    '竖图', '横图', '方图',
    '2K竖图', '2K横图', '2K方图',
    '4K竖图', '4K横图', '4K方图',
];
/** 尺寸是否合法（给配置解析用）。 */
export function isValidSize(size) {
    return VALID_SIZES.includes(size);
}
/** 全部可用尺寸（设置页下拉与提示词用）。 */
export const ALL_SIZES = [...VALID_SIZES];
/**
 * 解析一个生图标签里的参数，把纯标签和选项分开。
 * @param raw - 模型给的标签，例如 `1girl, silver hair -p GalGame风 --seed 42`。
 */
export function parseTagOptions(raw) {
    let text = raw.trim();
    const result = { tag: '' };
    const sizeMatch = SIZE_PREFIX.exec(text);
    if (sizeMatch !== null) {
        const size = sizeMatch[1];
        if (size !== undefined)
            result.size = size;
        text = text.slice(sizeMatch[0].length);
    }
    const presetMatch = PRESET_ARG.exec(text);
    if (presetMatch !== null) {
        const name = presetMatch[1];
        if (name !== undefined)
            result.preset = name;
        text = text.slice(0, presetMatch.index) + text.slice(presetMatch.index + presetMatch[0].length);
    }
    const seedMatch = SEED_ARG.exec(text);
    if (seedMatch !== null) {
        const parsed = Number(seedMatch[1]);
        if (Number.isFinite(parsed))
            result.seed = Math.floor(parsed);
        text = text.slice(0, seedMatch.index) + text.slice(seedMatch.index + seedMatch[0].length);
    }
    const negativeMatch = NEGATIVE_ARG.exec(text);
    if (negativeMatch !== null) {
        const value = negativeMatch[1]?.trim();
        if (value !== undefined && value !== '')
            result.negative = value;
        text = text.slice(0, negativeMatch.index) + text.slice(negativeMatch.index + negativeMatch[0].length);
    }
    const artistMatch = ARTIST_ARG.exec(text);
    if (artistMatch !== null) {
        const value = artistMatch[1]?.trim();
        if (value !== undefined && value !== '')
            result.artist = value;
        text = text.slice(0, artistMatch.index) + text.slice(artistMatch.index + artistMatch[0].length);
    }
    result.tag = text.replace(/\s+/gu, ' ').replace(/\s*,\s*/gu, ', ').replace(/^[,\s]+|[,\s]+$/gu, '').trim();
    return result;
}
