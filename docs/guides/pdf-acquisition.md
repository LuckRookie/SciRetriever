# PDF 获取指南

SciRetriever 对数据库中已经存在的具体 Literature 补全主 PDF。主题发现和引用发现只接纳元数据，
不会顺带下载全文。自动获取固定按风险从低到高推进：

```text
Public
  -> Authorized Provider API
  -> Controlled Browser Agent
```

前一层正常结束后仍缺 PDF 的文献才进入下一层；任一路线成功发布主 PDF 后立即停止。网络超时、
临时服务错误、`429`、quota 或 `Retry-After` 不会被解释成“没有 PDF”，也不会触发备用路线绕过。

## 1. 当前获取路线

| 层 | 当前生产能力 | 主要条件 |
| --- | --- | --- |
| Public | 已保存的 direct/landing `AssetHint` | URL、redirect、媒体类型和实际 PDF 字节全部重新检查 |
| Public | arXiv、Europe PMC | Acquisition Auto 默认启用；Custom 时按精确列表选择 |
| Public | Unpaywall | Custom 启用并配置联系邮箱 |
| Public | Configured Sci-Hub locator | 默认关闭；显式启用、Literature 有 DOI，并使用 builtin 或 custom 镜像 |
| Authorized API | CORE API v3 | 启用 `core`、配置 `api_key`，并有 CORE 强记录身份 |
| Authorized API | Elsevier Article/Object Retrieval | 启用 `elsevier`、配置 `api_key`，并有 PII、Article EID 或确认过的 landing |
| Authorized API | Wiley TDM API v1 | 启用 `wiley`、配置 `tdm_api_token`，且 DOI 安全落地到 Wiley |
| Controlled Browser | `browser:generic` | 低风险路线结束、具有安全文章起点，并且 Browser/Model/Profile/runtime 均就绪 |

Springer 当前全文 API 产品返回 JATS/XML，不是主 PDF API。Provider key 已配置、认证成功和单篇
文章有全文权限始终是不同事实。

### Configured Sci-Hub

通过 `sciretriever config` 的 `Download → Sources → sci-hub` 管理镜像，或直接编辑普通配置：

```toml
[sources.acquisition]
mode = "custom"
providers = ["sci-hub"]

[sources.acquisition.sci-hub]
urls = [
  "https://mirror-one.example",
  "https://mirror-two.example/base",
]
```

只把 `sci-hub` 加入 providers 时使用当前版本 builtin mirror set；custom `urls` 一旦存在就完整覆盖
builtin。镜像按顺序而非并发尝试，不自动发现，也不接受 Key、Cookie、session、代理或 selector。
每个 landing/PDF 继续经过共享 Network 和统一 PDF 验收。operator 必须自行确认适用法律、机构政策、
内容许可与服务条款。项目测试只使用保留域名、fake transport 和 fixture，不访问真实 Sci-Hub。

## 2. Controlled Browser 怎样工作

Controlled Browser 不再包含 Publisher-specific 点击规则。生产对象图只有：

```text
route       browser:generic
controller  AgentBrowserController
policy      browser-generic
runtime     one fixed-profile CloakBrowser process/context
```

Acquisition 从已接纳的 AssetHint 或 DOI safe resolve 形成安全 canonical landing。未知 Publisher 只要
起点通过 Network admission，也可以进入通用 Browser；Publisher profile 不再决定下载资格，只可为
用户显式配置测试提供首页可达性目标。

一篇文章的交接顺序是：

1. Acquisition 形成 `ArticleGoal`，包含文章 token、DOI/标题/作者线索、canonical landing 和安全
   asset hint，不包含 Cookie、secret、签名 query 或 Browser 对象。
2. Network 打开 article-local page，等待页面、frame、popup/viewer 和截图形成同一代稳定
   `BrowserObservation`。加载或页面交接尚未稳定时不会调用模型。
3. Agent 每次只根据一份稳定 Observation 返回一个动作：`ClickElement`、`ClickPoint`、
   `ScrollSurface`、`GoBack`、`WaitForChange` 或 `Stop`。
4. Network 在执行前复核 article、revision、surface 和坐标/元素绑定；过期动作不会落到新页面。
   一次 `apply` 最多执行一个 vendor action，然后等待新的稳定 Observation 或终态。
5. response、native download 和 popup/viewer 可以产生候选捕获，但 capture 本身不是成功。Agent 已
   开始探索后，候选不会把当前 loop 变成 terminal；Browser 保留本次 `BrowserCaptureBatch`，直到
   Agent `Stop`、预算或硬故障结束，再交给 Acquisition。Acquisition 验证实际 PDF 字节、标准
   reader、至少一页页面树，以及 DOI、标题、作者和受控起点等文章归属证据；supplement、冲突 DOI、
   错文和证据不足均拒绝。
6. 只有通过两道验收的候选才以不可变方式发布为唯一 `primary-pdf`。成功、失败、取消或超时后，
   page、handler、临时下载、permit 和运行资源都必须确定性清理。

