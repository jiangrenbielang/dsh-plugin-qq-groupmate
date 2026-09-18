# dsh-plugin-qq-groupmate

> **仅自用**：个人自用项目，按需更新，不承诺兼容性与技术支持。感谢ds老师。

让 DeepSeek Harness 里的 AI 以**普通群友**的身份住进 QQ 群。

通过 OneBot 11 接协议端，用角色卡定义人设，每个群可以独立切换角色与模型；所有配置都在 dsh 设置页的插件卡片里改，改完即时生效，不用重启。

## 功能

- **OneBot 11 接入**：正向 / 反向 WebSocket 都支持，NapCat、SnowLuma、LLOneBot、Lagrange、go-cqhttp 等协议端均可
- **角色卡**：人设、性格、说话风格、示例对话；兼容 SillyTavern V2 卡片，也支持一份 JSON 里的原生格式
- **按群独立配置**：每个群单独指定角色、模型、触发规则、上下文长度，和 dsh 主会话互不干扰
- **触发控制**：被 @ / 关键词前缀 / 概率接话，带冷却；私聊也响应
- **上下文与记忆**：多轮上下文 + 长期记忆压缩，群里的印象能沉淀下来
- **命令系统**：`.help`、角色切换、印象管理、提醒、贴纸、天气、塔罗等，命令前缀可配
- **可选生图**：模型输出 `[生图:标签]` 就画一张发进群（需要自备 Nai2API 兼容服务，见下文）
- **语音回复（可选）**：本地 GPT-SoVITS 合成语音发成 QQ 语音，中文 / 日文两套音色各自独立，情绪自动切参考音
- **本机可靠路由**：问时间 / 日期 / 星期直接在本机回答，不花模型额度
- **设置页可视化**：全部配置都在设置页里改，带开关、下拉、说明文案

## 安装

前置：dsh 已装好，且 PATH 上有 pnpm（`dsh plugin` 是一层 pnpm 转发器）。

```bash
# profile 名按自己用的填：web / desktop / headless
dsh plugin --profile web add github:lilith1257/dsh-plugin-qq-groupmate
```

装完这个包装声明了 `dsh.bundle`，dsh 会把它自动并进 profile 的组合层，**不需要手改 cordis.patch.yml**。重启 dsh 生效。

更新 / 卸载：

```bash
dsh plugin --profile web update dsh-plugin-qq-groupmate
dsh plugin --profile web remove dsh-plugin-qq-groupmate
```

## 接协议端

默认是**反向 WS**：插件在本机 `127.0.0.1:3001` 监听，协议端连进来。

以 NapCat / SnowLuma 为例，在协议端的网络配置里加一个反向 WebSocket：

```
ws://127.0.0.1:3001
```

如果要走**正向 WS**（插件主动连协议端），在设置页把 `mode` 改成 `forward`，并填协议端的 WS 地址。

两边都能配 `accessToken`，填一致即可；留空表示不校验。

## 配置

设置页 →「插件」→ QQ 群友。几个常改的：

| 配置 | 说明 |
| --- | --- |
| `mode` / `listenPort` / `wsUrl` | 接入方式与端口 |
| `defaultCharacter` | 默认角色卡的 id |
| `provider` / `model` | 群聊用哪个模型；也可以给单个群单独指定 |
| `trigger` | 什么时候接话：被 @、前缀、随机概率、冷却、是否响应私聊 |
| `context` | 上下文轮数与字符上限 |
| `groups` | 按群覆盖角色与模型 |
| `dataDir` / `charactersDir` | 数据目录与角色卡目录 |

## 角色卡

角色卡是 JSON，放在 `<数据目录>/characters/` 下（默认 `~/.dsh/qq-groupmate/characters/`），文件名去掉扩展名就是角色 id。

仓库自带一张示例卡 `characters/default.json`（角色名「小可」）。**刚装完数据目录还是空的**，插件会先用随包那张兜底；往数据目录里放了自己的卡之后，就只读数据目录。

支持的字段：

```json
{
  "name": "小可",
  "aliases": ["小可"],
  "persona": "你是谁、怎么说话",
  "personality": "性格",
  "background": "背景与偏好",
  "speakingStyle": "说话风格",
  "scenario": "所处场景",
  "greeting": "第一句问候",
  "exampleDialogues": ["群友: 在吗\n小可: 在的"],
  "extraPrompt": "额外规则",
  "provider": "可选，覆盖模型服务商",
  "model": "可选，覆盖模型"
}
```

SillyTavern V2 卡片（`{"spec":"chara_card_v2","data":{...}}`）也能直接丢进去。

## 生图（可选）

生图默认关。要用的话需要**自己准备**一个 Nai2API 兼容的出图服务，然后在设置页里填：

