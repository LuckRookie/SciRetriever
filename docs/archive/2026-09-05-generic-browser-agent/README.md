# Generic Browser Agent 重构计划

## 身份与状态

| 字段 | 值 |
|---|---|
| Run ID | `2026-09-05-generic-browser-agent` |
| 创建日期 | 2026-09-05 |
| Primary owner | `/root` |
| 基线 revision | `4ea15d51a46cf4f6c9c586fd7ad228fda4086a57` |
| 治理深度 | `R0`–`R5` |
| 执行模式 | `cross-session`、单一 Primary、串行；不启用 worker 并行 |
| 计划状态 | `Completed`（2026-09-06）：实现、离线回归、Full、文档与归档审查均完成 |

> 基线 revision 以仓库当前 `git rev-parse HEAD` 为准；表中值仅作计划记录，不得用于恢复或回滚。
> 当前工作树含大量既有用户修改，本计划不覆盖、回滚或提交这些修改。

## 目标观察

完成后，用户启用 Browser 下载时，系统不再因为缺少某个期刊的专用点击规则而在进入页面前跳过任务。每篇文章进入一个由 Network 提供稳定页面观察的 article-local Browser 会话，Agent 根据文章目标和当前页面自主选择封闭动作；Browser 只负责观察、执行动作、等待页面稳定以及捕获下载证据。SciRetriever 仍由 Acquisition 独立判断捕获内容是否是目标文章的主 PDF，并给出可解释的 `Accepted`、`Rejected(reason)` 或自然阻断结果。

这不是把 Browser 变成开放式脚本执行器，也不是让模型直接写数据库。目标是把“页面怎么走”交给 Agent，把“页面是否稳定、动作能否执行、文件是否真的属于目标文章”分别留在 Network 和 Acquisition。

## 授权与真相源

用户已明确：项目仍在构建阶段，本次允许破坏性重构，不保留旧配置、旧内部 API、旧 Publisher Browser rule 或双路径兼容层。该授权只覆盖仓库中的实现、测试和架构文档；不覆盖用户配置、真实文献资产、凭据、生产 catalog、真实外部服务或 Git 发布动作。

本计划受以下真相源约束：

- 产品范围和验收：[产品需求](../../architecture/requirements.md)。
- 已接受的 Agents/Browser 选择：[ADR 0017](../../architecture/decisions/0017-shared-agents-and-controlled-browser-agent.md)、[ADR 0019](../../architecture/decisions/0019-agent-operable-application-and-sdk-model-runtime.md)。
- 当前 PDF 路由和身份事实：[ADR 0015](../../architecture/decisions/0015-publisher-aware-tiered-pdf-acquisition.md)。
- Browser runtime 身份和页面状态：[ADR 0016](../../architecture/decisions/0016-cloakbrowser-fixed-identity-runtime.md)。
- 模块责任：[架构设计](../../architecture/design.md)、[Acquisition 技术文档](../../architecture/technical/acquisition.md)、[Network 技术文档](../../architecture/technical/network.md)、[Agents 技术文档](../../architecture/technical/agents.md)。
- 计划执行和验证：[HARNESS.md](../../../HARNESS.md)、[计划规范](../README.md)。

当前方向会改变 ADR 0015/0017 中关于“Publisher rule 控制 Agent 准入/策略”的部分，因此实现前必须新建或修订 ADR，并同步 requirements、design、technical 文档；计划本身不取代这些权威文档。

## 事实、假设与开放问题

### 已核实事实

- `ControlledBrowserPdfSource` 当前通过 `BrowserRuleCatalog.match_origin()` 和 `_PublisherStepPolicy` 生成页面动作；未命中 Publisher rule 的页面可能直接跳过 Agent。
- `BrowserObservation` 当前对模型暴露的页面语义不足，缺少目标 DOI/文章上下文、链接目标类别、surface/frame/popup 关系和细粒度 candidate 反馈。
- `network.browser_control` 已有 `start/apply`、revision/stale、稳定页面、capture candidate、settlement 和终态机制，可作为通用执行器基础。
- `BrowserCapturePolicy`、PDF reader、文章身份和主/补充材料区分必须保留；“捕获到 PDF”不是“成功取得目标文章”。
- 当前生产 Browser catalog 有 9 条 Publisher rule。真实批次 276 个目标中，194 次进入 Agent 终态、35 次 captured、90 次 page-terminal（84 not-entitled、6 not-found）、43 次 failed、25 次 no-progress、1 次 stopped；这些是 attempt-level 结果，不是 article-level 成功率。
- 两次独立可行性评审均支持 generic Browser executor、可选 Publisher hint/ranker/validator 和程序最终验收；均不支持只删除规则、不做离线回放，或让 PydanticAI 接管 Browser 状态机。
- `AgentRuntime` 当前是无状态单次调用边界，`pyproject.toml` 尚未把 `pydantic-ai` 作为依赖；后续如采用该 SDK，必须保持 provider-neutral Runtime 合同。
- `PublisherAccessProfile` 同时包含访问身份、风险/会话政策、页面标记和 Browser 专属字段；清理时不能误删授权 API profile 的字段。

