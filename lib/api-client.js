/**
 * 独立 API 服务商：插件自带的 HTTP 客户端，直接按 OpenAI / Anthropic 的协议发请求，
 * 不经过 dsh 里注册的 provider。适合接中转站、本地模型，或给识图 / 总结单独配一个小模型。
 *
 * 用法：在设置页「独立 API 服务商」里加一条（id + 协议 + baseUrl + apiKey），
 * 然后把模型写成 `服务商id/模型名`（例如 `myapi/gpt-4o`），或 provider 填 id、模型填模型名。
 */
/** 规范化配置：去掉没 id / 没 baseUrl 的条目，按 id 去重（先出现的生效）。 */
export function normalizeApiProviders(raw, logger) {
    const result = [];
    const seen = new Set();
    for (const item of raw ?? []) {
        const id = item.id?.trim() ?? '';
        const baseUrl = (item.baseUrl?.trim() ?? '').replace(/\/+$/u, '');
        if (id === '' || baseUrl === '') {
            if (id !== '' || baseUrl !== '')
                logger?.warn('qq-groupmate: 自定义服务商「%s」缺少 id 或 baseUrl，已忽略', id || '(无 id)');
            continue;
        }
        if (seen.has(id)) {
            logger?.warn('qq-groupmate: 自定义服务商 id「%s」重复，后面的已忽略', id);
            continue;
        }
        seen.add(id);
        const protocol = item.protocol?.trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
        result.push({
            id,
            protocol,
            baseUrl,
            apiKey: item.apiKey?.trim() ?? '',
            headers: Object.fromEntries(Object.entries(item.headers ?? {}).filter(([, value]) => typeof value === 'string')),
        });
    }
    return result;
}
/**
 * 允许把模型写成 `服务商id/模型名`：前缀命中已注册的 provider 才拆开。
 * 前缀不是已知 provider 时原样保留（OpenRouter 那种 `anthropic/claude-...` 模型名不会被误拆）。
 */
export function splitProviderModel(provider, model, isKnownProvider) {
    const slash = model.indexOf('/');
    if (slash <= 0)
        return { provider, model };
    const prefix = model.slice(0, slash);
    if (prefix === '' || !isKnownProvider(prefix))
        return { provider, model };
    return { provider: prefix, model: model.slice(slash + 1) };
}
function textOf(message) {
    return message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
}
function failureChunk(code, message) {
    return { type: 'finish', reason: { kind: 'error', failure: { code, message: message.slice(0, 500) } } };
}
/** 拆 `data:image/png;base64,xxxx`。 */
function parseDataUrl(value) {
    const match = /^data:([^;,]+);base64,(.+)$/su.exec(value);
    if (match === null)
        return undefined;
    return { mime: match[1] ?? 'image/jpeg', data: match[2] ?? '' };
}
/** Anthropic 要求角色交替、首条必须是 user：合并同角色、丢掉开头的 assistant。 */
function toAnthropicMessages(messages) {
    const result = [];
    for (const message of messages) {
        if (message.role === 'system')
            continue;
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        const text = textOf(message);
        if (text.trim() === '')
            continue;
        const last = result[result.length - 1];
        const lastText = last?.content[0];
        if (last !== undefined && lastText?.type === 'text' && last.role === role)
            lastText.text += `\n${text}`;
        else
            result.push({ role, content: [{ type: 'text', text }] });
    }
    while (result.length > 0 && result[0]?.role === 'assistant')
        result.shift();
    return result;
}
/** 逐行读取 SSE：返回 `event` 名与 `data` 内容（多行 data 用换行拼接）。 */
async function* sseEvents(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = '';
    let data = [];
    /** 只有读到流末尾才置 true；提前退出（[DONE]、provider error、重试前 break）时保持 false。 */
    let finished = false;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                finished = true;
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            let index = buffer.indexOf('\n');
            while (index >= 0) {
                const line = buffer.slice(0, index).replace(/\r$/u, '');
                buffer = buffer.slice(index + 1);
                if (line === '') {
                    if (data.length > 0)
                        yield { event, data: data.join('\n') };
                    event = '';
                    data = [];
                }
                else if (line.startsWith('event:'))
                    event = line.slice(6).trim();
                else if (line.startsWith('data:'))
                    data.push(line.slice(5).trimStart());
                index = buffer.indexOf('\n');
            }
        }
        if (data.length > 0)
            yield { event, data: data.join('\n') };
    }
    finally {
        // 正常读完只解锁；消费方提前 break / return 时生成器被关闭，必须 cancel 响应体，
        // 否则底层连接一直挂着（reader 泄漏）。
        if (finished)
            reader.releaseLock();
        else
            await reader.cancel().catch(() => { });
    }
}
/** 等待若干毫秒；外部取消时立刻结束。 */
function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
            reject(new Error('aborted'));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
