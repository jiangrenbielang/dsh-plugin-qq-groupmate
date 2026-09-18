/**
 * 本机可靠路由：明确的本地指令不叫模型，直接在这台电脑上回答。
 *
 * 移植自莉莉丝 AI Mod 的 TryBuildLocalTimeReply（时间 / 日期 / 星期）：
 * 答案本来就在本机，绕一圈问模型只会更慢，还可能被编出一个错的日期。
 * 正则与 mod 一致（简繁都认），回答格式也照抄：「今天是 2026 年 9 月 15 日，星期二，现在是 14:33。」
 */
/** 问时间的说法（mod 的 asksTime 正则）。 */
const ASKS_TIME_RE = /(现在|現在|目前|此刻).{0,4}(几点|幾點|时间|時間)|(几点|幾點)了|现在是几点|現在是幾點/u;
/** 问日期的说法。 */
const ASKS_DATE_RE = /(今天|现在|現在|目前).{0,4}(几号|幾號|日期|几月几日|幾月幾日)/u;
/** 问星期的说法。 */
const ASKS_WEEKDAY_RE = /(今天|现在|現在|目前).{0,4}(星期几|星期幾|礼拜几|禮拜幾|周几|週幾)/u;
/** 星期名（与 mod 的 DayOfWeek 映射一致）。 */
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
/** 两位补零。 */
function pad(value) {
    return String(value).padStart(2, '0');
}
/**
 * 消息是不是「问时间 / 日期 / 星期」；是的话直接给出本机答案。
 * @param text - 群友这条消息的正文。
 * @param now - 当前时间（注入以便测试）。
 * @returns 回复文本；不是这类问题就返回 `undefined`（交回给模型）。
 */
export function buildLocalTimeReply(text, now = new Date()) {
    const input = String(text ?? '');
    if (input === '')
        return undefined;
    const asksTime = ASKS_TIME_RE.test(input);
    const asksDate = ASKS_DATE_RE.test(input);
    const asksWeekday = ASKS_WEEKDAY_RE.test(input);
    if (!asksTime && !asksDate && !asksWeekday)
        return undefined;
    const parts = [];
    if (asksDate)
        parts.push(`今天是 ${String(now.getFullYear())} 年 ${String(now.getMonth() + 1)} 月 ${String(now.getDate())} 日`);
    if (asksWeekday)
        parts.push(WEEKDAYS[now.getDay()] ?? '星期日');
    if (asksTime)
        parts.push(`现在是 ${pad(now.getHours())}:${pad(now.getMinutes())}`);
    return parts.join('，') + '。';
}
