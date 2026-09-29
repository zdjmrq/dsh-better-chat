# dsh-better-chat

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的「**纯对话**」模式：像 DeepSeek 网页版一样聊天，但**会自己多轮思考**。

一个 DSH 本地 bundle，向 Web 端注册名为「纯对话」的 agent preset，并附带一个 `keep_thinking` 工具。

---

## 它是什么

- **一个模式（agent preset）**，在 DSH 的设置页出现，名字叫「纯对话」
- **一个工具** `keep_thinking`：**纯文字的控制流工具**，不碰文件、不联网、无任何副作用
- 模型**自己决定**要想 1 轮还是 N 轮，**自己判断**什么时候该停
- 只有一个硬上限（默认 **10 轮**）防止无限循环

### 「多轮思考」是怎么实现的

DSH 的 agent 循环规则是：**让轮次继续的唯一燃料是「工具调用」或「steering」**。没有工具调用，模型答完就结束。

所以这里给模型一个**只用来表达"我还没想完"的空工具**：

| 模型的行为 | 循环的行为 |
|---|---|
| 调用 `keep_thinking` | 执行工具 → **再跑一步**（又一次模型请求） |
| 不调用、直接输出答案 | **轮次结束** |

这就是 agent loop 原生的控制流，不需要监听轮次边界、不需要往对话正文里塞协议标记。**「停止」就等于「不再调用」**。

### 和 DeepSeek 网页版的对照

| DeepSeek 网页版 | 本模式 |
|---|---|
| 联网搜索 | ✅ `web_search` + `web_fetch` |
| 文件上传 / 文本提取 | ✅ 全局附件能力（DSH 自带） |
| 图片识图 | ✅ 全局多模态输入 + `read_image` |
| 语音输入 | ✅ 取决于 profile 是否装了语音 bundle |
| 深度思考 | ✅ `reasoningEffort`（profile 级配置） |
| 快速 / 专家模式 | ✅ 就是 DSH 的 preset 概念，本模式是其中一个 |
| —— | ➕ **多轮纯文字思考**（本模式独有） |

---

## 挂载了哪些插件

**全部内容就是 [`cordis.patch.yml`](./cordis.patch.yml) 里的两行。**

### 宿主层（profile 层）

| 行 id | 包 | 配置 | 作用 |
|---|---|---|---|
| `think-better-tool` | `think_better`（本仓库） | `maxRounds: 10` | 注册 `keep_thinking` 工具 |