### 实施假设

- 第一版封闭动作继续使用 `ClickElement`、`ClickPoint`、`ScrollSurface`、`GoBack`、`WaitForChange`、`Stop` 六种动作。
- Browser Agent 是 Browser 路径中唯一的页面策略控制器；不再提供 `rules|agent` 二选一，也不在 Agent 失败后回退到规则点击。
- Publisher profile 降级为可选的访问/正确性能力和策略 hint，不再是 Agent 操作策略的硬准入条件。只要 canonical landing 和通用 Network admission 合格，未知或无专用 rule 的站点也可以进入 generic Browser。
- PydanticAI（若验证通过）只实现一次结构化模型决策的 adapter；Acquisition/Network 仍拥有循环、状态、取消、capture 和清理。

### 实施结论

- Browser 配置已收敛到一级 `[browser]`，拥有总开关、Browser Model、固定 identity/profile 和通用
  policy；`[download]` 只拥有 PDF route/source 选择，不再保存 Browser controller/model。
- 未新增 Publisher strategy hint 或 locator hint。Agent 只消费通用 observation，Publisher profile 不再决定
  页面动作；文章归属和主 PDF 判定统一由 Acquisition validator 完成。
- 真实站点的登录、challenge、viewer 和 native download 差异仍需在获得单独授权后验证；本次离线验收
  不宣称真实 Publisher 成功率。

## 范围与非目标

### 本次范围

- 定义并落地通用 `ArticleGoal`、稳定 `BrowserObservation`、封闭 `BrowserAction`、候选生命周期和跨层终态。
- 把 Browser readiness、页面代际变化、popup/viewer、下载 capture 和 cleanup 收敛到 Network generic executor。
- 让 Agent 只根据一份稳定 Observation 做一次结构化决策，并通过 `apply` 与 Browser 交接。
- 将 Publisher-specific rule 从操作策略中删除，拆出可选 hint 与必须的 capture/文章身份正确性能力。
- 让 Acquisition 从 DOI、标题、作者、landing 和 asset hint 形成文章目标，并独立验收 PDF 字节、文章身份、主/补充材料和 provenance。
- 删除旧 `RuleBrowserController`/`BrowserRuleCatalog` 作为 Agent 控制路径的依赖、旧 controller 配置和相关测试；不提供迁移或兼容层。
- 增加 fake Browser、fixture/replay、fake model 和 article-level 对照测试，完成文档与对象图闭环。

### 明确非目标

- 不把 Agents 变成可持久化的自主任务系统，不新增跨文章 memory、后台队列或数据库写入能力。
- 不向 Agent 开放任意 URL、JavaScript、selector、CDP、Cookie、登录凭据、文件系统、文件上传或新 Browser/context 创建。
- 不删除 Network 的 URL/DNS/redirect/host admission、CloakBrowser 会话隔离、限速、取消和资源上限。
- 不删除 PDF reader、文章身份、supplement 排除、candidate lineage 或不可变发布约束。
- 不在本计划默认执行真实 Publisher/LLM/MinerU 请求，不读取或修改用户 `config.toml`、credentials、真实 catalog 或文献资产。
- 不顺手重写无关的 Config TUI、日志 UX、Metadata Source 或 MinerU 业务。

## 全局验收条件

