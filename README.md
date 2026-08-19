# WebTest Pilot（测试领航）

> 一个用大模型驱动浏览器的自动化测试 Chrome 插件：用自然语言描述测试，插件自己操作页面完成验证，跑通后固化成可重放的脚本。

**核心思路**：第一次跑用 AI 探索（慢、消耗 token、能应对未知页面），跑通后自动保存成脚本；之后 CI 里重放脚本（快、免费、稳定）。UI 改版导致脚本失效时，再让 AI 跑一次重新录制。

---

## 目录

- [功能](#功能)
- [安装](#安装)
- [第一次使用](#第一次使用)
- [快速开始：测试你正在看的网页](#快速开始测试你正在看的网页)
- [写测试用例](#写测试用例)
- [本地接口（bridge）](#本地接口bridge)
- [在 CI 中使用](#在-ci-中使用)
- [定时测试](#定时测试)
- [飞书通知](#飞书通知)
- [脚本与导出](#脚本与导出)
- [安全设计](#安全设计)
- [工作原理](#工作原理)
- [手工验收清单](#手工验收清单)
- [开发](#开发)
- [已知限制](#已知限制)

---

## 功能

| 能力 | 说明 |
|---|---|
| 接入任意 OpenAI 协议模型 | DeepSeek、豆包/Ark、OpenAI、OpenRouter、Moonshot、通义、硅基流动、智谱、Ollama、LM Studio，或任意兼容端点 |
| 读取页面数据 | 文本、表单结构、表格、属性、选区；结构化快照给模型，而非整页 HTML |
| 填写与修改表单 | 输入框、下拉、复选、单选；正确触发 React/Vue 受控组件的事件 |
| 常用页面操作 | 点击、悬停、按键、滚动、截图、新开/切换/关闭 tab、前进后退 |
| 断言 | 可见性、文本、值、URL、标题、元素数量 |
| 持久化成脚本 | 跑通即自动保存为 JSON 步骤脚本，可导出 Playwright TypeScript |
| 本地接口启动测试 | HTTP(REST) + WebSocket + SSE，带 token 鉴权 |
| 用例传输方式 | 对话直接粘贴、Markdown 文件导入、本地接口传入 |
| 用例管理 | 保存、编辑、删除（可选是否连带删除脚本） |
| 飞书通知 | 自定义机器人 webhook，支持签名校验，失败可 @人 |
| 定时启动 | 基于 `chrome.alarms`，支持间隔与每日定点（可选星期） |

---

## 安装

需要 Node.js 20+ 和 Chrome 116+。

```bash
cd webtest-pilot
pnpm install --ignore-scripts
pnpm build
```

然后在 Chrome 中加载：

1. 打开 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择 `webtest-pilot/dist` 目录
4. 点击工具栏图标打开侧边栏

> `--ignore-scripts` 是因为部分环境下 esbuild 的 postinstall 会因权限失败；跳过它不影响使用。

---

## 第一次使用

打开侧边栏 → **设置**，按顺序配置这三项（前两项是必需的）：

### 1. 模型（provider）

选一个预设，填 API Key，其余会自动带出。例如 DeepSeek：

| 字段 | 值 |
|---|---|
| Base URL | `https://api.deepseek.com/v1` |
| 模型 | `deepseek-chat` |
| API Key | 你的 key |

点「测试连接」。它会额外探测该模型是否支持**工具调用（function calling）**——本插件完全依赖工具调用来操作页面，不支持的模型无法使用。

### 2. 站点白名单（allowed sites）⚠️ 必填

这是本插件**唯一的安全边界**。不配置的话，插件不会对任何页面执行任何操作。

填 glob 模式，一行一个：

```
https://staging.example.com/*
https://*.internal.example.com/*
http://localhost:3000/*
```

出于安全考虑，以下过于宽泛的模式会被拒绝：`*`、`*://*/*`、`https://*/*`、`<all_urls>`。

### 3.（可选）密钥（secrets）

测试登录时不要把密码写进用例。在这里存 `名称 → 值`，用例里只写名称：

```markdown
3. 在密码框填入 secret LOGIN_PW
```

真实值只在后台替换，**不会进入模型请求、对话记录或运行日志**。侧边栏也只能看到名称。

---

## 快速开始：测试你正在看的网页

配好模型和白名单后，测试当前页面只需三步：

1. 在 Chrome 里打开要测的页面，**照常登录、点到你关心的那个状态**（购物车里有商品、表单填了一半，都可以）。
2. 点插件图标打开侧边栏，切到「对话」。
3. 直接说要验证什么，回车。

```
检查页面上的搜索框，输入「订单」后点搜索，
预期结果列表至少出现一条，并且不出现「暂无数据」。
```

插件默认**就在你当前这个标签页上操作**，不新开窗口。这一点很重要：你手动登录的会话、Cookie、页面状态都保留着，所以「测我眼前这个页面」是最省事的用法，不需要先写一遍登录步骤。

不用填 URL。用例里不写地址时，插件就用当前标签页；写了地址才会先导航过去。

> **⚠️ 第一步：先打开一个普通网页**
>
> 如果你在**浏览器新标签页**（`chrome://newtab/`）上直接运行，会报
> `chrome://newtab/ is a browser-internal or Web Store page`。
>
> 这不是配置错了——Chrome 禁止**任何**扩展操作 `chrome://` 开头的页面、扩展页和应用商店页面，这是浏览器的硬性限制。
>
> 两种解法，任选其一：
> - 在当前标签页打开你要测的网站，再回侧边栏运行；
> - 或在用例/对话里写明地址（`- url: https://your-site.com/`），插件会自己导航过去。

### 不只是测试：让它帮你填表、办事

同一套能力也可以直接用来**代你操作页面**，不需要写「预期结果」：

```
把这个报名表填完提交：
姓名 张三，手机 13800138000，邮箱 zhangsan@example.com，
城市选「上海」，勾选同意条款，然后提交。
```

插件会先读出表单结构（有哪些字段、哪些必填、下拉框有哪些选项），再按控件类型正确填写：

| 控件 | 用的工具 |
|---|---|
| 文本框、文本域 | `fill` |
| 下拉框 `<select>` | `select_option` |
| 复选框、单选框 | `set_checkbox` |

几个实用行为：

- **填写会触发框架事件**。用原生 setter + `input`/`change` 事件，所以 React、Vue 这类受控组件能正确收到值，不会出现「看着填上了、提交却是空」。
- **不写「预期结果」时**，把事情做完就算成功，不会强行要求断言。写了预期就必须逐条验证。
- **必填项你没交代的，它会停下来问**，而不是编一个手机号填进去。
- **提交后会确认是否真的成功**（跳转、成功提示、记录出现）——静默的表单校验失败和成功长得一模一样。
- **密码不要写进对话**。先在「设置 → 密钥」里存好，然后说「密码用 secret LOGIN_PW」。

这类「办事」任务同样可以保存成脚本、定时执行、用本地接口触发——和测试用例走的是同一条路。

### 什么时候会新开窗口

| 触发方式 | 在哪运行 | 原因 |
|---|---|---|
| 手动（对话 / 点「运行」） | **当前标签页** | 你要测的就是眼前这个页面 |
| 定时任务 | 独立窗口 | 半夜执行时不能把你正在看的页面导航走 |
| 本地接口（CI） | 独立窗口 | CI 环境下「当前标签页」没有意义 |

想让手动运行也用独立窗口：**设置 → 手动运行时打开独立窗口**。注意开启后是从空白页开始的，登录态不会带过去。

反过来，如果当前所有标签页都是 `chrome://`、扩展页这类浏览器内部页面，插件无法操作，会明确告诉你去打开一个普通网页。

### 截图是按需的，不是每步都截

默认只在**失败时**自动截图——那才是排查问题需要的证据。想全程留痕：**设置 → 每一步都截图**（会明显增加存储占用）。

除此之外，截图是一个**脚本动作**，和点击、填写完全平级：

```json
{ "action": "screenshot", "note": "结算页金额" }
```

你可以在用例里直接要求截图，它会成为脚本的一个步骤，以后每次回放都在同一位置截：

```markdown
## Steps
1. 点击「结算」
2. 对当前页面截图，备注「结算页金额」
```

导出成 Playwright 代码时，这一步会变成：

```ts
await page.screenshot()
```

AI 自己也会在关键节点截图（比如渲染异常、图表这种断言表达不了的视觉状态）。这类临时截图只进本次运行报告，**不会**污染保存下来的脚本——除非明确要求保留。

---

## 写测试用例

### 方式一：直接对话

在「对话」标签里用自然语言描述，插件会解析成用例：

```
测试登录：打开 https://staging.example.com/login，
用 demo@example.com 和 secret LOGIN_PW 登录，
预期能看到「控制台」标题和用户头像。
```

### 方式二：Markdown 文件

格式如下（中英文标题都识别）：

```markdown
# Case: 登录冒烟
- url: https://staging.example.com/login
- tags: smoke, auth

## Steps
1. 在邮箱输入框填入 demo@example.com
2. 在密码输入框填入 secret LOGIN_PW
3. 点击「登录」按钮

## Expect
- 页面跳转到 /dashboard
- 出现「控制台」标题
```

一个文件里可以放多个用例，用 `# Case:` 分隔。中文别名：`## 步骤`、`## 预期结果`、`- 地址：`、`- 标签：`。

### 关于「预期结果」

**请认真写 Expect**。插件会检查模型声称的「通过」是否有对应的断言支撑——如果模型说通过但一次成功断言都没做，这次运行会被判为**失败**。写得越具体，测试越有意义。

---

## 本地接口（bridge）

插件不能监听端口，所以由一个本地 Node 进程提供 HTTP 接口，插件主动连上它。

```bash
npx webtest-pilot serve
```

首次运行会在 `~/.webtest-pilot/config.json` 生成一个 token（文件权限 `0600`）。把它粘贴到插件「设置 → 本地接口」并开启开关，状态会变成「已连接」。

服务只监听 `127.0.0.1`，所有 `/api/*` 请求都需要 `Authorization: Bearer <token>`。

### CLI

```bash
npx webtest-pilot serve [--port N]      # 启动服务
npx webtest-pilot health                # 检查插件是否已连接
npx webtest-pilot cases                 # 列出用例
npx webtest-pilot runs [--limit N]      # 最近的运行记录
npx webtest-pilot run <用例ID或.md文件> --wait [--junit out.xml]
npx webtest-pilot token [--reset]       # 查看/重置 token
```

### REST

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 无需鉴权；报告插件是否连接 |
| GET/POST | `/api/cases` | 列出 / 新增（JSON `{markdown}` 或 `text/markdown`） |
| DELETE | `/api/cases/:id?withScripts=true` | 删除用例 |
| GET | `/api/scripts`、`/api/scripts/:id` | 脚本 |
| POST | `/api/runs` | 启动运行；`wait=true` 时阻塞到结束 |
| GET | `/api/runs`、`/api/runs/:id` | 运行记录 |
| GET | `/api/runs/:id/events` | SSE 实时进度 |
| GET | `/api/runs/:id/artifacts/:id` | 截图（真实 PNG） |
| POST | `/api/runs/:id/cancel` | 取消 |

插件未连接时返回 `503`，并说明需要打开 Chrome 并启用本地接口。

---

## 在 CI 中使用

关键是 `wait=true`：一次请求拿到最终结果，运行未通过时 CLI 以非零码退出。

```bash
npx webtest-pilot serve &
sleep 2
npx webtest-pilot health || exit 1
npx webtest-pilot run ./tests/login.md --wait --timeout 300 --junit results.xml
```

或直接用 HTTP：

```bash
curl -sS -X POST http://127.0.0.1:8787/api/runs \
  -H "Authorization: Bearer $WEBTEST_PILOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"caseId":"case-abc","wait":true,"timeoutSeconds":300}'
```

环境变量 `WEBTEST_PILOT_TOKEN` 和 `WEBTEST_PILOT_URL` 可覆盖配置文件。

> CI 环境需要一个有界面的 Chrome（真实浏览器窗口）。这个插件测的是真实浏览器行为，不是 headless 模拟。

---

## 定时测试

「定时」标签里新建：选用例、选间隔（最小 1 分钟，Chrome 的限制）或每日定点（可选星期）、选通知策略。

两个重要行为：

- **错过的窗口会跳过并记录日志**，不会补跑。电脑睡眠错过凌晨 3 点的任务时，第二天早上 9 点突然跑起来更糟；宽限期是 10 分钟。
- **没配站点白名单时定时任务会拒绝执行**并写日志。这比在无人值守时越界操作要好。

定时运行使用独立的**非聚焦窗口**，不会抢走你正在用的屏幕。

---

## 飞书通知

「设置 → 飞书通知」填自定义机器人的 webhook：

```
https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx
```

如果机器人开启了签名校验，把密钥也填上（签名算法已实现：以 `时间戳\n密钥` 为 HMAC-SHA256 的**密钥**对空消息签名后 base64）。

通知策略：

- `always` — 每次都发
- `failure` — 仅失败时发。**注意**：`error`（工具没跑起来）和 `interrupted`（后台被杀）也会通知，因为「套件根本没跑」和「测试失败」一样需要有人知道；`cancelled`（人为取消）不通知。
- `never` — 不发

卡片颜色区分语义：绿色通过、**红色 failed（被测应用真有问题）**、**橙色 error/interrupted（工具或环境问题，不是应用的锅）**、灰色取消。

> 自定义机器人无法上传图片，所以卡片里的截图是**链接**到本地 bridge 的地址（需要配 `artifactBaseUrl`）；没配就提示去插件运行历史里看。

---

## 脚本与导出

跑通的用例会自动保存成 JSON 步骤脚本（可在设置里关掉）。「脚本」标签里可以：

- 查看每一步的可读描述
- 导出 **JSON**（本插件重放用）
- 导出 **Playwright TypeScript**（脱离本插件，进你现有的 e2e 工程）
- 导出 **Markdown**（评审用）

**选择器策略**：录制时在页面内就地计算一个耐用的选择器，优先级为 `data-testid` > `id` > `name` > ARIA role+名称 > 文本 > CSS > XPath，并额外保存备选链。像 `css-1x2y3z`、`react-select-2-input` 这类构建产物生成的不稳定标识会被降权。

---

## 安全设计

这个插件能读页面、能点按钮、能填表单。以下是为此做的约束：

| 约束 | 原因 |
|---|---|
| 站点白名单是唯一边界，**默认为空且失败即拒绝** | 未配置的安装什么都干不了，比默认放开安全 |
| 拒绝过于宽泛的 glob | `https://*/*` 等于没有边界 |
| 不使用常驻 content script，按需注入 | 不在你所有网页里长期存在代码 |
| 密码框的值永不读取 | 否则会进入模型请求和日志 |
| 密钥值只在后台替换，侧边栏只拿到名称 | 值不进入渲染进程，也不进 React DevTools |
| 导出数据剔除 API Key、密钥值、bridge token | 导出文件常被分享或提交 |
| 导入的定时任务强制为停用 | 导入别人的配置不该立刻开始驱动浏览器 |
| bridge 只监听 `127.0.0.1` + token + Origin 校验 | 防止本机其它进程或浏览器里的恶意页面驱动测试 |
| 自愈（self-heal）默认关闭 | 开启时也只产出「建议的修复」，需人工确认 |
| 只对 `http(s)` 普通页面操作 | 浏览器内部页（`chrome://`、扩展页、应用商店）会被拒绝 |

---

## 工作原理

```
侧边栏 (React)          定时器 (alarms)         本地 bridge (Node)
      │                       │                        │
      └───────────┬───────────┴────────────┬───────────┘
                  ▼                        ▼
            Service Worker ── orchestrator ── storage (唯一真相来源)
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
   脚本重放 (runner)    AI 驱动 (agent + LLM)
        └─────────┬─────────┘
                  ▼
            ChromeDriver ── 按需注入 kernel ── 被测页面
```

几个关键决策：

- **MV3 worker 随时会被回收**（约 30 秒空闲），所以 `chrome.storage` 是唯一真相来源，运行进度每步落盘，`chrome.alarms` 是唯一可靠的定时器。启动时会把上次崩溃留下的 `running` 运行标记为 `interrupted`。
- **注入的 kernel 是单个自包含函数**。`executeScript` 只传递函数源码，闭包变量不会跟过去，所以所有辅助函数都必须嵌套在内部——有一条测试用 `new Function(runOp.toString())` 专门守住这条约束。
- **`ref` → 选择器是无状态的**。快照给元素编号 `e1..eN`，同时在页面内就地算出耐用选择器；页面侧不保留任何状态，worker 被回收也不影响。
- **只对「没找到元素」重试**。有副作用的步骤（点击、提交）绝不重复执行——宁可失败也不能重复下单。
- **`failed` 与 `error` 全程分开**。前者是被测应用没达到预期（真发现了问题），后者是工具没能完成（环境/配置问题）。这个区分一直保留到飞书卡片。

---

## 手工验收清单

自动化测试覆盖了逻辑，但以下几项必须在真实 Chrome 里手工确认：

- [ ] **加载插件**：`chrome://extensions` 加载 `dist`，无报错；点击图标能打开侧边栏
- [ ] **配置模型**：填 key 后「测试连接」成功，并正确报告是否支持工具调用
- [ ] **白名单拦截**：不配白名单直接运行 → 明确拒绝并说明原因；填 `https://*/*` → 被拒绝
- [ ] **AI 首次跑通**：用一个真实登录页，AI 能完成填表、点击、断言，侧边栏能看到工具调用过程
- [ ] **脚本自动保存**：通过后「脚本」标签出现新脚本，步骤描述可读
- [ ] **脚本重放**：再次运行走脚本模式，明显更快且不消耗 token
- [ ] **越界拒绝**：让用例访问白名单外的域名 → 运行以拒绝结束，不是静默跳过
- [ ] **密钥不泄漏**：用 `secret X` 登录成功后，检查运行日志和步骤详情里没有明文
- [ ] **截图**：失败步骤自动截图，在运行详情里能看到；缩放（dpr≠1）下裁剪位置正确
- [ ] **默认测当前页**：手动运行时**不新开窗口**，就在你打开的那个标签页上操作；登录态保留；运行结束后你的标签页**不会被关掉**
- [ ] **按需截图**：默认只有失败步骤有截图；在用例里明确要求「截图」时，该步骤出现在保存的脚本里，重放时同一位置再次截图
- [ ] **独立窗口**：定时任务（或手动运行 + 打开该开关）时，新窗口不抢焦点，运行结束后自动关闭（失败也要关闭）
- [ ] **取消**：运行中点取消，当前步骤结束后停止，状态为 `cancelled`
- [ ] **worker 回收**：运行中在 `chrome://extensions` 点「停止」service worker，重新打开侧边栏 → 该运行显示为 `interrupted` 而非一直「运行中」
- [ ] **bridge**：`npx webtest-pilot serve` 后粘贴 token → 状态「已连接」；`health` 报告正常
- [ ] **bridge 鉴权**：不带 token 请求 `/api/cases` → 401；带错误 token → 401
- [ ] **bridge 未连接**：关闭 Chrome 后请求 `/api/runs` → 503 且提示可操作
- [ ] **CI 模式**：`run <case> --wait` 在失败用例上以非零码退出
- [ ] **SSE**：`curl -N http://127.0.0.1:8787/api/runs/<id>/events` 能看到实时进度且在结束时断开
- [ ] **定时**：建一个 1 分钟间隔的任务，确认按时触发；停用后不再触发
- [ ] **错过窗口**：把系统时间往后调或让电脑睡眠跨过定点，确认日志里是「跳过」而不是补跑
- [ ] **飞书**：「发送测试消息」到达群里；真实失败的卡片是红色且包含失败步骤
- [ ] **飞书签名**：开启签名校验的机器人也能收到（这是最容易配错的一项）
- [ ] **导入导出**：导出的 JSON 里搜不到 API Key / 密码 / token；导入后定时任务是停用状态
- [ ] **深色模式**：系统切到深色，侧边栏可读
- [ ] **窄侧边栏**：不出现横向滚动条，长 URL 正确截断

---

## 开发

```bash
pnpm dev          # Vite 开发模式（改完在 chrome://extensions 点刷新）
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest
pnpm build        # 产出 dist/
```

代码结构：

```
src/
  lib/          纯逻辑，无 Chrome 依赖，可单测
    selectors   选择器计算与打分
    urlmatch    白名单匹配（安全边界）
    providers   模型预设
    llm         OpenAI 协议 + SSE 解析
    ops         注入内核的操作类型
    types       领域模型
    script      脚本校验与导出
    markdown    用例解析/渲染
    storage     持久化（带写队列）
    artifacts   截图（IndexedDB）
    protocol    bridge 线上协议
    messages    侧边栏↔worker 协议
    feishu      通知
    time        定时计算
  inpage/
    kernel      注入页面的单一自包含函数
  background/
    driver      Driver 接口（可替换成 FakeDriver 做单测）
    driver.chrome  真实 Chrome 实现
    runner      脚本重放
    agent       工具定义、提示词、快照渲染、结论校验
    orchestrator   运行生命周期
    recorder    录制成脚本
    scheduler   定时
    bridge      bridge 客户端
    index       service worker 入口
  panel/        React 侧边栏
bridge/         本地 Node 服务 + CLI
tests/          vitest
```

测试用 `FakeDriver` 替换真实浏览器，所以 runner 和 agent 的逻辑（含重试、超时、断言判定）都能在没有 Chrome 的情况下验证。当前 **767 个测试**，其中 bridge 的 94 个是真实集成测试（真起服务 + 真 WebSocket 客户端模拟插件）。

三条最关键的安全保证都做了「变异测试」验证——故意破坏实现后，对应测试确实会失败：

| 保证 | 破坏后失败的测试数 |
|---|---|
| 注入内核不依赖闭包（`new Function(runOp.toString())`） | 5 |
| 站点白名单失败即拒绝（`checkUrlAllowed`） | 5 |
| 声称通过必须有断言支撑（`validateVerdict`） | 2 |

---

## 已知限制

- **不支持文件上传**：`<input type="file">` 无法通过脚本注入赋值，这是浏览器的安全限制。
- **整页截图可能退化为可视区域**：`captureVisibleTab` 只能拍可视区域，超长页面的拼接不总是可靠。
- **只支持普通 http(s) 页面**：浏览器内部页面无法注入。
- **飞书卡片无法内嵌图片**：自定义机器人不支持上传图片，只能给链接。
- **需要有界面的 Chrome**：不是 headless 方案。
- **iframe 支持有限**：会在所有 frame 中查找并挑选最合适的结果，但跨域 iframe 的复杂场景可能需要手工调整选择器。
- **定时最小间隔 1 分钟**：Chrome 对已发布扩展的 alarm 限制。
