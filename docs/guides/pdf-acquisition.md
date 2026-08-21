# PDF 获取指南

SciRetriever 对数据库中已经存在的 Literature 执行 PDF 补全。主题发现和引用发现只接纳
元数据，不会顺带下载全文。自动获取固定按风险从低到高推进：

```text
Public
  -> Authorized Provider API
  -> Controlled Headed Browser
```

前一层正常结束后仍缺 PDF 的文献才会进入下一层；一条路线成功提交主 PDF 后立即停止。网络
超时、临时服务错误、`429`、quota 或 `Retry-After` 不会被解释成“这条路查不到”，也不会借机
切换 Browser 绕过限制。

## 1. 当前支持矩阵

### Public 与授权 API

| 层 | 当前生产能力 | 配置或适用条件 | 主要边界 |
| --- | --- | --- | --- |
| Public | 已保存的 direct/landing `AssetHint` | 当前 Literature 已有来源明确的 locator | URL、redirect、媒体类型和实际 PDF 字节仍重新检查 |
| Public | arXiv、Europe PMC、Unpaywall | 在 `[sources.acquisition].providers` 启用；Unpaywall 另需联系邮箱 | 正常未命中才继续下一条路线 |
| Public | Metadata Provider 提供的公开 locator | Metadata adapter 先形成 `AssetHint` | locator 不等于 PDF，仍由通用 Public route 获取和验证 |
| Public | Configured Sci-Hub operator locator | 只有 Python 调用方显式注入中性 resolver 时才 ready | stock CLI 不提供 endpoint、resolver 或凭据配置 |
| Authorized API | CORE API v3 | 启用 `core`、配置 `api_key`，并有 CORE `work:`/`output:` 强身份 | 有 key 不等于当前记录或文章可下载 |
| Authorized API | Elsevier Article/Object Retrieval | 启用 `elsevier`、配置 `api_key`；可选 `institution_token`；需 PII、Article EID 或已确认 landing | MAIN PDF object 优先；XML、supplement 和任意 object 不冒充主 PDF |
| Authorized API | Wiley TDM API v1 | 启用 `wiley`、配置 `tdm_api_token`，且 DOI 安全落地到 Wiley Online Library | token 被配置、API 接受 token 和当前文章有权限是不同事实 |
| Authorized API | Springer | 无主 PDF API route | 当前 Full Text 产品提供 JATS/XML，不把它冒充 PDF |

### Controlled Browser

Browser 只为已经通过生产准入的访问平台执行专用规则，不对未知站点做通用 fallback：

| Access key | 规则 | Risk/session group | 同组最小文章启动间隔 | 当前定位 |
| --- | --- | --- | ---: | --- |
| `acs-publications` | `acs-publications-pdf@2` | `acs-publications` | 30s | ACS landing/PDF 与 Supporting Information 排除 |
| `aip-publishing` | `aip-publishing-pdf@2` | `aip-publishing` | 30s | AIP article/ePDF 与 supplement 排除 |
| `elsevier-sciencedirect` | `sciencedirect-pdf@2` | `elsevier` | 20s | ScienceDirect/linkinghub landing、PII/DOI 和批准的 PDF CDN |
| `iopscience` | `iopscience-pdf@2` | `iopscience` | 30s | IOPscience article/PDF 与 supplement 排除 |
| `oxford-academic` | `oxford-academic-pdf@2` | `oxford-academic` | 30s | Oxford Academic article/PDF 页面 |
| `rsc-publishing` | `rsc-publishing-pdf@2` | `rsc-publishing` | 30s | RSC article/PDF 与 ESI 排除 |
| `science-aaas` | `science-aaas-pdf@2` | `science-aaas` | 30s | Science / AAAS article/PDF 页面 |
| `springerlink` | `springerlink-pdf@5` | `springerlink` | 10s | Springer Nature Link landing、官方 PDF locator 与延迟 native download |
| `wiley-online-library` | `wiley-online-library-pdf@2` | `wiley` | 20s | Wiley/advanced DOI landing 与 article/PDF 页面 |

“生产准入”表示访问画像、专用规则、访问政策、离线页面 fixture、生产对象图与安全测试已经闭环；
它不表示选中的 Browser Profile 已登录、当前机器 IP、用户所在机构或任意文章已经在线验证有权限。