/** 独立 API 服务商客户端。 */
export class ApiLlmClient {
    logger;
    providers = new Map();
    /** 网络抖动 / 5xx 的重试次数（首次之外）。 */
    retries = 2;
    constructor(providers, logger) {
        this.logger = logger;
        for (const provider of providers)
            this.providers.set(provider.id, provider);
    }
    /** 已配置的服务商 id。 */
    get ids() {
        return [...this.providers.keys()];
    }
    /** 某个 provider 名是不是本客户端负责。 */
    has(provider) {
        return this.providers.has(provider);
    }
    listProviders() {
        return [...this.providers.values()].map(provider => ({
            id: provider.id,
            name: `${provider.id}（${provider.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}）`,
        }));
    }
    stream(options) {
        const provider = this.providers.get(options.provider);
        if (provider === undefined) {
            return (async function* unknown() {
                yield failureChunk('UNKNOWN_PROVIDER', `没有配置名为「${options.provider}」的自定义服务商`);
            })();
        }
        return this.streamWithRetry(provider, options);
    }
    /**
     * 带重试的流式请求：还没吐出任何文字就撞上网络错误 / 5xx / 空响应时，
     * 退避后重试（中转站偶尔会抽一下）。已经出字了就不再重试，避免重复内容。
     */
    async *streamWithRetry(provider, options) {
        const run = provider.protocol === 'anthropic' ? this.streamAnthropic : this.streamOpenAi;
        for (let attempt = 0;; attempt += 1) {
            let emitted = false;
            let retry = false;
            for await (const chunk of run.call(this, provider, options)) {
                if (chunk.type === 'finish' && chunk.reason?.kind === 'error' && !emitted && attempt < this.retries) {
                    const code = String(chunk.reason.failure?.code ?? '');
                    if (code === 'NETWORK' || code === 'EMPTY_BODY' || /^HTTP_5\d\d$/u.test(code)) {
                        this.logger?.warn('qq-groupmate: 自定义服务商 %s 请求失败（%s），%s 毫秒后重试', provider.id, code, String(600 * (attempt + 1)));
                        retry = true;
                        break;
                    }
                }
                if (chunk.type === 'text-delta')
                    emitted = true;
                yield chunk;
            }
            if (!retry)
                return;
            try {
                await delay(600 * (attempt + 1), options.signal);
            }
            catch {
                yield failureChunk('ABORTED', '请求被取消');
                return;
            }
        }
    }
    headers(provider) {
        return {
            'content-type': 'application/json',
            ...(provider.apiKey === '' ? {} : { authorization: `Bearer ${provider.apiKey}` }),
            ...provider.headers,
        };
    }
    /**
     * 拉取服务商可用的模型列表：两种协议都提供 `GET {baseUrl}/models`。
     * OpenAI 兼容返回 `{ data: [{ id }] }`；Anthropic 返回 `{ data: [{ id, display_name }] }`。
     * @param provider - 自定义服务商 id。
     * @returns 模型 id 与可读名（name 可能缺省）；请求失败时抛错。
     */
    async listModels(provider) {
        const config = this.providers.get(provider);
        if (config === undefined)
            throw new Error(`没有配置名为「${provider}」的自定义服务商`);
        const headers = config.protocol === 'anthropic'
            ? { 'anthropic-version': '2023-06-01', ...this.headers(config) }
            : this.headers(config);
        const response = await fetch(`${config.baseUrl}/models`, { headers, signal: AbortSignal.timeout(20000) });
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`HTTP ${String(response.status)}${detail === '' ? '' : `：${detail.slice(0, 160)}`}`);
        }
        const body = await response.json().catch(() => undefined);
        const rows = Array.isArray(body?.data) ? body.data : [];
        const models = [];
        for (const row of rows) {
            const item = row;
            const id = typeof item.id === 'string' ? item.id.trim() : '';
            if (id === '')
                continue;
            const label = typeof item.display_name === 'string' && item.display_name !== ''
                ? item.display_name
                : (typeof item.name === 'string' && item.name !== '' ? item.name : undefined);
            models.push(label === undefined ? { id } : { id, name: label });
        }
        return models;
    }
    /** OpenAI 兼容：POST {baseUrl}/chat/completions，SSE 取 choices[0].delta.content。 */
    async *streamOpenAi(provider, options) {
        const chatMessages = [
            ...(options.system === undefined || options.system === ''
                ? []
                : [{ role: 'system', content: options.system }]),
            ...options.messages.map(message => ({
                role: message.role === 'assistant' ? 'assistant' : 'user',
                content: textOf(message),
            })),
        ];
        // 图片挂到最后一条用户消息上（OpenAI 的多段内容格式）。
        if (options.images !== undefined && options.images.length > 0) {
            for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
                const message = chatMessages[index];
                if (message?.role !== 'user')
                    continue;
                message.content = [
                    { type: 'text', text: String(message.content) },
                    ...options.images.map(url => ({ type: 'image_url', image_url: { url } })),
                ];
                break;
            }
        }
        const payload = {
            model: options.model,
            stream: true,
            messages: chatMessages,
            ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
            ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
        };
        let response;
        try {
            response = await fetch(`${provider.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: this.headers(provider),
                body: JSON.stringify(payload),
                signal: options.signal,
            });
        }
        catch (error) {
            yield failureChunk('NETWORK', String(error));
            return;
        }
        if (!response.ok) {
            yield failureChunk(`HTTP_${String(response.status)}`, await response.text().catch(() => ''));
            return;
        }
        if (response.body === null) {
            yield failureChunk('EMPTY_BODY', '服务商没有返回响应体');
            return;
        }
        for await (const event of sseEvents(response.body)) {
            if (event.data === '[DONE]')
                break;
            let parsed;
            try {
                parsed = JSON.parse(event.data);
            }
            catch {
                continue;
            }
            const record = parsed;
            if (record.error !== undefined) {
                yield failureChunk(record.error.code ?? 'PROVIDER_ERROR', record.error.message ?? '服务商返回错误');
                return;
            }
            const delta = record.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta !== '')
                yield { type: 'text-delta', index: 0, text: delta };
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
    }
    /** Anthropic：POST {baseUrl}/messages，SSE 取 content_block_delta 的 text_delta。 */
    async *streamAnthropic(provider, options) {
        const messages = toAnthropicMessages(options.messages);
        if (options.images !== undefined && options.images.length > 0) {
            const lastUser = [...messages].reverse().find(message => message.role === 'user');
            for (const dataUrl of options.images) {
                const parsed = parseDataUrl(dataUrl);
                if (parsed !== undefined && lastUser !== undefined) {
                    lastUser.content.push({ type: 'image', source: { type: 'base64', media_type: parsed.mime, data: parsed.data } });
                }
            }
        }
        const payload = {
            model: options.model,
            stream: true,
            max_tokens: options.maxTokens ?? 1024,
            ...(options.system === undefined || options.system === '' ? {} : { system: options.system }),
            messages,
            ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        };
        let response;
        try {
            response = await fetch(`${provider.baseUrl}/messages`, {
                method: 'POST',
                headers: { 'anthropic-version': '2023-06-01', ...this.headers(provider) },
                body: JSON.stringify(payload),
                signal: options.signal,
            });
        }
        catch (error) {
            yield failureChunk('NETWORK', String(error));
            return;
        }
        if (!response.ok) {
            yield failureChunk(`HTTP_${String(response.status)}`, await response.text().catch(() => ''));
            return;
        }
        if (response.body === null) {
            yield failureChunk('EMPTY_BODY', '服务商没有返回响应体');
            return;
        }
        for await (const event of sseEvents(response.body)) {
            if (event.event === 'error') {
                let message = event.data;
                let code = 'PROVIDER_ERROR';
                try {
                    const parsed = JSON.parse(event.data);
                    message = parsed.error?.message ?? message;
                    // provider 原生错误类型必须透出来（overloaded_error / rate_limit_error …），
                    // 否则「过载类 → 冷却」的判定在 Anthropic 协议上永远命中不了。
                    if (parsed.error?.type !== undefined && parsed.error.type !== '')
                        code = parsed.error.type;
                }
                catch {
                    // 保持原始文本
                }
                yield failureChunk(code, message);
                return;
            }
            if (event.event !== 'content_block_delta')
                continue;
            try {
                const parsed = JSON.parse(event.data);
                if (parsed.delta?.type === 'text_delta' && typeof parsed.delta.text === 'string') {
                    yield { type: 'text-delta', index: 0, text: parsed.delta.text };
                }
            }
            catch {
                continue;
            }
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
    }
}
/**
 * 路由器：provider 命中自定义服务商就走自带的 HTTP 客户端，否则交给 dsh 的 LLM 服务。
 * 这样上层（群聊、总结记忆）完全不用关心模型从哪来。
 *
 * 请求里带 `backup` 时自动做**双模型降级**：主模型还没出字就失败（网络、401、5xx…）时，
 * 记一条日志 + 通知调用方，然后用备用模型重跑同一条请求。
 *
 * @param dsh - dsh 的 LLM 服务。
 * @param custom - 插件自带的 API 客户端。
 * @param logger - 日志器（可选）。
 * @param onBackup - 降级回调（可选），用来把「刚降级过」写进运行状态。
 */
export function createLlmRouter(dsh, custom, logger, onBackup) {
    const once = (options) => custom.has(options.provider) ? custom.stream(options) : dsh.stream(options);
    /** 主模型最近一次失败的时间：冷却期内直接走备用，不用每条消息都先失败一次。 */
    const downUntil = new Map();
    return {
        listProviders: () => [...dsh.listProviders(), ...custom.listProviders()],
        /** 拉模型：自定义服务商走插件自带的 HTTP 客户端，其余交给 dsh。 */
        listModels: (provider) => {
            if (custom.has(provider))
                return custom.listModels(provider);
            const delegate = dsh.listModels;
            if (delegate === undefined) {
                return Promise.reject(new Error(`服务商「${provider}」不支持拉取模型列表`));
            }
            return Promise.resolve(delegate.call(dsh, provider))
                .then(models => models.map(model => (model.name === undefined || model.name === ''
                ? { id: model.id }
                : { id: model.id, name: model.name })));
        },
        stream: (options) => {
            const backup = options.backup;
            if (backup === undefined || (backup.provider === options.provider && backup.model === options.model)) {
                return once(options);
            }
            const key = `${options.provider}/${options.model}`;
            const until = downUntil.get(key) ?? 0;
            if (Date.now() < until) {
                const seconds = Math.round((until - Date.now()) / 1000);
                logger?.debug?.('qq-groupmate: 主模型 %s 还在冷却（%s 秒），直接走备用模型 %s', key, String(seconds), label(backup.provider, backup.model));
                return once({ ...options, provider: backup.provider, model: backup.model, backup: undefined });
            }
            return streamWithBackup(once(options), options, backup, once, logger, onBackup, (failure, status) => {
                if (failure === undefined)
                    downUntil.delete(key);
                else if (isProviderDown(failure, status))
                    downUntil.set(key, Date.now() + BACKUP_COOLDOWN_MS);
            });
        },
    };
}
/** 主模型失败后的冷却时长：这段时间内直接走备用。 */
const BACKUP_COOLDOWN_MS = 5 * 60 * 1000;
/** 服务商侧故障的 provider-neutral 失败码：网络 / 超时 / 连接错误 / 空响应体 / 认证失败（等价 401）。 */
const PROVIDER_DOWN_CODES = new Set([
    'NETWORK', 'TIMEOUT', 'ERROR', 'EMPTY_BODY', 'AUTH', 'MISSING_CREDENTIAL',
    // dsh 适配器的网络层故障码，以及自定义服务商在 SSE 里只回了 message、没有原生 code 时的兜底码。
    'TRANSPORT', 'PROVIDER_ERROR', 'EMPTY_RESPONSE', 'SERVER',
]);
/**
 * provider 原生错误码里属于服务端过载 / 限流类的（SSE error 事件会把原生码原样透出，
 * 例如 Anthropic / 中转站的 overloaded_error、rate_limit_error）。
 */
const PROVIDER_OVERLOAD_CODES = new Set(['OVERLOADED_ERROR', 'API_ERROR', 'TIMEOUT_ERROR', 'RATE_LIMIT_ERROR']);
/** 明确属于「请求本身的问题」的失败码：换备用模型也没用，不冷却。 */
const REQUEST_PROBLEM_CODES = new Set([
    'ABORTED', 'UNKNOWN_PROVIDER', 'INVALID_REQUEST', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED', 'QUOTA',
]);
/** HTTP 口径：认证 / 路径 / 超时 / 限流 / 服务端错误算服务商挂了，其余 4xx（400、422…）不算。 */
function isStatusProviderDown(status) {
    return status === 401 || status === 403 || status === 404 || status === 408 || status === 409 || status === 429 || status >= 500;
}
/**
 * 主模型这次失败该不该冷却（冷却期内所有请求直接走备用）。
 *
 * 判定刻意保守：**只有明确属于服务商侧的故障才返回 true，其余（含不认识的码）一律 false**。
 * 分类依据（按优先级）：
 * 1. `'空返回'`：主模型正常结束但一个字没吐（backupOnEmpty 场景），沿用既有语义 → 冷却。
 * 2. 结构化 HTTP 状态码（dsh 的 `LlmFailure.status`，由 streamWithBackup 透传）：
 *    401/403/404/408/409/429/5xx → 冷却；400/422 这类请求本身的问题 → 不冷却。
 * 3. 没有状态码时按 `code`：
 *    - 服务商侧 → 冷却：NETWORK / TIMEOUT / ERROR / EMPTY_BODY、AUTH / MISSING_CREDENTIAL（等价 401）、
 *      provider 原生过载类（overloaded_error / api_error / timeout_error / rate_limit_error）。
 *    - 不冷却：ABORTED（本地取消 / 120 秒超时，换模型也没用）、UNKNOWN_PROVIDER、
 *      INVALID_REQUEST / CONTEXT_WINDOW_EXCEEDED / QUOTA / invalid_request_error 等请求本身的问题。
 *    - 任何未知码 → 不冷却（不知道是不是服务商挂了就别冻结主模型）。
 */
function isProviderDown(failure, status) {
    if (failure === '空返回')
        return true;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status < 600) {
        return isStatusProviderDown(status);
    }
    const code = (failure.split(':')[0] ?? '').trim();
    const match = /^HTTP_(\d{3})$/u.exec(code);
    if (match !== null)
        return isStatusProviderDown(Number(match[1]));
    const upper = code.toUpperCase();
    if (PROVIDER_DOWN_CODES.has(upper) || PROVIDER_OVERLOAD_CODES.has(upper))
        return true;
    if (REQUEST_PROBLEM_CODES.has(upper))
        return false;
    return false;
}
/** `provider/model` 的可读写法。 */
function label(provider, model) {
    return provider === '' ? model : `${provider}/${model}`;
}
/**
 * 主模型失败时切备用模型：只有在「一个字都还没出」时才降级，出了字就照原样收尾。
 * @param note - 把这次主模型是成功还是失败记下来（供冷却逻辑用）；失败时第二个参数是
 *   dsh 失败对象里的结构化 HTTP 状态码（拿不到就是 undefined）。
 */
async function* streamWithBackup(primary, options, backup, again, logger, onBackup, note) {
    let emitted = false;
    let errorChunk;
    let finishChunk;
    try {
        for await (const chunk of primary) {
            if (chunk.type === 'text-delta' && (chunk.text ?? '') !== '') {
                emitted = true;
                yield chunk;
                continue;
            }
            // 结束块先扣下：可能要去降级，不降级时再原样吐出去。
            if (chunk.type === 'finish') {
                if (chunk.reason?.kind === 'error')
                    errorChunk = chunk;
                else
                    finishChunk = chunk;
                break;
            }
            yield chunk;
        }
    }
    catch (error) {
        errorChunk = failureChunk('ERROR', String(error));
    }
    if (errorChunk === undefined && !(finishChunk !== undefined && !emitted && options.backupOnEmpty === true)) {
        note?.(undefined);
        if (finishChunk !== undefined)
            yield finishChunk;
        return;
    }
    if (emitted) {
        // 已经出过字，不能换模型重来，照原样报错。
        if (errorChunk !== undefined)
            yield errorChunk;
        else if (finishChunk !== undefined)
            yield finishChunk;
        return;
    }
    const failure = errorChunk === undefined
        ? '空返回'
        : `${String(errorChunk.reason?.failure?.code ?? 'ERROR')}: ${String(errorChunk.reason?.failure?.message ?? '')}`;
    // dsh 的失败对象带结构化 HTTP 状态码时优先按它分类；自定义客户端的码已写成 HTTP_nnn，走码表。
    const failureStatus = errorChunk?.reason?.failure?.status;
    const from = label(options.provider, options.model);
    const to = label(backup.provider, backup.model);
    note?.(failure, failureStatus);
    if (errorChunk === undefined) {
        logger?.warn('qq-groupmate: 主模型 %s 一个字都没返回，自动切到备用模型 %s', from, to);
    }
    else {
        logger?.warn('qq-groupmate: 主模型 %s 请求失败（%s），自动切到备用模型 %s', from, failure, to);
    }
    onBackup?.({ from, to, reason: failure });
    yield* again({ ...options, provider: backup.provider, model: backup.model, backup: undefined });
}
