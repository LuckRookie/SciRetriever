# ADR 0017：共享 Agents 基础与受控 Browser Agent

- Status: Accepted
- Date: 2026-08-21
- Supersedes: none
- Amends: [ADR 0008](0008-summarized-markdown-literature-content.md)、[ADR 0014](0014-capability-scoped-providers-and-local-credentials.md)、[ADR 0015](0015-publisher-aware-tiered-pdf-acquisition.md)
- Related: [ADR 0008](0008-summarized-markdown-literature-content.md)、[ADR 0016](0016-cloakbrowser-fixed-identity-runtime.md)、[产品需求](../requirements.md)、[设计文档](../design.md)、[Analysis 技术文档](../technical/analysis.md)、[Agents 技术文档](../technical/agents.md)

## 背景

Analysis 当前拥有文献内容判断、两阶段总结和 ReferenceLookup 三种模型请求，也同时拥有 OpenAI/Anthropic 协议、认证、模型 capability、预算和调用生命周期。当 Browser Acquisition 成为第二个需要图像输入与结构化动作决定的真实消费者时，继续在 Acquisition 复制 provider、凭据、quota 和错误处理会形成两套模型基础设施；把 Browser prompt 或页面动作塞进 Analysis 又会破坏业务所有权。

CloakBrowser 仍使用 Playwright API，因此模型不需要也不应直接接管 Page、Context 或 CDP。系统只需要一个受控决策 seam：模型观察经过裁剪的当前页面，返回封闭动作，SciRetriever 在同一文章、同一 Browser session 和同一 Network/Provider permit 内执行。

## 决策

### 1. 建立 `agents` 公用基础模块

新增 `src/sciretriever/agents/`，只拥有 provider-neutral 的模型调用基础：

- 有界文本和图像输入；
- 严格结构化响应；
- tool declaration 与单步 tool decision；
- provider/model identity 与 capability；
- deadline、token、响应字节和请求级预算；
- 取消与 request-local session；
- 协议 adapter、稳定失败和安全日志。

`agents` 不拥有 Literature、PDF、Publisher、Browser、prompt 业务语义、结果接纳或持久化。它不是全局 service locator、通用工作流引擎、长期 memory 或对外 prompt API。Analysis 必须成为第一个真实消费者；Browser 不能促成一套空的平行 provider 体系。

### 2. 业务 prompt、工具含义和验收归消费者

责任固定为：

| 所有者 | 责任 |
|---|---|
| `agents` | 中性 provider/model/capability/budget/session、请求编码、响应边界与稳定失败 |
| `analysis` | 文献 prompt、两阶段顺序、schema、NoUsableContent、Markdown/ReferenceLookup 验收与 Analysis provenance |
| `acquisition` | “取得当前文章主 PDF”目标、确定性规则优先级、Browser Agent prompt、允许动作、页面结果解释和 route outcome |
| `network` | CloakBrowser runtime、有界页面观察、动作执行、origin/DNS/host/限速/预算、response/download 捕获与清理 |
| `configuration` | Agent endpoint/协议/角色模型/预算、origin-bound secret、capability/readiness 和 Cloak/Profile 生命周期 |
| `bootstrap` | 选择唯一 Agents provider adapter 和 CloakBrowser adapter，构造生产对象图并控制关闭顺序 |

Analysis 不把文献业务 request kind 提升到 Agents；Acquisition 不把 Publisher selector 或 PDF 发布交给 Agents；Network 不解释模型目标或文献业务结果。

### 3. Analysis 无兼容层迁移到 Agents

Analysis 通过 Agents 的 structured-text capability 执行现有两阶段分析和 ReferenceLookup，继续构造 prompt/schema、检查输入 hash、验证结构并形成单一业务结果。迁移完成后删除 Analysis 私有 provider adapter、重复配置、旧 Port 和兼容导入；运行时不保留“Agents 失败后回退旧 Analysis adapter”的双路径。

ADR 0008 的两阶段顺序、NoUsableContent、最终元数据、Markdown、ReferenceLookup、provenance 和 Literature 接纳合同不改变。Agents 请求成功不能替代 Analysis 业务验收。

切换门固定如下：Agents 中性 structured-text 调用、三协议 fake、预算/取消/错误和 Analysis 等价
回归全部通过后，在同一个功能切片中删除 `AnalysisLLMPort`、Analysis 私有 provider adapter、旧
provider 请求/响应交换值、重复 Bootstrap 组装与旧 probe/readiness 命名。源码、测试、wheel 与
Configuration 不能保留转发 wrapper、import alias、旧字段 fallback 或“Agents 失败后重试旧
Analysis adapter”的双路径。代码切片回退只通过完整版本回退，不能把兼容层变成产品运行开关；
已经保存的 Literature/Content/provenance 合同不迁移。

### 4. Browser 使用 controller seam，规则始终优先

Acquisition 将当前 callable flow 正式化为 `BrowserFlowController`。现有确定性实现成为 `RuleBrowserController`，目标执行顺序固定为：