九家 route 都通过相同的 production 工程准入。普通使用条款、robots 或交付政策仍可能限制实际
用途，operator 必须自行确认组织授权；`browser_enabled` 只启用受控尝试，不是许可证明。真实
页面的付费墙、裸 403、challenge、限流和正文捕获会分别报告，不能由本地布尔字段预先代替。

## 2. Browser 实际怎样获取 PDF

一篇文献进入 Browser 前，Acquisition 必须先用安全解析后的 DOI landing、访问方自己的
AssetHint origin、稳定文章 ID 或 Provider record identity 确认访问平台。出版社自由文本、元数据
来自哪家供应商或单独 DOI prefix 都不能独自启动 Browser。需要解析 DOI 时，Python HTTP 只向
`doi.org` 发出不跟随 redirect 的第一跳 `GET` 并读取 `Location`；它不会解析或请求 Publisher
目标，Publisher 页面等到 Browser lane 获得 permit 后才由 Chrome 访问。

每次文章流程按以下边界执行：

1. 检查 Browser 总开关、选中的 Profile 是否安全存在、production rule、Playwright、
   Chrome/Chromium、headed display、对应风险组政策与当前 circuit；
2. 使用当前机器正常网络出口和选中的持久 Profile，启动或复用本次对象图唯一的有头
   Chrome/Chromium process/persistent context，并为当前文章创建隔离 page；无 GUI Linux 由
   Xvfb 提供虚拟显示；
3. 从规则批准的 landing 或官方 locator 导航；Chrome 原生完成 TLS、HTTP、Cookie、redirect、
   页面脚本和点击，Playwright 对它暴露的每个请求在继续前重新检查 URL、origin、DNS、精确 IP
   binding、Host admission 和资源预算；native redirect 的后续成员若未再次暴露 request，只能凭
   同页仍存活的祖先请求、已批准并预绑定的最终 origin 和最终 host admission 继续关联；loopback
   CONNECT proxy 只透传加密字节，不终止 TLS；
4. 允许规则内同源或明确批准 origin 的 CSS/JavaScript 等页面资源；未批准的第三方 tracker 在
   DNS 前丢弃，但不会仅因此让整篇文章失败；
5. 先检查已有 capture 和页面状态，再从 citation metadata、正文/PDF 链接及
   iframe/embed/object 做通用 PDF 发现；最多接收 16 个 locator，只尝试前 4 个已经过 origin、
   guard、DNS prebinding 与去重的候选；
6. 仍未捕获时执行版本化规则中有限的点击、viewer 或等待动作；点击和 capture wait 各自最多
   局部等待 10 秒，按钮不可操作或局部未捕获是正常未命中，整篇 60 秒截止到期才是 timeout；
   Chrome 原生 redirect 与页面脚本导航仍受同一批准边界；
7. 从 native download event、PDF response、批准的 popup/viewer、跨 origin CDN 或 HTTP attachment
   捕获候选，并在读取正文前排除 supplement、错文和不属于当前文章的文件；
   短期签名 query 只在当前 Browser operation 内交给 Chrome，不进入日志、结果或 provenance；
8. 对候选执行统一的实际 PDF 字节、reader、页面树和至少一页检查，再以不可变方式提交唯一
   `primary-pdf`；
9. 无论成功、未命中、失败、取消或超时，都清理 page、download、response 和文章临时目录。

所有 `browser_session_key`/Publisher lane 共享一个 Chrome process 和 persistent context；
`browser_session_key` 只标识调度 lane，不再标识独立浏览器身份。Broker 关闭或进程退出后会
关闭 process/context、Xvfb、CONNECT proxy 并删除文章临时下载目录，但保留 Profile 中由 Chrome
管理的 Cookie、Local Storage、IndexedDB、SSO 状态、偏好和历史。每篇文章的 token、page、
handler、连接绑定和预算仍严格隔离。自动运行时的“有头”只表示使用真实浏览器窗口栈；用户
只有从配置中心显式选择可见 Browser 动作时才会看到并操作窗口。SciRetriever 不填写登录凭据、
不选择机构、不读取登录结果，也不处理/绕过 MFA、CAPTCHA 或 challenge。

## 3. 启用、状态与显式探测

先在当前项目配置中启用 Browser：

```bash
sciretriever config
# Provider API and Browser Access
# 1. Select or initialize a Browser profile
# 2. Optional: open a visible Browser only when a Provider requests login
```

