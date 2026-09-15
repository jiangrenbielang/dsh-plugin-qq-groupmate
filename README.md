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
