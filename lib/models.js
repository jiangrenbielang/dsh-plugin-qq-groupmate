/**
 * 模型配置：把「模型」从裸的 `provider/model` 字符串升级成**有名字的配置项**。
 *
 * 一条模型配置 = 名称 + 服务商 + 模型名（参考 RP-Hub 的服务商 / 模型选择器做法）。
 * 各处（群聊、总结、持续学习、识图、单个群）直接按名字引用，还能各配一个**备用模型**：
 * 主模型请求失败（网络 / HTTP 错误、还没出字）时自动切过去重试。
 *
 * 为了向后兼容，老的写法（`服务商id/模型名`、裸模型名）继续按原规则解析。
 */
import { splitProviderModel } from "./api-client.js";
/** `provider/model` 的可读写法，用于日志。 */
export function modelLabel(target) {
    return target.provider === '' ? target.model : `${target.provider}/${target.model}`;
}
/**
 * 创建模型解析器。
 * @param options.presets - 配置里的模型配置清单。
 * @param options.defaultModel - 兜底模型（配置里老的 provider/model 字段解析结果）。
 * @param options.isKnownProvider - 判断一个前缀是不是已注册的 provider。
 * @param options.logger - 日志器（配置有问题时给提示）。
 */
export function createModelResolver(options) {
    const presets = new Map();
    for (const item of options.presets ?? []) {
        const name = item.name?.trim() ?? '';
        const model = item.model?.trim() ?? '';
        if (name === '' || model === '') {
            if (name !== '' || model !== '')
                options.logger?.warn('qq-groupmate: 模型配置「%s」缺名称或模型名，已忽略', name || '(无名称)');
            continue;
        }
        const key = name.toLowerCase();
        if (presets.has(key)) {
            options.logger?.warn('qq-groupmate: 模型配置名「%s」重复，后面的已忽略', name);
            continue;
        }
        presets.set(key, { provider: item.provider?.trim() ?? '', model });
    }
    const lookup = (name) => presets.get(name.trim().toLowerCase());
    const fallbackOf = (fallback) => ({
        provider: fallback.provider,
        model: fallback.model,
    });
    const resolve = (ref, fallback) => {
        const text = ref?.trim() ?? '';
        if (text === '')
            return fallbackOf(fallback);
        const preset = lookup(text);
        if (preset !== undefined) {
            // 配置项没写服务商时跟随默认 provider，模型名用配置项自己的。
            return {
                provider: preset.provider === '' ? fallback.provider : preset.provider,
                model: preset.model,
            };
        }
        // 老写法：`服务商id/模型名`（前缀必须是已知 provider），否则当裸模型名。
        return splitProviderModel(fallback.provider, text, options.isKnownProvider);
    };
    return {
        names: () => [...presets.keys()],
        has: name => presets.has(name.trim().toLowerCase()),
        resolve,
        resolveSlot(slot, fallback) {
            const primary = resolve(slot?.model, fallback);
            const backupRef = slot?.backup?.trim() ?? '';
            if (backupRef === '')
                return { primary };
            const backup = resolve(backupRef, primary);
            // 备用和主用是同一个模型就没意义，直接当没配。
            if (backup.provider === primary.provider && backup.model === primary.model)
                return { primary };
            return { primary, backup };
        },
    };
}