或在普通配置中明确设置：

```toml
[access]
browser_enabled = true
browser_profile = "institutional-access"
browser_max_concurrency = 5
browser_policy_overrides = []
```

建议通过交互配置中心选择和初始化 Profile，不要手工创建 Profile 目录。`browser_profile` 只接受
不含敏感信息的 identity，不接受路径、账号、机构名、URL、UUID、Token 或 Cookie 标签。真实
Chrome 状态保存在固定 owner-only 目录，与 `credentials.toml` 分离。同一 Profile 同时只能由
一个 Chrome process 使用；自动 Completion、显式 probe 和可见 Browser 登录窗口互斥。

`browser_max_concurrency` 必须是大于 1 的整数，默认值为 5，不设置上限。它是跨 Publisher 的
本机资源 cap：Publisher lane 只在有任务时进入调度，所有 lane 共享一个 Chrome process/context；
同一 Publisher 仍固定串行并遵守自己的间隔、窗口、cooldown 和熔断策略。当前 `9` 条 production
route 只是当前 catalog 数量，不是该配置的最大值；例如未来 Publisher 数量增加时可以直接配置
更大的整数。

不需要再为单个 Publisher 填写“机器访问许可”占位字段。开启总开关后，当前 9 条 production
route 都可以在各自的串行限速 lane 中进行逐文章 Profile/IP 尝试；成功、明确付费墙、裸 403、
challenge、限流和无正文会分别报告。总开关、Profile 存在或其中有浏览器状态只允许程序启动
这些受控尝试，不证明组织合同、认证成功、当前 IP 或具体文章具有 entitlement。

Playwright 是 wheel 的运行依赖；Chrome/Chromium executable 与 headed display 也必须可用。
可用系统 Google Chrome，或在 SciRetriever 环境中安装 Playwright Chromium：

```bash
playwright install chromium
```

无 GUI Linux 还需安装 `Xvfb`。SciRetriever 会在共享 Chrome runtime 启动时按需启动虚拟显示，
runtime 关闭后停止它；自动 Completion 不需要桌面环境。可见 Browser 登录动作则要求用户能够
看到并操作真实显示，纯 SSH/Xvfb 环境本身不会提供可交互窗口。

查看纯本地状态：

```bash
sciretriever config status
sciretriever config status --json
```

状态页会分别显示 9 条 production route、9/9 条本地可尝试 route、总开关、选中的 Profile
identity 及 `missing/configured/attention` presence、Playwright package、Chrome/Chromium
executable、headed display/Xvfb、跨组本机并发上限和各组政策。
`automatic_acquisition_available = true` 只表示这些本地执行条件齐备；
`article_entitlement = checked-per-article` 表示 Profile/机构 IP 和具体文章权限仍须在真实文章响应
中判断。`config status` 不启动 Browser、不访问出版社、不读取 Profile 内容，也不判断已登录。

需要诊断 runtime 与首页可达性时，每次显式选择一个目标：

```bash
sciretriever config test --browser acs-publications
sciretriever config test --browser aip-publishing
sciretriever config test --browser elsevier-sciencedirect
sciretriever config test --browser iopscience
sciretriever config test --browser oxford-academic
sciretriever config test --browser rsc-publishing
sciretriever config test --browser science-aaas
sciretriever config test --browser springerlink
sciretriever config test --browser wiley-online-library
```

Browser 启用且 runtime 就绪后，九家都可以成为单目标 probe；首页可达不代表文章有权限，probe
也不允许下载正文。

Probe 使用所选供应商的 risk-group scheduler，最多导航一次，只检查有头 Chromium 是否启动以及规则
首页是否可达；它不打开文章、不下载 PDF、不评估 Profile 是否已登录、机构 IP 或文章权限，结果固定
`article_entitlement = not-proven` 且不持久化。`config test --all` 永远不会隐式执行 Browser
probe。

## 4. 批次、限速与预计时间

`complete pdf` 先冻结目标，再按 cohort 推进：

1. 对全部目标完成 Public pass；
2. 用新 landing、稳定文章 ID 和 route hint 重新识别访问方；
3. 只对剩余目标完成 Authorized API pass；
4. 再次规划，把允许升级的最小剩余集合交给 Browser admission。