1. 对已通过通用 Browser admission、但没有 Publisher rule 的 canonical landing，Agent 不再在入口处被跳过；页面策略由 Agent 决定。
2. Agent 只能看到同一 article session 内的稳定 Observation；加载、frame/page replacement、popup/viewer 交接或 stale action 不会把半加载页面或旧动作交给 vendor 执行。
3. 每次稳定 Observation 至多产生一次模型决策和一次 `apply`；重复无进展、cycle、Stop、candidate timeout、页面终态、系统失败和取消可区分。
4. Download candidate 必须经历 `pending → accepted/rejected` 的当前文章生命周期；candidate、capture、PDF 字节 hash、文章身份和主文献归属均可审计，后续阶段失败不撤销已确认事实。
5. PydanticAI（如采用）不持有 Browser loop、业务状态或 session history；fake model 可证明每个稳定 step 只有一次调用。
6. 旧 Publisher click/step rule 与 `rules|agent` 兼容配置不再是生产对象图的一部分；源码、测试和当前技术文档中不存在未解释的旧控制路径。
7. 离线 fixture/replay 覆盖正常下载、Challenge、登录/未授权、viewer/popup、错误文章、补充材料、下载延迟、stale 页面和 capture timeout；以 article-level `accepted_pdf_rate`、`rejected_reason`、`blocked_reason` 为主指标。
8. 实现、直接测试、必要文档和对象图通过 Quick；交付前 Full、wheel 内容核对和语义审查通过。真实环境测试若另行获准，结果单独记录，不替代离线合同证据。

## 分块地图与依赖

| Block | 结果 | 主要文件/模块 | 依赖 | 状态 |
|---|---|---|---|---|
| 01 | 新的通用合同、所有权和 ADR 方向 | `docs/architecture/`、`src/sciretriever/model/`（仅实施阶段） | 调查事实已完成 | Completed |
| 02 | Generic Browser runtime 能稳定观察、执行和捕获 | `src/sciretriever/network/browser*.py`、`src/sciretriever/network/cloakbrowser.py`、直接测试 | Block 01 | Completed |
| 03 | 单次 Agent 决策和 SDK 适配评估 | `src/sciretriever/agents/`、Acquisition controller、依赖与测试 | Block 01、02 合同 | Completed |
| 04 | Acquisition 文章目标、候选验收和旧规则删除 | `src/sciretriever/acquisition/`、`bootstrap/`、配置、fixture | Block 02、03 | Completed |
| 05 | 离线回放、article-level 口径、Full 与交接 | `tests/`、必要文档、计划证据 | Block 04 | Completed |

串行依赖为 `01 → 02 → 03 → 04 → 05`。不为了形式拆分并行 worker；每个 Block 只有一个 Primary owner。

## 跨块合同

- `ArticleGoal` 是 Acquisition 拥有的中性输入，至少包含目标 DOI/稳定 ID（可为空）、标题、作者线索、canonical landing、asset hint 和当前文章 token；不包含 Cookie、secret、vendor Page 或完整签名 URL。
- `BrowserObservation` 是 Network 唯一产生的稳定观察，绑定 article token、单调 revision、page/surface/frame 关系、去 query locator、页面状态、可见文本/操作元素、screenshot、capture state 和上一动作的脱敏 receipt。
- `BrowserAction` 只有六种封闭动作，必须绑定当前 revision/article/surface；Network 在 vendor I/O 前再次验证 exact binding。Agent 不能构造任意 selector、URL 或脚本。
- `BrowserStepResult` 只允许 `Ready`、`Captured`、`Blocked`、`Failed`、`Cancelled`；`CANDIDATE`、stale、quiet settlement 和 vendor transition 是 Network 私有状态。
- `DownloadCandidate` 是 article-local 中间证据，拥有明确的 `pending/accepted/rejected` 生命周期、capture lineage、规范媒体类型和字节 hash；它不能跨文章、跨操作或直接成为主资产。
- Publisher 能力分为两层：可选 `StrategyHint`（帮助排序或提示入口）和必须的 `CorrectnessCapability`（主 PDF、supplement、文章身份、capture lineage、页面终态）。前者不能控制 Agent，后者不能被删除。没有 Publisher capability 时使用通用 DOI/标题/作者身份校验；证据不足只能 `DEFER`/`REJECT`，不能让模型自行宣布成功。
- `AgentRuntime.execute` 继续是一次 provider-neutral 结构化调用；PydanticAI 类型和模型协议不能越过 Agents 边界。

## 影响矩阵