- **服务地址**（`imageGen.baseUrl`）：你的出图服务地址，例如 `https://your-host`
- **密钥**（`imageGen.token`）：该服务的 token

另有一条「网页引擎」路线：用无头浏览器驱动一个线上生图页面，让它自己拼参数出图。要启用得在配置里加上 `imageGen.pageUrl`（生图页面地址）——**留空就等于关闭网页引擎**，只走直连接口。

## 语音（可选）

回复可以顺带发一条 QQ 语音：本地 GPT-SoVITS（api_v2 格式接口）合成，合成失败只影响语音，文字照常发。

- **中文音色**：`voice.endpoint`（默认 `http://127.0.0.1:9880/tts`），参考音放 `voice.refsDir`（默认 `<数据目录>/voice/refs`）
- **日文音色**：`voice.japaneseEndpoint`（默认 `http://127.0.0.1:9881/tts`），参考音放 `voice.japaneseRefsDir`
- **语言选择**：`voice.language` = `auto`（默认，回复里出现假名就走日文音色）/ `zh` / `ja`
- **参考音目录留空会自动探测**：语音运行时隔壁的 `voice`（与 `voice/jp`），也就是 `…/data/LilithTextInjector/voice` 这种部署结构，装好运行时就能直接用
- **参考音文件名**：`calm-reference.wav`、`excited-reference.wav`、`wronged-reference.wav`、`sleepy-reference.wav`（日文另加 `calm-aux-reference.wav`）
- **自动拉起**：`voice.autoStart` 打开且端点是本机回环时，插件会**按语言各自**拉起一次本地服务（先试随包宿主，宿主起不来就改用运行时的 venv 直接跑 `api_v2.py`，配置按语言选 `zh` / `ja` 的 cuda / cpu 配置）
- **情绪 → 语气**：按回复内容自动挑参考音（晚安 / 困 → 困倦，被逗 / 开心 → 开心，难过 / 被凶 → 委屈，其余 → 平静）

## 缓存命中（为什么请求要「前缀稳定」）

上游（DeepSeek 官方、中转站）按**请求前缀**做上下文缓存：前缀里改一个字，它后面的全部内容都要重新计费。群聊一轮动辄几万 token 的历史，前缀一抖就是整段 miss——后台看到的缓存命中率会趋近于零。

所以提示词被拆成两半：

- **系统提示只放「这个角色 + 这个群不变的东西」**（人设、群聊规则、表情包与画图说明、工具箱说明）——同一角色同一群里逐轮逐字节一致，永远排在请求最前面；
- **每轮都会变的运行上下文**（长期记忆、知识检索、群友档案、称呼指引、天气、成员列表）单独成块，插在消息序列末尾、当前消息之前。

历史裁剪同样是**块状**的（一次至少丢 16 条），不是每来一条就滑一格：滑动窗口会让前缀每轮都漂移。

记忆本身也必须有上限：长期记忆按**金字塔**合并（每 `mergeCount` 条并成一条，最高层封顶 8 条、每条目标 1200 字，越久远越浓缩），进提示词的部分再受条数与字数预算约束（先放最高层的浓缩记忆，剩下的预算才给最近的细节）——只取最近的会把老记忆的骨架丢掉。

打开调试日志时，每轮会打一条 `缓存前缀 system=xxxxxxxx（1250 字）消息=… 条 上下文块=… 字 首条=…`：同一角色同一群里 system 指纹应当**每轮完全相同**，变了就说明有动态内容被塞回了系统提示；「上下文块」的字数应当稳定在几千到一万多，写成几十万就说明某类累积数据又失控了。

## 数据目录

默认 `$DSH_HOME/qq-groupmate`（`DSH_HOME` 没设就是 `~/.dsh`）。里面有：

- `characters/` 角色卡
- `state.json` 群配置与运行状态
- `qq-groupmate.log` 运行日志
- `tarot/cards/` 塔罗卡面（没有就用随包那份）
- 记忆、印象、贴纸、语音等子目录

## 目录结构

```
lib/              host 半（运行时 JS，Node 直接跑）
client.js         浏览器半（设置页卡片）
rphub/qq-bridge.js  网页引擎注入用的桥接脚本
characters/       随包示例角色卡
assets/tarot-cards/ 塔罗卡面
knowledge/        可选的群内答疑知识库（默认关）
cordis.patch.yml  组合包补丁（默认配置）
```

这个仓库发布的是**运行时产物**，`lib/*.js` 就是实际跑的代码，不是压缩过的 bundle，可以直接读、直接改。

## 许可

MIT。随包的 `knowledge/rp-hub-faq.md` 是 Roleplay Hub（RP-Hub）1.9.3 的衍生整理，按 CC BY-NC 4.0 授权，详见该文件头部。