普通 HTTP 和官方 API 按各自服务的真实 quota scope 执行，不继承 Browser 的文章级间隔。
Browser 则满足：

```text
供应商之间并行
同一 browser_rate_limit_group 内 concurrency = 1，并按该组间隔串行
```

例如 Elsevier、SpringerLink 和 Wiley 可以在本机全局 cap 允许时彼此并行；同一组的下一篇必须
等待上一篇启动间隔和适用 cooldown。`browser_max_concurrency` 只限制同时活动的不同风险组，
不能提高任何组内并发。普通配置中的 policy override 只能延长间隔、缩小窗口或加强冷却，不能
放宽生产基线。

Browser admission 日志会在触网前报告剩余篇数、并行组数、各组
`minimum_start_interval`、`next_allowed_in_seconds` 和保守 `minimum_duration_seconds`。跨组总
下界取最慢组，而不是把各组相加；它不包含不可预测的 DNS、页面渲染、下载或外部服务等待。

## 5. 失败、暂停与重跑

| 用户看到的情况 | 实际含义 | 当前处理 |
| --- | --- | --- |
| 公开来源查不到 | 已知公开链接或仓储没有交付有效主 PDF | 继续授权 API，再视条件进入 Browser |
| API 对该文章没有 PDF/权限 | 官方 API 正常回答，但没有可用主 PDF | 其它低风险路线结束后可以进入 Browser |
| API 未配置 | 当前支持的官方路线缺凭据 | 明确报告，不用 Browser 静默掩盖配置问题 |
| 网络超时、服务暂时不可用 | 不是“查不到” | 可重试失败或延期，不立即切 Browser |
| `429`、quota、`Retry-After` | 供应商要求减速或等待 | 更新共享冷却，不用 Browser 绕过 |
| Browser 页面没有全文权限/paywall | 当前 Profile/IP 对这篇文章没有被页面放行 | 正常未命中；可手动提供 PDF |
| Browser 返回普通 `403` | 当前文章被拒绝，但仅凭状态码不知道是何种权限原因 | 归为文章级访问拒绝并提示处理；不冒充明确 paywall，也不熔断整个 Publisher |
| 页面要求登录、机构选择或 MFA | 自动流程不会代替用户认证 | 暂停/熔断该组；在配置中心显式打开同一 Profile 的可见 Browser，自行完成获授权的交互后重试，或改用 API/手动 PDF |
| 页面要求 CAPTCHA/challenge | 自动流程不会处理或绕过验证 | 暂停/熔断该组；按站点要求由用户决定后续，不自动重试制造流量 |
| IP block、账号警告 | 供应商明确阻止继续访问 | 熔断该组；其它供应商组仍可继续 |
| Browser runtime 或资源清理失败 | 本机 Chromium 流程没有安全结束 | 系统失败并阻止同组继续，不写成“查不到” |
| Ctrl+C | 用户受控中断 | 清理未交付资源；重跑从数据库 current facts 继续 |

只有所有适用自动路线都正常结束，且不存在延期、待处理动作、配置或清理错误时，系统才提交
`NoPrimaryPdf`。后续 Parser/LLM 失败不会撤销已经安全提交的 PDF。

常用命令：

```bash
sciretriever complete pdf --all-pending --json
sciretriever --debug complete pdf --all-pending --json
```

正常结果写 stdout，进度与日志写 stderr。正常日志保留 tier、Browser 分组/等待、交付、耗尽和
带 `code/retryable/reason/action` 的稳定失败；Debug 额外显示 route 的
`disposition/next/elapsed`、Browser eligible/admitted/attempted/delivered、queue wait、session
reuse、页面状态、capture 分类和 cleanup。日志不输出 secret、Cookie、完整 URL、selector、
Profile 路径/内容、登录状态细节或 PDF 字节。

## 6. 使用责任

按 Provider 政策限速、同风险组串行和 challenge 熔断能降低误用与封禁风险，但不能保证机构
访问或公网 IP 永远不受限。用户必须自行确认文献访问授权并遵守机构、出版社和站点的适用规则。
SciRetriever 不自动登录、不读取用户在可见 Browser 中输入的内容、不处理或绕过 CAPTCHA/MFA，
也不通过代理轮换、指纹规避或备用入口绕过限速与拒绝。Profile 只是由 Chrome 管理的本地身份
容器，不是组织合同、登录成功或文章授权证明。