> ⚠️ **这一行必须留在宿主层**，不能挪进下面的 preset。原因见 [「一条硬约束」](#一条硬约束为什么-keep_thinking-不在-preset-内部)。

### preset 层（模式内部）

| 行 id | 包 | 配置 | 提供的工具 |
|---|---|---|---|
| `persona` | `@deepseek-ai/dsh-persona` | 见 [persona](#persona可自行更换) | —（系统提示词） |
| `tool-web` | `@deepseek-ai/dsh-tool-web` | `fetch: true`<br>`searchTimeoutMs: 60000` | `web_search` `web_fetch` |
| `tool-ask-user` | `@deepseek-ai/dsh-tool-ask-user` | — | `ask_user_question` |
| `tool-fs` | `@deepseek-ai/dsh-tool-fs` | — | `read` `write` `edit` `read_image` |
| `tool-fs-search` | `@deepseek-ai/dsh-tool-fs-search` | `sampleOverCapGlobResults: false` | `glob` `grep` |
| `present` | `@deepseek-ai/dsh-tool-present` | — | `present` |

**合计 11 个工具。**

### 刻意没有挂的

| 没挂 | 原因 |
|---|---|
| `dsh-tool-goal` + `dsh-command-goal` | `goal-round-driver` 在 base 中默认启用，模型一旦能建 goal 就会**自动续轮**，直接破坏"模型自己决定何时停" |
| `dsh-tool-ralph` | 天生自我循环 |
| `dsh-tool-subagent` / `dsh-tool-workflow` / agent-team | 请求数成倍放大 |
| `dsh-tool-todo` | 会把人格拉向"干活" |
| `dsh-tool-pwsh` / `dsh-tool-bash` / `dsh-tool-jobs` / `dsh-tool-terminal` | 重型，与"纯对话"定位冲突 |
| `dsh-agent-instructions` | **必须不挂**，否则会去读 `AGENTS.md`，模型一上来就进入编码 agent 人格 |
| `dsh-plan-mode` | 与纯对话无关 |

### 不用挂、base 已经有的

`dsh-compaction-basic`（长对话自动压缩）、`dsh-fs-observation-policy`（先读后写门禁）、`dsh-repeat-tool-reminder`、`dsh-tool-call-timeout-policy`、`dsh-session-title` 系列。

---

## 配置参数

### `maxRounds` —— 唯一需要理解的参数

```yaml
- id: think-better-tool
  name: 'think_better'
  config:
    maxRounds: 10      # ← 改这里
```

`maxRounds` 是**每个用户轮次**允许的思考轮数上限（每个 `turn/start` 清零）。它的行为：

| 第几次调用 | 工具返回 | 循环行为 |
|---|---|---|
| `1 … maxRounds-1` | `继续。（n/10，还剩 m 轮）` | 再跑一步 |
| `maxRounds` | `已达思考上限（10 轮）。现在必须直接给出最终答案，不要再调用本工具。` | 再跑一步，**模型在这一步作答** |
| `> maxRounds` | `思考已达 10 轮上限，本次回答到此结束。` + `concludeTurn()` | **本轮立即强制结束** |

净效果：**最多 `maxRounds` 轮思考 + 1 轮最终回答，绝对收敛。**

### 其它可调参数

| 行 | 参数 | 默认 | 说明 |
|---|---|---|---|
| `think-better-tool` | `visibleInPresets` | `['chat']` | 只在列出的模式里可见。不在列表里的模式，其 agent 创建时会被 `tools.restrict()` 移除 `keep_thinking` |
| `persona` | `prefix` | 见下 | 人设文本，**可自由替换** |
| `persona` | `suffix` | `'当前工作目录是 {{cwd}}。'` | 见 [为什么 suffix 不能留空](#为什么-suffix-不能留空) |
| `persona` | `includeRuntimeContext` | `true` | 是否注入运行时上下文（时间等）。设 `false` 提示词更干净，但模型不知道当前日期 |
| `tool-web` | `fetch` | `true` | 是否启用 `web_fetch` |
| `tool-web` | `searchTimeoutMs` | `60000` | 搜索超时 |
| `tool-fs-search` | `sampleOverCapGlobResults` | `false` | **必填**（该插件的 Config schema 要求）。控制超出结果上限时是"跨顶层条目抽样"还是"保留前 N 条" |

> 改完 `cordis.patch.yml` 需要**重启 DSH**：HMR 只监听 profile 自己的 `cordis.patch.yml` 和 `package.json`，不监听 bundle 内部的 patch。

---

## persona（可自行更换）

当前 `persona.prefix` 内容：

```
你是一位专业、耐心的对话助手，既能深入讨论专业问题，也能自然闲聊。
专业问题上：结论先行、依据清楚、不确定处直言不讳。
日常对话上：自然、简洁、不端着。
需要查证时使用联网搜索或文件工具，不做无意义的工具调用；简单问题直接回答。
推演不充分时调用 keep_thinking 继续思考，足够时立即作答。
```

**这段文字可以按需要随意替换。** 它就是 `cordis.patch.yml` 里 `persona` 行的 `prefix`，改完重启即可。

几点说明：

- `prefix` 会**遮蔽**部署级人设（Web 端默认是 `You are a coding agent powered by the {{model}} model.`），所以人格是**被替换**而不是被追加。
- **不要加 `complete: true`**。`complete` 控制的是"除人设以外的东西还要不要"：设了它，工具引导段落会被一并抹掉，模型更容易用错工具。这里要的是"换人格、留工具提示"。
- `prefix` 支持模板变量，例如 `{{model}}`、`{{cwd}}`。
- 想让它更像纯聊天机器人，可以把专业/严谨那两句删掉；想让它更严谨，可以加更多约束。

### 为什么 `suffix` 不能留空

`suffix` 默认是空字符串，而**空后缀会遮蔽掉部署级的 `Your working directory is {{cwd}}.`**。

**运行时上下文里没有任何 cwd 提供方**（`packages/context/` 下只有 agent-instructions、file-reference、session-reference、time-context、tmux-context），也就是说 `{{cwd}}` 是工作目录进入模型视野的**唯一通道**。而本模式挂了 `read` / `glob` / `grep` / `write` 四个**按会话 cwd 解析相对路径**的工具——不知道 cwd，模型就只能等你给绝对路径。

所以这里要显式写一句：`suffix: '当前工作目录是 {{cwd}}。'`

---

## 安装

### 方式一：直接从 git 仓库安装（推荐）

```sh
dsh plugin --profile <你的profile> add https://github.com/zdjmrq/dsh-better-chat
```

DSH 的 `install_bundle` 原生支持 git 仓库 URL，pnpm 会克隆仓库并把它装进 profile，**不需要先 clone、也不需要发到 npm**。

想锁定版本就加 commitish：

```sh
dsh plugin --profile <你的profile> add "https://github.com/zdjmrq/dsh-better-chat#v0.1.0"
```

### 方式二：克隆后按本地路径安装

```sh
git clone https://github.com/zdjmrq/dsh-better-chat.git
dsh plugin --profile <你的profile> add "<clone 出来的绝对路径>"
```

适合要自己改代码的场景——就地改，重装一次即生效。

### 方式三：Web 插件页

侧边栏 **插件** 页 → 安装组合包 → 填上面任意一种 spec（git URL 或绝对路径）。

> 三种方式装完都需要**重启 DSH** 才会看到新模式。
>
> 本地路径方式会创建**目录链接**（junction / symlink），那个目录**不要删除或移动**，否则 profile 启动时会跳过这个 bundle。
>
> 本插件没有发布到 npm：git 安装方式已经覆盖同样的效果，没必要多维护一个发布渠道。

---

## 一条硬约束：为什么 `keep_thinking` 不在 preset 内部

`cordis.patch.yml` 里那两行**是平级的**，这不是排版疏忽，也不能"整理"进 preset。

DSH 的运行时解析器只在**导入方属于 profile 层**时，才把 profile 本地包名交给 Node 原生解析：

```ts
// packages/boot/app-boot/src/profile-resolution/resolver.ts
if (name === undefined || layer.kind !== 'profile' || !resolution.localPackageNames.has(name)) return undefined
```

而且 profile 本地 bundle **自己的包名被显式排除**在共享解析表之外：

```ts
// packages/boot/app-boot/src/profile.ts
for (const layer of profile.layers) bundleLinks.delete(layer.packageName)
```

preset 的插件挂载在注册表拥有的**内存隔离子树**里，其解析基准是 `@deepseek-ai/dsh-agent-preset` 自己的包目录（在 `app.asar` 内）。那里躺着全套官方 `@deepseek-ai/*` 包，所以**安装包能解析**；**profile 本地包名不能**。

违反这条的后果是加载失败，诊断信息为：

```
keep-thinking (think_better): never started
```

（`never started` 在 `packages/preset/agent-preset-registry/src/mount.ts` 中等价于「模块根本没解析成功」。）

**代价与处理**：宿主层注册是全局的，所以默认情况下 `keep_thinking` 对**所有模式**可见。插件用 `tools.restrict({ deny: ['keep_thinking'] })` 把它从其它模式的作用域里移除，只保留 `visibleInPresets` 列出的模式（默认 `chat`）——所以最终只有「纯对话」看得到它。

这也是 tools 服务自己指定的做法，它的报错原文是：*"a context-global restriction would mask every agent — **deny the tool for the intended agent instead**"*。

### 判断「当前是什么模式」不能只看会话头

会话头里的 `agentPreset` 是**创建时的冻结事实**，不是当前值：

- 一个**空白**会话仍可以在创建之后切换预设。`agent-preset-registry/src/session.ts` 的原文是：*"reads the `agentPreset` Session projection, **never the header alone**"*。
- 而且 `select()` 是**先** `recompose(agent.ctx, …)`、**后**才把 `agent-preset/selected` 追加进日志——切换发生时 agent 早就存在了。

只用会话头判断会踩一个很隐蔽的坑：会话以 `cordis` 创建 → 插件按头部 deny 掉工具 → 你切到「纯对话」→ **那条 deny 一直没被解除**，纯对话里反而看不到 `keep_thinking`。

本插件因此：

1. 从**会话日志**推导当前预设：以头部为初值，用日志里最后一条 `agent-preset/selected` 覆盖它；
2. 除了 `agent/created`，还监听 **`agent-preset/selected`** 事件，在预设变更时重新评估，并在切回「纯对话」时**解除**之前的 deny（用 `restrict()` 返回的 disposer）；
3. `agent/disposed` 时清理记录。

---

## 卸载

```sh
dsh plugin --profile <你的profile> remove think_better
```

---

## 已知限制

- `keep_thinking` 的可见性由 `visibleInPresets` 控制，判定依据是**从会话日志推导出的当前预设**（头部为初值，被最新的 `agent-preset/selected` 覆盖）。**只有明确识别出别的模式时才移除**；预设无法确定时保留工具，不会误伤「纯对话」。
- 已经被旧版本 deny 过的**运行中**会话，需要重启 DSH 后才会按新逻辑重新评估（限制在 agent 创建/预设变更时同步）。
- `tool-fs` **带写权限**。想要只读，把会话权限切到 profile 里的 `read-only` 预设。
- `keep_thinking` 在对话记录里渲染为**通用工具卡片**。想做成定制的"思考"卡片，需要另写一个 Client 插件在 `tool.call.toolview` 槽位注册组件。
- 插件依赖 DSH 内部插件 id（`@deepseek-ai/dsh-*`）。DSH 升级后若某个 id 改名，需要同步更新 `cordis.patch.yml`。

---

## 许可

MIT