```text
初始 capture 与页面状态
  -> 通用 PDF locator
  -> Publisher 静态规则
  -> 页面仍非终态且正常未命中时，才允许 Agent fallback
```

Timeout、quota、runtime failure、challenge/login/MFA 等 terminal 状态不调用 Agent 制造替代流量。已知规则成功路线不产生额外模型请求；缺少 Browser Agent capability 时确定性 Browser 仍可以工作，并准确报告 fallback unavailable。

### 5. Agent 只返回封闭决定，SciRetriever 唯一执行

Network 为当前文章生成 request-local `BrowserAgentObservation`，只包含：

- page revision；
- 去除 query 的 origin/path；
- status 与 capture 状态；
- 有硬大小限制的 viewport screenshot；
- 有数量限制的可见交互元素 role/name/state 和短期 element ID；
- 当前 step 与剩余预算。

第一版动作只允许：

```text
ClickElement
ScrollPage
WaitForPage
StopFlow
```

动作必须绑定 observation revision 和当前 element ID。未知字段、过期 revision、不可见或 disabled target、越界滚动/等待都在 vendor 调用前拒绝。Agent 不取得 Playwright Page、Context、Profile、Cookie、CDP、CSS selector、任意 URL、任意 JavaScript、键盘文本、文件上传、文件系统或创建新 Browser/context 的能力。

SciRetriever 把决定解析为当前内部 Locator，并通过同一 CloakBrowser `humanize=True` session、Publisher permit、Network guard、navigation marker 和 capture handler 执行。成功仍只交付 `TemporaryPdf`，再经过统一 PDF reader、页面树和不可变发布边界。

### 6. Agent session、预算和 readiness 请求级隔离

Agents session 只存在于当前一次文章流程，用于有界多 turn 决策；不能跨文章、Publisher、命令或进程恢复，也不写入 Catalog、ArtifactStore、Profile 或日志。每篇 Browser flow 设置 step、token、图像、动作等待、导航和总时长硬预算；重复动作、无进展循环、迟到决定、取消和 quota 都有稳定终态。

模型 capability 至少区分 structured text、image input 和 tool decision。`analysis-ready` 不等于 `browser-agent-ready`；相同 endpoint/credential 可以为 analysis/browser 两个角色选择相同或不同模型，但不能复制 provider secret 或绕过共享 quota scope。status 只根据本地配置说明 capability 缺口，显式 probe 才发生极小真实模型请求。

### 7. 日志、provenance 和持久化边界

INFO 只报告 role/provider/model capability、调用结果、耗时/额度和动作类别；Debug 可以增加安全阶段、大小和预算，但不记录 prompt、模型原文、截图、页面文本、元素名称、schema、reasoning 或 tool payload。原始 SDK/HTTP 错误在 adapter 内稳定化。

Analysis 继续按 ADR 0008 保存一项业务 provenance。Browser Agent turn、观察、截图、决定和模型 reasoning 不进入 PDF provenance、Report、Catalog、ArtifactStore 或 Browser Profile；Browser 成功资产仍只记录既有 Acquisition source 和输入 lineage。

第一版 Agent 不在 `interaction-required` CAPTCHA/MFA/login 状态运行，也不自动处理或绕过验证。

## 后果

- Analysis 与 Browser 共享唯一 provider、模型 capability、凭据、quota、取消和失败基础，不复制 vendor integration。
- 文献 prompt/schema 与 Browser 页面目标仍由各自业务模块拥有，`agents` 保持领域中立。
- 模型不能绕过 CloakBrowser、Network guard、Publisher 串行、资源预算或 PDF 验收。
- Browser Agent 是确定性规则之后可移除的内部策略；没有真实增益时可以关闭其 production admission，而不撤销 Analysis 对 Agents 的真实使用。
- 新模块增加一次无兼容层迁移和 capability-aware 配置成本，但避免两套模型基础设施长期漂移。

## 不采用的方案

- 继续让 Analysis 独占 provider 基础，再在 Acquisition 复制一套；
- 建立包含文献、Publisher、Browser 和任意 prompt 的通用 Agent workflow 平台；
- Agent 直接获得 Playwright Page、CDP、Cookie、Profile、任意 URL/selector/JavaScript 或文件系统；
- Browser 页面一开始就由 Agent 接管，绕过通用 locator 和 Publisher 静态规则；
- 把 Agent memory、页面观察、截图、reasoning 或动作历史持久化为文献事实；
- 用自由文本解析替代严格 tool decision，或在 capability 不足时静默降级；
- 让 Agent 自动点击 CAPTCHA、登录、机构选择或 MFA。

## 需要新 ADR 的变化

- Agent 获得任意导航、JavaScript、文本凭据、文件上传、外部工具或直接 Browser/CDP 所有权；
- 建立跨文章/跨命令长期 memory、后台自主任务或持久 Agent workflow；
- 让模型决定文献身份、事实写入、PDF 基本验收或绕过消费者业务检查；
- 自动处理登录、机构选择、MFA、CAPTCHA 或 challenge；
- 把 Agents 暴露成不受消费模块约束的公开通用 prompt API。