| 领域 | 预期变化 | 处理方式 |
|---|---|---|
| 公开接口 | Browser controller、Observation/action/result、Agent prompt schema 会重构 | 先修订 ADR/technical，再同步 `api.py`、测试和调用方；无旧接口兼容层 |
| 配置 | 新增/固定一级 `[browser]`，删除 `rules|agent` controller 选择和 `[download]` 中的 Browser 字段 | 只接受新的当前 schema；旧字段直接拒绝，不迁移 |
| 数据/schema | 不改变已发布 Literature/Asset/provenance 的含义；新增 operation-local candidate/lineage 合同 | 不把 candidate 或 Agent history 写入 Catalog；必要事实进入既有 provenance |
| 依赖 | 已评估 `pydantic-ai`，现有单次 provider-neutral adapter 已满足合同 | 不新增依赖，不修改 `uv.lock` |
| 文档 | requirements、ADR、design、technical、配置/Browser 指南和测试映射同步 | 文档更新属于对应 Block 的完成条件 |
| 打包 | 删除的规则模块不得进入 wheel；新增 adapter 必须被 wheel 内容检查发现 | Full Harness 的 wheel 检查作为交付门 |
| 运行对象图 | Browser 只构造 generic controller；Network 是 action/capture/cleanup owner | Bootstrap 只在一个位置组装，禁止第二套 fallback loop |

## 风险与转化信号

| 风险 | 观察信号 | 转化/处理 |
|---|---|---|
| 删除规则后 Agent 仍缺少足够页面语义 | fixture 中反复 `Stop`、错误点击或无法定位 PDF | 回到 Block 01/02，增强 observation 的中性语义；不恢复 Publisher click controller |
| 页面尚未稳定就做决策 | stale、execution-context 错误或同一页面重复重放上升 | 回到 Network readiness/settlement；检查 `start/apply`，不在 Agent 层加 sleep 猜测 |
| capture 到错误 PDF 但被当成成功 | article-level reject 或 wrong-article/supplement 命中率上升 | 回到 Block 04 的 capture lineage/identity validator；保留 PDF 二次验收 |
| Generic path 变成任意网页抓取器 | 无 canonical landing、无安全 admission 的 URL 进入流程 | 阻断并修订 admission 合同；generic 不等于 arbitrary URL |
| SDK 引入状态机或隐藏重试 | fake model 调用次数超过 step 数，或 Runtime 出现 history/session | 删除高层 loop，保留一次调用 adapter；必要时回到 Block 03 |
| 仅用 attempt-level 数据误判提升 | 总 captured 上升但同文献重试/重复增加 | 采用 article-level 主指标，保留 attempt-level 诊断 |
| 大量既有工作树修改被误删 | diff 出现任务外文件删除/覆盖 | 立即停止，按文件 owner 复核；只修改计划声明的范围 |

## 验证与证据策略

执行时按以下顺序形成证据：

1. L0：每个切片检查 diff、类型诊断、最小 fake/replay 复现和合同测试。
2. L1：运行相关 unittest、Ruff 和 compile；Block 退出前运行 `uv run --frozen python scripts/harness.py quick`。
3. L2：运行 Browser/Agent/Acquisition 对象图、序列化合同、fake provider、fixture/replay 和 article-level 汇总。
4. L3：交付前运行 `uv run --frozen python scripts/harness.py full`，确认全部测试、Pyright、wheel 构建和 wheel 内容。
5. L4：Primary 对照 requirements、Accepted ADR、所有权、错误语义、凭据边界、文档和最终 diff 做语义审查。
6. L5：真实 Publisher/LLM/CloakBrowser 测试、用户配置写入、commit/push 或发布均需在计划外单独取得授权。

原始截图、PDF、真实日志、凭据和 batch JSON 不进入计划目录；计划只记录可复现命令和结果摘要。article-level 指标脚本必须使用 fake/fixture，不读取真实用户语料。

## 授权门

| 触发 | 动作 | 所需授权 | 当前状态 |
|---|---|---|---|
| 进入 Block 01 之后 | 修改 requirements/ADR/design/technical | 当前用户已批准架构方向；每次公开合同改变仍由 Primary 复核 | Completed |
| 删除旧 rule/controller/config | 删除仓库源码、测试和配置字段 | 当前用户已明确“不保留兼容性”；不得删除用户文件 | Completed |
| 新增/锁定 `pydantic-ai` | 修改 `pyproject.toml`/`uv.lock` | 仅当 Block 03 证明 SDK 适合单次 adapter | Not exercised：无需新增 SDK |
| 真实 Browser/LLM/Publisher 测试 | 访问外部服务、使用真实凭据或 CloakBrowser Profile | 需要用户另行明确授权 | Not exercised：本次未授权 |
| Git commit/push/release | 修改仓库历史或外部远端 | 需要用户另行明确授权 | Not exercised：未执行 |

