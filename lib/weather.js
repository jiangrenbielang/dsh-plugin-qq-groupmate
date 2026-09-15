/**
 * 天气上下文：把当前天气注入系统提示，让角色被问到天气时能自然回答。
 * 接入方式：
 * - 位置用公网 IP 粗略定位一次（ipwho.is），不保存 IP 地址；
 * - 天气数据来自 Open-Meteo 免费接口，缓存 10 分钟；
 * - 拿不到天气时给一句「坦白说看不到」的兜底话，不编造。
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
/** Open-Meteo 天气码 → 中文描述（与 mod 的 DescribeWeatherCode 一致，换简体）。 */
export function describeWeatherCode(code) {
    if (code === 0)
        return '晴朗';
    if (code >= 1 && code <= 3)
        return '多云';
    if (code === 45 || code === 48)
        return '有雾';
    if (code >= 51 && code <= 57)
        return '毛毛雨';
    if (code >= 61 && code <= 67)
        return '下雨';
    if (code >= 71 && code <= 77)
        return '下雪';
    if (code >= 80 && code <= 82)
        return '阵雨';
    if (code >= 85 && code <= 86)
        return '阵雪';
    if (code >= 95)
        return '雷雨';
    return `天气代码 ${String(code)}`;
}
/** 天气上下文服务：进程内缓存，失败降级不抛错（聊天不被天气拖垮）。 */
export class WeatherService {
    settings;
    logger;
    cached;
    cachedAt = 0;
    lastFailureAt = 0;
    ipResolved = false;
    constructor(settings, logger) {
        this.settings = settings;
        this.logger = logger;
    }
    /**
     * 取天气上下文段落；成功返回注入提示词的一行文本，关闭时返回 undefined。
     * @param now - 当前时间（毫秒），测试可注入。
     */
    async getContext(now = Date.now()) {
        if (!this.settings.enabled)
            return undefined;
        if (this.cached !== undefined && now - this.cachedAt < CACHE_TTL_MS)
            return this.cached;
        // 刚失败过就别连着重试：一分钟内直接给兜底话。
        if (now - this.lastFailureAt < FAILURE_TTL_MS)
            return WEATHER_UNAVAILABLE;
        try {
            await this.resolveLocationFromIp();
            const latitude = this.settings.latitude.toString();
            const longitude = this.settings.longitude.toString();
            const url = 'https://api.open-meteo.com/v1/forecast'
                + `?latitude=${latitude}&longitude=${longitude}`
                + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day'
                + '&temperature_unit=celsius&wind_speed_unit=kmh&precipitation_unit=mm&timezone=auto';
            const response = await fetch(url);
            if (!response.ok)
                throw new Error(`HTTP ${String(response.status)}`);
            const json = await response.json();
            const current = json.current;
            if (current === undefined || current.temperature_2m === undefined || current.weather_code === undefined) {
                throw new Error('响应缺少 current 字段');
            }
            const dayNight = current.is_day === 1 ? '白天' : '夜间';
            const description = describeWeatherCode(current.weather_code);
            const temperature = formatNumber(current.temperature_2m);
            const apparent = formatNumber(current.apparent_temperature ?? 0);
            const humidity = String(Math.round(current.relative_humidity_2m ?? 0));
            const precipitation = formatNumber(current.precipitation ?? 0);
            const wind = formatNumber(current.wind_speed_10m ?? 0);
            const place = this.settings.locationName === '' ? '本地' : `「${this.settings.locationName}」`;
            this.cached = `目前${place}的即时天气（Open-Meteo 模型数据）：${description}，${dayNight}，气温 ${temperature}°C，`
                + `体感 ${apparent}°C，相对湿度 ${humidity}%，目前降水 ${precipitation} mm，风速 ${wind} km/h。`
                + '被问到现在的天气时依此自然回答，不要自行编造未提供的信息。';
            this.cachedAt = now;
            return this.cached;
        }
        catch (error) {
            this.lastFailureAt = now;
            this.logger.warn('qq-groupmate: 天气查询失败（聊天不受影响，1 分钟内不再重试）：%s', String(error));
            return WEATHER_UNAVAILABLE;
        }
    }
    /** 用公网 IP 粗略定位一次城市（只取城市/经纬度，不保存 IP）。 */
    async resolveLocationFromIp() {
        if (this.ipResolved || !this.settings.autoDetectFromIp)
            return;
        this.ipResolved = true;
        try {
            const response = await fetch('https://ipwho.is/?fields=success,message,city,region,country,latitude,longitude');
            if (!response.ok)
                throw new Error(`HTTP ${String(response.status)}`);
            const json = await response.json();
            if (json.success === false)
                throw new Error(json.message ?? 'IP 定位失败');
            if (json.latitude === undefined || json.longitude === undefined)
                throw new Error('IP 定位缺少经纬度');
            this.settings.latitude = json.latitude;
            this.settings.longitude = json.longitude;
            const parts = [json.city, json.region, json.country]
                .filter((part) => part !== undefined && part.trim() !== '');
            const name = [...new Set(parts)].join('，');
            if (name !== '')
                this.settings.locationName = name;
            this.logger.warn('qq-groupmate: 天气位置按 IP 粗略定位为「%s」（未保存 IP 地址）', this.settings.locationName);
        }
        catch (error) {
            // 定位失败不算致命：改用配置里写死的经纬度继续查。
            this.logger.warn('qq-groupmate: IP 天气定位失败，改用配置位置：%s', String(error));
        }
    }
}
/** 天气拿不到时给模型的兜底说明（与 mod 同款口径）。 */
export const WEATHER_UNAVAILABLE = '目前无法取得可靠的即时天气；若被问到天气，坦白说暂时看不到，不要猜测。';
function formatNumber(value) {
    return Number(value).toFixed(1).replace(/\.0$/u, '');
}
