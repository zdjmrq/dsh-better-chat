# dsh-better-chat

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的「**更好的对话模式**」模式：像 DeepSeek 网页版一样聊天，但**会自己多轮思考**。

一个 DSH 本地 bundle，向 Web 端注册名为「更好的对话模式」的 agent preset，并附带一个 `keep_thinking` 工具。

---

## 它是什么

- **一个模式（agent preset）**，在 DSH 的设置页出现，名字叫「更好的对话模式」
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

**全部内容就是 [`cordis.patch.yml`](./cordis.patch.yml) 里的**一个** preset 声明。**

### 宿主层（profile 层）

**空的。** 本 bundle 以前在这里放一行 `think-better-tool`，现在没有了——原因见 [「为什么工具行在 preset 里面」](#为什么工具行在-preset-里面)。

### preset 层（模式内部）

5 个官方工具行 + 本仓库自己的工具行，全部挂在 `preset-chat` 的 `config.plugins` 里：

| 行 id | 包 | 配置 | 提供的工具 |
|---|---|---|---|
| `think-better-tool` | `think_better`（本仓库），以**绝对 file URL** 引入 | `maxRounds: 10` | `keep_thinking` |
| `persona` | `@deepseek-ai/dsh-persona` | 见 [persona](#persona可自行更换) | —（系统提示词） |
| `tool-web` | `@deepseek-ai/dsh-tool-web` | `fetch: true`<br>`searchTimeoutMs: 60000` | `web_search` `web_fetch` |
| `tool-ask-user` | `@deepseek-ai/dsh-tool-ask-user` | — | `ask_user_question` |
| `tool-fs` | `@deepseek-ai/dsh-tool-fs` | — | `read` `write` `edit` `read_image` |
| `tool-fs-search` | `@deepseek-ai/dsh-tool-fs-search` | `sampleOverCapGlobResults: false` | `glob` `grep` |
| `present` | `@deepseek-ai/dsh-tool-present` | — | `present` |

**合计 11 个工具。** 实测「更好的对话模式」一轮实际下发 **25 个工具**——多出来的 14 个来自宿主层的其它 bundle，见 [已知限制](#已知限制)。

> 因为工具行**就在 preset 里**，`ctx.tools.register()` 走的是 preset 的作用域：只有「更好的对话模式」的 agent 看得见它，其它模式**不需要被摘掉任何东西**。

### 刻意没有挂的

| 没挂 | 原因 |
|---|---|
| `dsh-tool-goal` + `dsh-command-goal` | `goal-round-driver` 在 base 中默认启用，模型一旦能建 goal 就会**自动续轮**，直接破坏"模型自己决定何时停" |
| `dsh-tool-ralph` | 天生自我循环 |
| `dsh-tool-subagent` / `dsh-tool-workflow` / agent-team | 请求数成倍放大 |
| `dsh-tool-todo` | 会把人格拉向"干活" |
| `dsh-tool-pwsh` / `dsh-tool-bash` / `dsh-tool-jobs` / `dsh-tool-terminal` | 重型，与"更好的对话模式"定位冲突 |
| `dsh-agent-instructions` | **必须不挂**，否则会去读 `AGENTS.md`，模型一上来就进入编码 agent 人格 |
| `dsh-plan-mode` | 与更好的对话模式无关 |

### 不用挂、base 已经有的

`dsh-compaction-basic`（长对话自动压缩）、`dsh-fs-observation-policy`（先读后写门禁）、`dsh-repeat-tool-reminder`、`dsh-tool-call-timeout-policy`、`dsh-session-title` 系列。

---

## 配置参数

### `maxRounds` —— 唯一需要理解的参数

```yaml
- id: preset-chat
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: chat
    plugins:
      - id: think-better-tool
        name: 'file:///…/think_better/lib/index.js'
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
| `think-better-tool` | `maxRounds` | `10` | 见上 |
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

## 为什么工具行在 preset 里面

`cordis.patch.yml` 里**只有一行**（`preset-chat`）；`keep_thinking` 是它 `config.plugins` 里的一个子行，而且用**绝对 file URL** 而不是包名引入：

```yaml
- id: think-better-tool
  name: 'file:///E:/DeepSeekHarness_own_plugin/think_better/lib/index.js'
  config:
    maxRounds: 10
```

### 为什么不能用包名

用裸包名 `think_better` 时会失败，诊断是：

```
think-better-tool (think_better): never started
```

（`never started` 在 `packages/preset/agent-preset-registry/src/mount.ts` 中等价于「模块根本没解析成功」。）

因为那条允许 profile 本地包名的规则是**层级专属**的：

```ts
// packages/boot/app-boot/src/profile-resolution/resolver.ts
private routeLocalPackage(request, parentRoutes, resolution) {
  ...
  if (name === undefined || layer.kind !== 'profile' || !layer.active
      || !resolution.localPackageNames.has(name)) return undefined
  return { route: { kind: 'native' as const } }   // 放行给 Node
}
```

只有 `layer.kind === 'profile'` 的导入方会走这条路，而 preset 的行挂在注册表拥有的**内存子树**里。

### 为什么 file URL 可以

绝对 `file:` URL **完全不需要包解析**——Node 直接 import 那个 URL。而且 `compatibility-preflight.ts` 把这个情形**显式**写进了判断：

```ts
if (!isAbsolute(specifier) && !specifier.startsWith('.') && !specifier.startsWith('file:')) return undefined
```

所以这样的行会被当成普通行接纳。

### 真正的收益是作用域

工具行挂在 preset 里，`ctx.tools.register()` 就落在 **preset 的作用域**上：只有从「更好的对话模式」组合出来的 agent 看得见 `keep_thinking`，其它模式**什么都不用摘**。插件因此没有任何可见性逻辑——不监听 `agent/created`、不推断当前预设、不调用 `tools.restrict()`。

> **实测记录**（把没验证的结论跟验证过的分开写）
>
> - 用一个一次性的探针预设实测：preset 子树里按 file URL 挂一行，`IMPORTED` 和 `APPLIED` 都会发生 ✅
> - 探针读到的 `ctx.baseUrl` 是 **profile 目录**（`file:///…/profiles/<name>/`），不是 `app.asar`。
> - 这一点跟上面那条「裸包名不行」**是冲突的**：baseUrl 落在 profile 目录里，按 `routeLocalPackage` 的规则裸包名**本该**能解析。所以当初那次 `never started` 的确切原因**没有定论**（一个可能是当时 `think_better` 还没写进 profile 的 `dependencies`，于是 `localPackageNames` 里没有它）。
> - 结论：**file URL 是验证过可行的那条路**；裸包名现在到底行不行，**没测过**。

### 顺带记录：切换预设的窗口

- 会话头里的 `agentPreset` 是**创建时的冻结事实**，不是当前值。`agent-preset-registry/src/session.ts` 的原文是：*"reads the `agentPreset` Session projection, never the header alone"*。
- `select()` 会拒绝已经开过轮的会话（抛 `agent-preset/locked: This session has already started`）。**预设只能在第一次对话之前选**，一旦跑过一轮就冻结——所以在旧会话里换不到「更好的对话模式」，只能新建一个。

这两条在旧版本里曾经是个坑（那时可见性靠「按会话头 deny、切预设再解除」，还会踩到 `select()` 的时序）。现在工具跟着配方走，可见性已经与预设身份无关。

---

## 插件列表里的显示名

插件页显示的**不是**包名，而是一份可本地化的显示元数据。取法（`packages/boot/app-boot/src/package-meta.ts` 的 `readPluginMeta`）：

1. 先解析 `<包名>/locale/en.json` —— 这个文件是**入口**，没有它，其它语言文件根本不会被扫描；
2. 再扫同目录下所有 `<语言id>.json`，**文件名就是查表用的键**（小写化：`zh-CN.json` → `zh-cn`）；
3. `meta.title` / `meta.description` 取到就用；取不到则回落到 `package.json` 的 `name` / `description`；
4. 客户端 `presentation.ts` 是 `title: pkg.meta?.title ?? pkg.name` —— **所以包名和显示名是两回事**。

### ⚠️ 文件名必须和 DSH 的语言 id 一模一样

**这一步很容易错。** DSH 内置的语言 id 是 **`zh`** 和 `en`（`packages/client/locale/src/locale-settings.ts`：`LOCALE_IDS = ['zh', 'en']`），**不是 `zh-CN`**。

查表是按当前语言 id 做的（`locale/src/client/index.ts`）：

```ts
resolveText(text) {
  return this.fallbackChain(this.snapshot.active).reduceRight(
    (resolved, locale) => text[localeKey(locale)] ?? resolved,   // localeKey = toLowerCase()
    text.en,
  )
}
```

所以文件名写成 `zh-CN.json` 时，键是 `zh-cn`，而当前语言是 `zh` → **查不到 → 静默回落到英文**。页面就会显示英文标题和英文描述，而且**不报任何错**。

本仓库因此同时放两个，覆盖 `zh` 和可能的 `zh-CN` 语言包：

```json
// locale/zh.json       ← 内置语言，主要就靠这个
// locale/zh-CN.json    ← 兼容自定义 zh-CN 语言包
{ "meta": { "title": "更好的对话模式", "description": "…" } }

// locale/en.json       ← 入口文件 + 英文兜底
{ "meta": { "title": "Better Chat Mode", "description": "…" } }
```

### 插件页上哪些能改、哪些改不了

| 页面元素 | 来源 | 能不能中文化 |
|---|---|---|
| 标题 | `meta.title` | ✅ |
| 描述 | `meta.description` | ✅ |
| 版本号 | `package.json` 的 `version` | ❌ 本来就不该翻译 |
| **包名**（等宽字体那一行） | `package.json` 的 `name` | ❌ 原样显示（`PluginManagerPage.tsx` 里是 `<code>{pkg.name}</code>`），而且 npm 包名不允许中文，它同时是 `dsh plugin remove <name>` 要用的句柄 |

两个前提，缺一不可：

- `package.json` 的 `exports` 必须放行这个路径（`"./locale/*": "./locale/*"`）——解析走的是 Node 的 ESM resolver，`exports` 不放行就等于没有这个文件（报 `ERR_PACKAGE_PATH_NOT_EXPORTED`，被当成"没配元数据"静默回落）；
- `files` 里要有 `locale`，否则打包/安装时不会带上。

包名 `think_better`、行 id `think-better-tool`、模块名都不用动——显示名和它们是分开的两层。另外 `package.json` 顶层可以放 `icon`（相对路径，SVG/PNG/JPEG/WebP，≤256 KiB），会被内联成 data URL 显示在插件页。

> 元数据在**启动时**读取，改完要**重启**。

---

## 卸载

```sh
dsh plugin --profile <你的profile> remove think_better
```

---

## 本地自测

`lib/index.js` 的两个 harness import 被 `test/stub-loader.mjs` 顶替成桩，所以测试**直接跑线上那个文件**，不需要装 DSH：

```sh
pnpm test        # = node --import ./test/register.mjs test/behaviour.test.mjs
```

覆盖：只注册一个工具、**从不调用 `tools.restrict()`**（可见性归作用域管，插件不该有可见性逻辑）、轮数计数与 `turn/start`/`agent/disposed` 的重置、每会话独立计数、`maxRounds` 行为、三档返回文案。

> 0.2.x 那版测的是「从会话日志推断当前预设 + 解除 deny」；那套逻辑已经删掉了，相应的断言也一起删了。

---

## 已知限制

- `keep_thinking` 的可见性**由作用域决定，不由插件决定**：工具行挂在 `preset-chat` 里，所以只有「更好的对话模式」的 agent 看得见它。插件里没有任何可见性逻辑，也不需要。
- 工具行用**绝对 file URL** 引入，所以换仓库位置、改目录名都要同步改 `cordis.patch.yml` 里那一行。
- **「更好的对话模式」的系统提示词不止人设那 5 行，工具也不止 11 个。** 因为 `persona.prefix` 只遮蔽部署级人设、没设 `complete: true`，harness 的工具引导段落（`read`/`grep`/`glob`/`web_search`/`present` 的用法）会照常注入；**Agent Teams 那一大段 `POLICY` 文字也会进来**。实测一轮下发 **25 个工具**：本 preset 挂的 11 个，加上 agent-team 的 9 个（`spawn_teammate`/`send_message`/`list_agents`/`wait_agent`/`interrupt_agent`/`team_task_*`）、`schedule_*` 4 个、`load_workspace_dependencies` 1 个。
- **这 14 个不是"忘了挂"，是本插件收不掉。** `tool-agent-team` 和 `schedule` 都在 `agent/created` 时把工具注册进 **agent 自己的作用域**（`tool-agent-team/src/index.ts`：`const scoped = agent.ctx`；`schedule/src/index.ts`：`registerScheduleTools(ctx, agent.ctx, agent)`），而 `tools.restrict()` 只能遮蔽**全局**工具——拿作用域内的名字去 restrict 会直接抛 `unknown global tool`。所以「刻意没有挂的」那张表管不到它们，"把 deny 列表做成配置项"也解决不了；要让「更好的对话模式」真的干净，只能在整个 profile 层面不挂 `dsh-experimental-agent-team-profile` / `dsh-experimental-schedule-bundle`（所有模式一起去掉）。这 14 个里只有 `load_workspace_dependencies` 是全局注册。（本插件现在不做任何 restrict，所以这条只是说明"为什么连做成配置项也收不掉"。）
- 已经被旧版本 deny 过的**运行中**会话，需要重启 DSH 后才会恢复（旧版把限制记录在插件内存里；现在改用作用域，重启后天然干净）。
- `tool-fs` **带写权限**。想要只读，把会话权限切到 profile 里的 `read-only` 预设。
- `keep_thinking` 在对话记录里渲染为**通用工具卡片**。想做成定制的"思考"卡片，需要另写一个 Client 插件在 `tool.call.toolview` 槽位注册组件。
- 插件依赖 DSH 内部插件 id（`@deepseek-ai/dsh-*`）。DSH 升级后若某个 id 改名，需要同步更新 `cordis.patch.yml`。

---

## 许可

MIT