## 执行方式与集成点

Primary owner 按 Block 顺序执行。每个 Task 采用“预检 → 最小能力切片 → 直接测试 → diff/合同审查 → 记录证据”的循环。Block 02 与 03 不并行，因为 Agent schema 依赖稳定 Observation，Acquisition 也不先于 capture 合同改写。Block 05 是唯一集成点，负责把离线回放、对象图、配置和打包结果汇总为交付判断。

## 执行审查

- `R0 Plan readiness`：本 README 与五个 Block 文件齐全，授权、依赖、退出条件和恢复点明确后，才可改源码。
- `R1 Block entry`：核对前一 Block 的完成证据、当前工作树保护范围、直接测试入口和外部授权状态。
- `R2 Slice review`：每个能力切片检查是否引入第二套状态机、是否把 vendor 类型泄漏到公共面、是否有失败测试和文档。
- `R3 Block exit`：所有 Task、直接测试、下游合同和残余风险完成后才可进入下一 Block。
- `R4 Integration review`：检查 Bootstrap/Network/Agents/Acquisition 组合对象图、配置解析、candidate 生命周期和文章级指标。
- `R5 Final delivery`：Full Harness、wheel、文档、最终 diff、未覆盖真实环境范围和 Git 状态一起复核。

## 进度规则

编号 Task 只有在实现、直接测试、必要文档和该 Task 验收证据同时成立后勾选。Block 状态由其文件汇总，不维护另一套计数。计划只有所有全局验收、最终文档、Full Harness 和交接闭环后才能标记 `Completed`。发现改变 owner、接口、数据、风险或验收时，先暂停下游工作并更新本计划，不在下游堆兼容分支。

## 恢复与续作

跨会话继续时首先读取本 README、最近一个未完成 Block、`git status --short`、该 Block 的完成证据和相关真相源。最近恢复点是“最后一个通过 R3 的 Block”；从该 Block 的下一个 Pending Task 开始，不重做已完成证据。

失败信号包括：公共合同与 ADR 冲突、Network 无法提供稳定 Observation、candidate 不能确定性清理、fake model 调用次数失控、article-level reject 无法解释、Quick/Full 失败或 diff 夹带用户工作。恢复方式是停在当前 Block，保留失败测试和诊断，回到最近稳定合同；不使用旧 Publisher controller 作为隐式 fallback。若方向确需改变，更新 ADR/计划后再继续。

## 计划变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-05 | 初版建立；确定 generic Browser Agent、单次 PydanticAI adapter、程序最终 PDF 验收和无兼容层 | 用户确认构建阶段允许破坏性重构；两次独立可行性评审支持该方向 |
| 2026-09-06 | 完成 generic Browser Agent 重构；选择保留现有单次 provider-neutral adapter，不引入 PydanticAI；完成离线回归和 Full | 现有 adapter 已满足单次调用边界；生产对象图、配置、PDF 归属验收与文档已形成闭环 |

## 最终交接

- 已留下更新后的 requirements、ADR 0023、design、technical、configuration/PDF acquisition guides 和
  documentation map。
- 生产只注册 `browser:generic` / `browser-generic`；Agent 负责稳定页面上的一个封闭动作，Network
  负责 observation/action/capture/cleanup，Acquisition 独立验证 PDF 字节与文章归属。
- 已删除 Publisher rule/controller 与 Rules/Agent 双路径，不保留旧配置或 API 兼容层；数据库 schema
  未变化，也未新增依赖。
- 直接相关回归 307 项通过；全量 2192 项通过、3 项跳过；Quick、Pyright strict、wheel 构建和 wheel
  内容核对全部通过。
- 未运行真实 Publisher、LLM、MinerU、用户 Profile 或用户资产测试；真实站点成功率仍需在单独授权的
  live verification 中验证。
- 未执行 commit、push 或发布；计划归档后以本目录保存实施证据。
