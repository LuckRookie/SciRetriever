# ADR 0023：通用 Browser Agent 执行器

- Status: Accepted
- Date: 2026-09-06
- Supersedes: none
- Amends: [ADR 0015](0015-publisher-aware-tiered-pdf-acquisition.md)、[ADR 0016](0016-cloakbrowser-fixed-identity-runtime.md)、[ADR 0017](0017-shared-agents-and-controlled-browser-agent.md)、[ADR 0021](0021-provider-model-registry-and-direct-task-selection.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[Acquisition 技术文档](../technical/acquisition.md)、[Network 技术文档](../technical/network.md)、[PDF 获取指南](../../guides/pdf-acquisition.md)

## 背景

受控 Browser 最初同时包含两套页面策略：本地 Publisher-specific rule 和 Browser Agent。规则
拥有 selector、locator、origin、页面状态、capture 发现、限速组与会话组；Agent 虽然能看图并
选择动作，却仍要先通过 Publisher profile/rule 准入。结果是新增或变化的网站仍需为其编写规则，
Browser 的通用性由站点 catalog 决定，且 Rules、Agent、Network settlement 与 Acquisition PDF
验收形成多套重叠状态机。

产品引入 Browser Agent 的核心目的，是让模型在受控动作集合内理解不同页面，而不是让模型调用
一套持续增长的站点脚本。程序仍必须掌握确定性边界：何时页面稳定、动作是否精确绑定、是否真的
捕获文件、文件是不是 PDF、PDF 是否属于目标文章，以及资源何时安全清理。

## 决策

### 1. Browser 只有一条通用执行路线

生产对象图只注册 `browser:generic`。它使用全局 `browser-generic` policy group、用户选择的唯一
Browser Profile，以及唯一 `AgentBrowserController`。配置不再包含 `rules | agent` 选择，不存在
规则失败后切换 Agent 或 Agent 失败后回退规则。

Browser 保持在 Public → authorized API → Browser 的最后一层。拥有合法文章起点的目标可以进入
通用 Browser，不要求先解析为 catalog 中的 Publisher，也不要求存在站点规则。合法起点来自已经
接纳的 landing/direct `AssetHint`，或包含 DOI 且已经安全解析的 landing；Publisher 自由文本不能
单独创建起点。

### 2. Publisher profile 不拥有 Browser 页面程序

`PublisherAccessProfile` 继续服务 Public/API route、访问方识别、稳定 origin/identifier 证据和
可选配置探测。其 Browser 字段只剩 `browser_probe_enabled`，表示该访问方是否有一个显式、只读、
不下载 PDF 的可达性 probe。

Profile 不再拥有 Browser route key、selector/locator、rule revision、allowed origins、risk/rate
group、session key、页面状态或正文点击流程。`production-ready` 是整个访问画像的工程状态，不再
表示该 Publisher 拥有 Browser 下载实现。未知 Publisher 也可走 `browser:generic`；最终是否属于
目标文章由 Acquisition 的统一 PDF 验收决定。

### 3. Agent 决定页面策略，Network 决定动作事实

Acquisition 从当前 Literature 事实形成有界 `BrowserArticleGoal`：DOI、标题、作者以及已经准入的
landing/asset origins。每次模型调用只接收这份目标、当前稳定 `BrowserObservation` 和一张当前
截图，并且必须选择以下一个动作：

```text
ClickElement | ClickPoint | ScrollSurface | GoBack | WaitForChange | Stop
```

Agent 不获得 selector、任意 URL、脚本、文本输入、Page/Context/CDP、Cookie、Profile、文件系统、
下载确认或事实写入能力。它只能提出下一步动作，不能宣布下载成功。

Network 的 `BrowserStepSession` 是文章操作的唯一接口。`start()` 与 `apply()` 在返回前吸收 loading、
navigation race、stale revision、frame/page/popup 交接、quiet settlement 和 capture candidate，跨层
只返回：

```text
Ready | Captured | Blocked | Failed | Cancelled
```

只有 `Ready` 可以触发下一次模型调用。`Captured` 仅表示 Agent 尚未开始探索时已有一份有界捕获；
一旦 Agent 已经发出动作，后续 capture 不会让 loop 提前终止，而是累积到本次外层
`BrowserCaptureBatch`，在 Agent `Stop`、预算或硬故障后交给 Acquisition。每个动作绑定当前
article/page/surface/revision，最多执行一次 vendor action；绑定已变化时不重放旧动作。Network
保留 URL/DNS/redirect/host admission、固定 CloakBrowser identity、单项 timeout/字节限制、取消、
candidate 生命周期和确定性清理。

页面状态只描述 Agent 当前看到的页面，不是程序替 Agent 作出的终态决定。Challenge、登录、MFA、
无权限、拒绝、未找到和页面失败均可作为稳定 Observation 交给 Agent；一次没有语义变化、重复动作
或页面短暂不变也仍是 settled step，不再自动生成 `no-progress`。候选超时只是一次内部捕获等待的
有界结果：Network 隐藏候选进度并把控制权交还给 Agent，后续 native download 或其它入口仍可继续
完成。会话只在 Agent 明确 `Stop`、取消、controller safety fuse 或真正的 Network/runtime failure
时结束；若 Agent 最终停止且候选仍未完成，外层 Browser operation 才返回 `capture-timeout`。

### 4. Capture 不是 Acquisition 成功

Network `Captured` 只证明本次文章 Browser flow 捕获了一份有界候选。每份 Browser `TemporaryPdf`
必须携带 `BrowserPdfAssociationEvidence`，记录目标 DOI/标题/作者、起点、最终安全 locator、捕获
机制和可验证关联。

Acquisition 独立执行两道门：

1. 字节门：非空、PDF magic/EOF、标准 reader 可打开、页面树可读取且至少一页；
2. 文章归属门：受控 direct-PDF 起点，或候选文本/locator 与目标 DOI、标题、作者形成足够一致的
   通用证据；冲突 DOI、supplement/appendix、错文或证据不足均拒绝。

只有两道门和不可变发布都成功，才能形成当前 Literature 的 `primary-pdf`。Agent Stop、页面终态、
capture 事件、扩展名、媒体类型和下载按钮文字都不能替代这一步。

### 5. 配置与运行政策归一

一级 `[browser]` 只保存：`model`、`enabled`、`profile`、本机并发上限和对 `browser-generic` baseline
的只收紧 policy overrides。Model 自己拥有 reasoning、image 和 stream；Browser 只选择一个
`image = true` 的完整 `provider/model`。

所有文章共享一个 operator-managed Profile、一个 CloakBrowser process/persistent context 和一个
`browser-generic` 调度政策。调度仍可对每篇文章串行、限速、冷却和熔断；Publisher 分类不再决定
模型是否能操作页面。配置中心的 Publisher site test 仍只测试显式支持的可达性 probe，不代表
通用 Browser 下载准入或文章权限。

### 6. 破坏性切换

删除 `RuleBrowserController`、`BrowserSiteRule`/catalog、Publisher rule modules、selector/locator
controller API、旧 capture kind，以及旧 `browser_controller` 配置。旧字段直接由严格配置边界
拒绝；不提供别名、迁移器、兼容 adapter 或隐藏 fallback。Literature、Asset、primary-pdf、
provenance 与自动获取耗尽的持久合同不变，因此不需要数据库迁移。

## 后果

正面后果：

- 新站点只要具有合法文章起点，就可由同一 Agent/Network 合同尝试，不再以编写 Publisher rule
  作为前置工作；
- 页面策略、页面事实和 PDF 正确性分别归属 Agent、Network、Acquisition，不再有第二套点击循环；
- 页面变化只需增强通用 Observation/action/capture 合同，站点差异不再扩散为 Python 模块；
- Browser 成功可以用同一文章归属门审计，模型无法用“看起来下载了”绕过 PDF 验收。

代价与限制：

- 成功率更依赖 Browser Model 的视觉理解和动作质量，模型失败不会由确定性规则兜底；
- 通用 origin admission 必须从当前已准入页面关系动态约束，不能依赖预先列出的 Publisher origin；
- 对正文文本极少、PDF 无可提取身份、只通过不透明 blob 交付的页面，通用文章归属门可能保守拒绝；
- 真实站点效果仍需另行授权的现场测试证明，离线 fixture 只证明合同和对象图。

## 不采用的方案

- 保留 Rules 与 Agent 二选一：继续维持两套策略和配置语义，不能解决站点依赖。
- 让 Agent 直接持有 Playwright/Page/CDP：会把稳定化、capture correlation 和资源清理重新交给
  模型，无法形成可验证的程序交接。
- 由 Agent 输出 PDF URL 或“成功”布尔值：任意 URL 与自然语言结论都不能证明下载事实和文章归属。
- 将 LangGraph 引入 Browser 状态机：当前流程是消费模块拥有的有界反应循环，Network 已拥有页面
  状态；增加持久图或第二套状态机不会提升交接正确性。共享 Agents Runtime 继续以 PydanticAI
  Direct/协议 adapter 的无状态单次调用为基础。