Agent 不取得 Page/Context、Cookie、Profile、CDP、任意 URL、selector、JavaScript、文件系统或
数据库。它负责“当前稳定页面下一步做什么”；Network 负责“动作是否仍有效并真实执行”；
Acquisition 负责“捕获物是否是目标文章的主 PDF”。

Challenge、登录要求、MFA、无权限、拒绝和未找到都只是普通 `page_state` 描述，不会自动终止 Agent。
Agent 可以用同一六种动作处理当前页面的可见控件，但产品不自动填写登录凭据、选择机构、处理 MFA、注入 CAPTCHA
solver/token 或切换身份/出口。固定 32 次模型决策 safety fuse 只防止实现无限运行，不会被当作
“没有 PDF”。

## 3. 配置与显式测试

推荐使用交互配置中心：

```bash
sciretriever config
# Models → Add: 配置一个 image = true 的 Model
# Browser → Setup: 选择 Model、Profile 和本机资源 cap
# Browser → Runtime: 显式安装或核实 pinned CloakBrowser binary
```

对应普通配置为：

```toml
[browser]
model = "openai/operator-selected-browser-model"
enabled = true
profile = "institutional-access"
max_concurrency = 5
policy_overrides = []
```

`model` 必须引用已经配置且 `image = true` 的完整 `provider/model`；reasoning、image 与 stream 属于
Model 自身，不在 Browser 覆盖。`profile` 是不含敏感信息的 identity，不是路径、账号、机构名、
URL、UUID、Token 或 Cookie 标签。真实 Chromium 状态留在 owner-only Profile 中。

`max_concurrency` 是本机资源 cap，默认 5、必须大于 1；当前 `browser-generic` 自身始终并发 1，
所以提高 cap 不会并行处理多篇 Browser 文章，也不会启动多个 Browser。`policy_overrides` 只接受
`rate_limit_group = "browser-generic"`，并且只能延长间隔、缩小窗口或加强冷却，不能放宽基线。

查看纯本地状态：

```bash
sciretriever config status
sciretriever config status --json
```

状态页显示 Browser Model、固定 Profile、CloakBrowser wrapper/binary、Playwright API、headed
display/Xvfb、唯一 `browser:generic` route 和 `browser-generic` policy。它不启动 Browser、不读取
Profile 内容，也不证明已登录或文章有权限。

Model probe 使用合成 1×1 图片和封闭工具，不访问 Publisher：

```bash
sciretriever config test browser model
```

Publisher site probe 只检查明确目标的首页可达性，不是下载 route，也不打开具体文章或接纳 PDF：

```bash
sciretriever config test browser site acs-publications
sciretriever config test browser site elsevier-sciencedirect
sciretriever config test browser site springerlink
```

可用 access key 由当前 Publisher profile 的 `browser_probe_enabled` 声明。它们都复用通用 runtime 与
deny-all capture policy；probe passed 仍固定表示 `article_entitlement = not-proven`。

## 4. 结果、失败与重跑

| 情况 | 含义与处理 |
| --- | --- |
| Public 正常未命中 | 继续 Authorized API，再视条件进入 Browser |
| API 未配置或认证失败 | 明确失败；不由 Browser 静默掩盖 |
| timeout、临时错误、`429`、quota | 延期或失败；不写自动获取耗尽 |
| Browser 尚在加载或换页 | Network 等待稳定 Observation；不会让 Agent 操作半加载页面 |
| stale action | 不执行旧动作，返回新稳定 Observation |
| 登录/MFA/无权限/拒绝/未找到 | 作为 page state 交给 Agent；只有 Agent Stop 或硬故障后才形成对应稳定结果，不冒充 PDF miss |
| 页面无语义变化、重复动作或短暂不变 | 继续等待/观察，不生成 `no-progress` 终态 |
| Candidate timeout | 一次内部等待未收敛；Network 隐藏候选状态并把控制权交还 Agent，最终仍无 capture 且 Agent 停止时才作为 `capture-timeout` 失败处理 |
| 捕获到非 PDF、supplement 或错文 | Acquisition 拒绝并清理，不发布主资产 |
| 归属证据不足 | 拒绝或延期，不让模型自行宣布成功 |
| runtime/cleanup failure | 系统失败并熔断 `browser-generic`，不写自动获取耗尽 |
| Ctrl+C | 受控清理；重跑重新读取数据库 current facts |

只有全部适用自动路线都正常结束，且不存在 deferred、action-required、配置、Network、权限或清理
错误时，系统才提交 `NoPrimaryPdf`。后续 Parser/LLM 失败不会撤销已经发布的 PDF。

常用命令：

```bash
sciretriever complete pdf --all-pending --json
sciretriever --debug complete pdf --all-pending --json
```

正常结果写 stdout，进度与日志写 stderr。Debug 会额外记录安全的 Observation、动作、receipt、
capture/identity 验收和 cleanup 线索；实际发给 Agent 的图片保存在系统临时目录
`sciretriever-agent-debug-*`，并用 `manifest.ndjson` 对齐调用序号。图片、prompt、页面正文、完整 URL、
Cookie、Profile 路径和 PDF 字节不会进入 Catalog、仓库或普通日志。
