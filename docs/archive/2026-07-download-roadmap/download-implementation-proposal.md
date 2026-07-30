+++
document_type = "proposal"
status = "draft"
created = "2026-07-22"
+++

# 文献下载实施提案

> **归档状态：已被替代。** 本文仅保存 2026-07-23 产品重置前的候选工作包，不是当前需求、产品方向或实施授权。当前方向见 [ADR 0002](../../architecture/decisions/0002-literature-identity-and-incremental-processing.md)。当时的 OMO 执行计划不作为项目文档保留；下文 front matter 状态和正文保持历史原样。

- 记录日期：2026-07-22
- 适用范围：v2 `src/sciretriever/` 的全文候选发现、下载执行、验证、调度和运维
- 产品方向：[文献自动下载产品方案](download-product-shape.md)
- 评估输入：[下载能力对比](download-capability-comparison.md)、[能力差距台账](capability-gaps.md)
- 当前行为真相源：[系统设计](../../architecture/system-design.md)、[需求](../../architecture/requirements.md)、[README](../../../README.md)
- 权威边界：[ADR 0001](../../architecture/decisions/0001-sciretriever-scope-and-boundary.md)

## 1. 文档定位

本文件把下载专项评估转换为可排序、可验收的候选工作包。它是 proposal，不会仅因写入本文件而改变当前产品行为或授权实施。某个阶段获准进入开发前，必须先把已批准的行为、配置、契约和验收标准同步到 requirements/spec，再由 OMO 在 `.omo/plans/` 建立执行计划；涉及公开契约、持久化 schema、网络安全或项目边界时，继续执行对应人工门禁。

四份 proposal 文档的职责如下：

| 文档 | 职责 | 不负责 |
|---|---|---|
| `capability-gaps.md` | 记录全部未承诺能力差距 | 排定下载开发顺序 |
| `download-capability-comparison.md` | 保存参考项目对比、证据和设计判断 | 跟踪实施状态 |
| `download-product-shape.md` | 定义用户获得的功能、默认体验和产品优先级 | 描述内部模型和实现细节 |
| 本文件 | 提议下载工作包、依赖、验收和决策门 | 授权实施或描述当前已交付行为 |

## 2. 当前基线与问题边界

### 2.1 已有且必须复用

当前 v2 已具备以下基础，本提案不建立平行替代品：

- `SourcePlan` 和 `MultiSourceOrchestrator` 提供 source entry/provider 级 serial/race、持久化 attempt、retry/resume、host budget、health 和 circuit breaker；P5 已有文档中的 candidate 指 source-plan entry，不是本提案拟新增的 URL 级下载候选。
- acquisition validation 负责资产角色、媒体类型、大小、PDF 字节结构、可解析性和页数检查。
- network 层提供 HTTPS、DNS pinning、重定向复检、敏感 header 剥离和响应大小上限。
- `AssetAcceptanceCoordinator` 与 RawAsset store 提供不可变、content-addressed、可崩溃恢复的资产发布。
- catalog 保存 job、attempt、failure、event、plan、hash 和 lineage，不保存大型响应字节或凭据值。
- 现有测试已经覆盖 provider 级 fallback/race、预算、熔断、恢复、资产去重和存储崩溃恢复。

### 2.2 需要补齐的核心缺口

| 编号 | 缺口 | 当前影响 | 首要工作包 |
|---|---|---|---|
| D-01 | resolver 通常只消费首个 URL/location | 首候选失效后，同一 provider 的其它候选被浪费 | WP1、WP2 |
| D-02 | resolver 与下载执行耦合 | 去重、排序、referrer、过期和逐 URL provenance 无法统一 | WP1、WP2 |
| D-03 | 错误类别和重试决策不够统一 | 覆盖不足、访问拒绝、网络错误和本地误拒绝混在一起 | WP0、WP2 |
| D-04 | HTTP 边界规范化存在缺口 | 有效的参数化 MIME 等响应可能在模型边界被拒绝 | WP0 |
| D-05 | acquisition 测试多使用完整 `bytes` | 网络中断、流读取超时和截断响应缺少端到端证明 | WP0、WP2 |
| D-06 | landing page 不产生受控 PDF 候选 | 只有文章页或直链失效时无法继续发现资产 | WP4 |
| D-07 | manifest 跨论文处理主要顺序执行 | 大批量补全吞吐不足 | WP5 |
| D-08 | provider 运维资料与准入门未闭环 | API、凭据、预算变化容易被当作代码故障 | WP3、WP7 |
| D-09 | browser/session/institutional 尚无隔离契约 | 无法在不污染 core/durable state 的前提下扩展 | WP6 |
| D-10 | 目标文章身份核对尚未形成统一门 | 有效 PDF 仍可能属于错误文章，造成 false acceptance | WP0、WP2、WP4 |
| D-11 | TOML 已存在但缺配置自检和代理/浏览器设置 | 用户无法在批量任务前确认 key、网络、权限和容量是否就绪 | WP9 |
| D-12 | failure/attempt 已持久化但没有用户查询入口 | 用户只看到失败数量，无法知道原因和如何修复 | WP0、WP10 |
| D-13 | 有 host budget，但默认示例偏快且无正文级保守模式 | 批量任务可能形成不必要的高频请求并增加封禁风险 | WP5、WP9 |
| D-14 | 缺统一自动下载、状态和分类重试入口 | 用户必须理解内部阶段和 catalog 状态才能操作 | WP10 |

### 2.3 本提案不做什么

- 不重写 durable orchestrator、catalog、RawAsset store 或 `DocumentPackageVersion`。
- 不让 discovery 直接写 acquisition 状态；两阶段继续通过 `DownloadManifest` 交接。
- 不以 provider 数量作为覆盖指标，不一次性复制大型 translator 语料。
- 不把 cookie、token、Authorization header、用户身份或完整签名 URL 写入 plan、catalog、日志和 fixture。
- 不在普通 HTTP executor 中执行任意 JavaScript；浏览器能力保持独立、可选、默认关闭。
- 不在本提案中设定未经基准验证的通用“下载成功率”承诺。

## 3. 目标与成功判据

### 3.1 总体目标

1. 最大化每个已发现全文线索的有效利用率，而不是只增加来源名称。
2. 让每次 resolver、候选执行、验证和最终接收都可分类、可重放、可审计。
3. 在不削弱网络与存储边界的前提下，逐步增加公开来源、出版社路径、页面解析和可选 session adapter。
4. 让单篇和批量下载共享同一状态机、限流、重试和恢复语义。
5. 让普通用户通过一份 TOML、自检和一个自动下载入口完成任务，无需理解 discovery/acquisition 内部边界。
6. 让每个失败项目都能回答“哪里失败、为什么失败、是否重试、用户该做什么”。

### 3.2 已确认的产品默认值

- 普通正文下载默认单任务运行。
- 默认每 30 秒最多开始处理一篇新文献；provider 规则或用户设置更慢时采用更慢值。
- `Retry-After`、host budget、circuit breaker 和用户暂停始终优先于计划调度。
- API key、来源、路径、代理、浏览器和下载策略统一进入严格 TOML；环境变量仍可覆盖凭据。
- 成功文件直接保存；失败历史持久化，并提供稳定原因、重试状态和建议动作。
- 系统可以提出配置优化建议，但不得静默修改 TOML、启用来源或提高下载速度。

### 3.3 全局质量门

任何下载阶段只有同时满足以下条件才可完成：

- 离线 fixture 测试确定性通过，不依赖真实 provider。
- 现有 acquisition、network、catalog、storage 和 architecture 测试无回归。
- 新增日志、attempt details 和报告经过敏感信息检查。
- 取消、超时和进程关闭后无活动下载任务或未归属临时文件。
- 已接受资产仍只通过现有 validation 和 `AssetAcceptanceCoordinator` 发布。
- 公开 CLI、配置、schema 或行为变化已同步责任文档。

## 4. 统一术语与候选契约草案

### 4.1 术语

| 术语 | 定义 |
|---|---|
| source entry | 现有 `SourcePlan` 中的 provider 级路由项；P5 文档中的 candidate/candidate attempt 均指这一层 |
| resolver | 只读地把 DOI、PMID、arXiv id、文章 URL 或 provider 响应转换为零到多个 URL 级下载候选 |
| runtime download candidate | executor 一次有界网络执行所需的内存对象，可短期携带完整签名 URL，不代表内容一定存在或可访问 |
| durable candidate state | runtime candidate 的脱敏身份、resolver 游标、结果和恢复信息，不包含完整签名 URL 或凭据 |
| URL candidate attempt | executor 对一个 runtime download candidate 的一次实际执行与验证详情；挂在现有 provider/source-entry attempt 下 |
| provider attempt | 当前 durable `AcquisitionAttempt` 的兼容边界；一个 provider attempt 可包含多个 URL candidate attempt details |
| accepted asset | 通过角色和内容验证并由 coordinator 发布的不可变 RawAsset |
| access context | 对用户已配置访问环境的非敏感引用；不包含 cookie、token 或凭据值 |

### 4.2 运行时与持久化候选表示

进入 WP1 前应在 spec 中分别批准以下两个表示。它们不能共用一个可序列化对象，否则无法同时满足签名 URL 执行、敏感信息隔离和重启恢复。

**`RuntimeDownloadCandidate`（仅执行期内存）**

| 字段 | 必需 | 约束 |
|---|---:|---|
| `candidate_id` | 是 | 由 resolver、目标标识符、角色和稳定 resolver cursor 确定性生成，不依赖会变化的签名 query |
| `resolver` | 是 | 产生候选的稳定 resolver 名称 |
| `provider` | 是 | 当前 source entry/provider 名称，用于 attempt 归属 |
| `url` | 是 | 执行期完整 URL；不得直接序列化到 durable state |
| `page_url` | 否 | 候选来源文章页；必须通过 URL policy |
| `role` | 是 | primary PDF、supplementary PDF、XML 或 HTML |
| `media_type_hint` | 否 | 先规范化再进入封闭媒体类型模型，只作为提示，不替代 sniffing |
| `priority` | 是 | resolver 内静态优先级；动态排序另存解释 |
| `referrer_policy` | 是 | 默认不发送；只允许受信来源到候选的最小传播 |
| `expires_at` | 否 | 已知短期 URL 的过期时间；过期候选不执行 |
| `transport` | 是 | `https` 或后续批准的其它 transport；负责网络执行和预算 |
| `access_method` | 是 | `public_api`、`publisher_api`、`landing_page`、`scihub_page`、`browser_adapter` 等获取策略 |
| `auth_context_ref` | 否 | 指向运行期隔离上下文的非敏感名称，不得可逆推出凭据 |
| `provenance` | 是 | resolver 证据、目标标识符和非敏感来源字段 |

**`DurableCandidateState`（严格版本化 details）**

| 字段 | 用途 |
|---|---|
| `candidate_id`、`resolver`、`provider` | 重启去重和 attempt 归属 |
| `redacted_url_identity` | scheme、host、脱敏 path/query 或其 hash；不能重建完整签名 URL |
| `resolver_cursor` | resolver 重新生成候选所需的非敏感游标、location index 或稳定记录 id |
| `role`、`transport`、`access_method` | 恢复、统计和策略解释 |
| `expires_at` | 判断旧候选是否必须重新解析 |
| `status`、`failure_class`、`reason_code` | 终态、失败聚合和恢复位置 |

候选对象不得进入 `core`。第一版把 `DurableCandidateState[]` 作为现有 provider attempt details codec 的新版本扩展，不替换 P5 已交付的 source-entry candidate codec，也不先增加独立 catalog 行。重启时，对未完成、已过期或缺少执行 URL 的状态重新调用 resolver，以 `candidate_id + resolver_cursor` 对齐候选；已经终结的 candidate 不重复执行。只有证明这种嵌套恢复不足，才评估 catalog schema 变化。

### 4.3 去重与身份规则

- URL 规范化仅处理 scheme/host 大小写、默认端口、fragment 和已批准的追踪参数；不得随意重排或删除可能参与签名的 query。
- 同一 provider attempt 内，规范化身份相同的候选最多执行一次。
- 不同角色不因 URL 相同而静默合并；先以目标角色验证，再决定是否接受。
- landing page 候选必须携带目标 DOI/标识符证据；文章身份无法核对时只记为待诊断候选，不自动下载。
- 签名 URL 的 durable identity 使用脱敏 URL、host、path/query hash 和过期信息；完整 URL 只存在于受限执行期内存。重启后重新解析，无法重新生成时记录 `candidate_expired` 或 `resolver_no_candidate`，不得使用不完整 URL 猜测执行。

## 5. 稳定失败分类与执行决策

### 5.1 建议分类

| 类别 | 示例 | 默认归属 |
|---|---|---|
| `resolver_no_candidate` | API 有记录但无全文 URL | 覆盖 |
| `candidate_expired` | 已知签名 URL 过期 | 候选 |
| `not_found` | 确认的 404/410 | 候选或覆盖 |
| `configuration_missing` | 所需 key、邮箱、镜像、代理或路径未配置 | 配置 |
| `authentication_failed` | 已配置凭据无效、过期或被撤销 | 配置 |
| `access_denied` | 已认证但资源返回 403 | 访问上下文或候选 |
| `rate_limited` | 429 或明确配额响应 | provider/host |
| `remote_transient` | 5xx | provider/host |
| `network_timeout` | connect/read/provider deadline | 网络 |
| `network_policy_rejected` | HTTPS、DNS、redirect 或 host policy 拒绝 | 本地策略 |
| `response_too_large` | 超过有界读取上限 | 内容/策略 |
| `content_type_mismatch` | 声明类型与目标不符 | 内容 |
| `html_instead_of_asset` | PDF 候选返回文章页或挑战页 | 候选 |
| `interactive_challenge` | CAPTCHA、登录或必须交互的挑战页 | 访问方法 |
| `truncated_content` | 流中断、PDF EOF 缺失 | 网络或内容 |
| `content_invalid` | magic、解析、页数或角色校验失败 | 内容 |
| `identity_mismatch` | 资产或页面证据与目标 DOI/标识符冲突 | 内容/解析 |
| `storage_failed` | 空间、权限、staging 或发布失败 | 本地存储 |
| `internal_error` | 未归入稳定业务类别的本地异常 | 本地实现 |
| `local_contract_rejected` | 边界未规范化导致模型拒绝 | 本地实现 |
| `cancelled_by_winner` | 同目标 race 已接受其它 winner | 调度 |
| `cancelled_by_user` | 用户显式取消 | 调度 |
| `cancelled_by_shutdown` | 进程 graceful shutdown | 调度 |

分类字段必须稳定且低基数；状态码、异常类、host、候选序号等诊断信息进入受控 details，不扩展成无限错误枚举。

### 5.2 默认决策表

| 分类 | 同候选重试 | 换下一候选 | provider/job 后续动作 |
|---|---:|---:|---|
| `resolver_no_candidate` | 否 | 不适用 | 换 provider |
| `candidate_expired`、`not_found` | 否 | 是 | 候选耗尽后换 provider |
| `configuration_missing` | 否 | 否 | pause，等待用户补充配置 |
| `authentication_failed` | 否 | 否 | pause，等待配置修复 |
| `access_denied` | 否 | 是 | 需要原 auth context 的方法在耗尽后 pause；匿名/公开方法耗尽后换 provider |
| `rate_limited` | 按 `Retry-After` 有界重试 | 达上限后是 | 标记 retryable 并更新 host budget |
| `remote_transient`、`network_timeout` | 有界指数退避 + jitter | 达上限后是 | 候选耗尽后保持 retryable |
| `network_policy_rejected` | 否 | 是 | 记录本地策略拒绝，不放宽安全门 |
| `response_too_large` | 否 | 是 | 记录预算不匹配，不接收截断内容 |
| `html_instead_of_asset` | 否 | 是 | 若允许 translator，则把 page URL 交给受限 resolver |
| `interactive_challenge` | 否 | 是 | `browser_adapter`/institutional context 在耗尽后 pause；普通 HTTPS 页面耗尽后换 provider |
| `truncated_content` | 最多一次新请求 | 是 | 不把部分响应交给 RawAsset 接收 |
| `content_type_mismatch`、`content_invalid` | 否 | 是 | 保留摘要诊断，不保存失败正文 |
| `identity_mismatch` | 否 | 是 | 拒绝资产并记录高优先级诊断；不得计为 accepted asset |
| `storage_failed` | 否 | 否 | pause；修复容量/权限后从未发布状态恢复 |
| `internal_error` | 否 | 否 | pause 并生成诊断编号；不得归因于 provider 或自动重复轰炸 |
| `local_contract_rejected` | 否 | 否 | 作为实现缺陷阻断基准统计 |
| `cancelled_by_winner` | 否 | 否 | 不影响已有 winner 的成功终态 |
| `cancelled_by_user` | 否 | 否 | job 进入当前取消语义，不自动重试 |
| `cancelled_by_shutdown` | 否 | 否 | 保留恢复游标，按当前 shutdown/resume 语义续跑 |

具体次数、退避上限和总 deadline 在 WP2 进入 spec 时确定。必须同时存在 connect、read、单候选、单 provider 和单 job deadline，且外层 timeout 能终止或隔离底层工作，而不是只停止等待。

### 5.3 provider/job 聚合优先级

候选完成顺序不得影响 provider/job 结果。聚合时先排除 `cancelled_by_winner`，再按以下优先级计算：

1. 任一候选产生已接受目标资产：provider attempt 成功；同目标其它候选按 winner 取消。
2. 没有成功，但存在 `cancelled_by_user`：保持用户取消终态，不被 retryable 结果覆盖。
3. 没有成功或用户取消，但存在 retryable failure 或 open circuit：provider/job 保持 retryable；保留最早 due time 和全部失败摘要。
4. 没有 retryable，但存在 `authentication_failed`，或当前策略规定必须由原 access context 恢复的 `interactive_challenge`/`access_denied`：pause。
5. 只有 terminal candidate failures：当前 provider 耗尽并继续 source plan；全部 provider 耗尽后 job 进入现有 terminal failure/missing 语义。
6. `cancelled_by_shutdown` 不单独决定业务终态；它保存未完成位置，下一次从 resolver/candidate 游标恢复。

同一聚合必须覆盖 paused、retryable、denied、invalid 和 cancelled 的排列组合测试，并与 P5 现有“任一 retryable/open circuit 保持 retryability”的规范一致。

## 6. 工作包

| 编号 | 工作包 | 主要交付物 | 依赖 | 复杂度 | 状态 |
|---|---|---|---|---|---|
| WP0 | 基准、错误分类与边界修复 | 固定语料、报告 schema、MIME 规范化、流中断测试 | 无 | M | 待批准 |
| WP1 | acquisition 内部候选模型 | 运行时/持久化模型、codec 扩展、去重/脱敏规则、resolver adapter | WP0 | L | 待批准 |
| WP2 | 共享 CandidateExecutor | URL/预算/redirect/下载/验证/重试/attempt details | WP1 | L | 待批准 |
| WP3 | 多候选 resolver 与 provider 准入 | OpenAlex、Unpaywall、Crossref 优先；provider checklist | WP2 | M/L | 待批准 |
| WP4 | 受限 landing-page translators | parser registry、站点 fixture、身份/附件过滤 | WP2、WP3 数据 | L | 待批准 |
| WP5 | 保守批量调度与扩展吞吐 | P0 单 worker/30 秒节奏，后续有界并发、全局预算、resume | WP0；并发扩展依赖 WP2/M2 基线 | L | 产品默认已确认，待进 spec |
| WP6 | browser/session/institutional adapter | 独立安全设计、会话隔离、人工登录、清理语义 | WP2-WP5 | XL | 待研究 |
| WP7 | provider 运维闭环 | 准入模板、健康检查、复核日期、退役流程 | WP0 | M | 待批准 |
| WP8 | 可解释排序与来源健康建议 | 回放统计、分桶 EMA、探索下限、排序解释、健康趋势、配置建议 | WP2、足量 attempt | M | 待研究 |
| WP9 | 统一配置与运行前自检 | 扩展现有 TOML、provider/key/代理/浏览器/容量检查、保守模式 | WP0、WP7 | M | 方向已确认，待进 spec |
| WP10 | 自动下载与失败诊断 UX | 统一入口、状态、失败历史、建议、报告、分类重试、暂停/继续 | WP0；候选增强依赖 WP2 | L | 方向已确认，待进 spec |
| WP11 | 共享代理执行 | 普通 HTTPS 与浏览器共享 HTTP/HTTPS/SOCKS 配置、连通性和失败分类 | WP2；浏览器侧依赖 WP6 | L | 方向已确认，待进 spec |

### WP0：基准、可观测性与已知边界缺陷

交付内容：

1. 建立版本化的离线 fixture 集，覆盖多 location、参数化 MIME、HTML 伪 PDF、截断流、慢读、429、5xx、redirect 和超限响应。
2. 建立可重复的现场 DOI 分层集：已知公开资产、已确认当前配置可访问的 publisher/API 资产、resolver 有记录但预期无全文候选、已知候选存在但当前执行会拒绝/失效四组分开统计。
3. 报告 resolver 数、原始/去重候选数、逐候选分类、winner、耗时、字节数和资产 hash；所有 URL 先脱敏。
4. 修复参数化 `Content-Type` 等 transport/model 边界规范化问题，并增加回归测试。
5. 证明外层 deadline 后不会遗留继续运行的同步下载线程，或明确记录采用的隔离策略。
6. 为失败分类增加稳定的用户原因和建议动作映射；原始异常只作为受控诊断，不直接充当产品文案。

退出标准：离线分类 100% 确定性；相同输入重复执行报告结构一致；现场失败可拆分为覆盖、配置/访问、远端、网络、内容和本地实现六类；本地实现缺陷不计入 provider 覆盖率。

### WP1：内部统一候选层

交付内容：

1. 在 acquisition 内新增 `RuntimeDownloadCandidate`、`DurableCandidateState`、封闭枚举和严格 codec 扩展，不先改变公开 provider 协议。
2. 为当前单结果 provider 增加兼容 adapter，使其产生一个候选并继续走现有 orchestrator。
3. 实现 URL identity、去重、顺序稳定性、过期和敏感 query 脱敏规则。
4. 明确 P5 source-entry candidate、provider attempt 与 URL candidate attempt 的层次，以及 re-resolve/resume 游标。

退出标准：旧 provider 行为与 attempt/job 终态不变；现有 P5 codec 与新 URL-candidate details 的职责无歧义；codec 对缺字段、未知版本和破损数据 fail closed；durable state 不含凭据或完整签名 URL；重启能重新解析未完成候选且不重复执行已终结候选。

### WP2：共享候选执行器

交付内容：

1. 把 URL policy、host budget、redirect、敏感 header、下载、sniffing、validation 和失败分类收敛到共享 executor。
2. 按第 5 节决策表执行有界重试、换候选、pause 和 retryable 聚合。
3. 支持流式有界读取；未完整下载和未通过 validation 的字节不得进入 coordinator。
4. 保持 race winner、用户取消、进程关闭和已启动同步工作的清理语义明确。

退出标准：第一个候选遇到 403、404、HTML、损坏、超时或截断时按策略尝试第二个；重复 URL 只执行一次；429 遵守 `Retry-After` 上限；第 5.3 节全部混合结果排列产生确定性终态；取消/关闭后无线程、任务或 `.part` 泄漏。

### WP3：多候选 resolver 与 provider 准入

首批顺序由现场失败分布决定，默认优先 OpenAlex、Unpaywall、Crossref，因为当前实现已能看到多个 location/link 却通常只消费第一个。

每个 provider 候选工作包获准进入执行计划前必须填写：

- 支持标识符、资产角色、resolver 端点和候选字段。
- 认证方式、环境变量名、凭据生命周期和匿名路径。
- 官方预算、项目预算、超时、`Retry-After` 和健康检查。
- 常见状态码与稳定失败分类映射。
- fixture 来源、最后核对日期、维护责任和退役条件。
- 是否返回短期签名 URL、用户信息 query、landing page 或补充材料。

退出标准：每个首批 resolver 至少有“多候选首个失败后成功、全候选耗尽、重复候选、无候选、敏感 query”五类离线测试；`provider-operations.md` 与 README/config 按责任映射同步。

新增来源不因名称直接进入开发。DOAJ、PMC、CORE、OpenAlex Content API 及更多出版社先完成准入表，再依据基准中的增量唯一候选数和维护成本排序。

#### WP3-SH：Sci-Hub 显式 provider

项目 owner 已允许 Sci-Hub 作为技术方向进入候选范围；这不等于工作包已经批准排期。它只能在 M1 候选 executor 稳定后进入 requirements/spec，并满足以下设计：

1. provider 默认关闭，仅接受用户显式配置的一个或多个 HTTPS base URL；不从 legacy 使用的第三方 HTTP 页面自动发现镜像。
2. 第一版只接受规范化 DOI。每个 base URL 生成一个 `scihub_page` runtime candidate，按配置顺序串行执行；每个 host 独立使用 budget、health 和 circuit，不默认并发轰炸镜像。
3. 页面响应使用更小的 HTML 大小上限。受限 parser 只解析 fixture 验证过的 download panel、明确 PDF anchor、iframe 和 embed，不执行 JavaScript。
4. parser 解析绝对、相对和 protocol-relative URL，产出新的 PDF runtime candidate。页面成功不算资产成功；PDF 候选仍须经过 URL policy、redirect、大小、MIME、PDF、文章身份和 RawAsset 验收。
5. 完整页面/PDF URL 只存在于运行时。durable state 保存 base URL 代号、脱敏 URL identity、mirror index、parser rule version、状态和 hash；重启从 DOI 重新解析页面。
6. CAPTCHA、登录页或交互挑战分类为 `interactive_challenge`；普通 HTTP provider 不猜测或自动执行交互，后续 browser adapter 可在获批后消费该状态。
7. 失败分类复用第 5 节：镜像网络失败、DOI 页面 404、页面无候选、挑战页、HTML 伪 PDF、截断/损坏和身份错配不得压成一个“下载失败”。
8. provenance 至少记录 DOI、provider、非敏感 mirror id、页面/PDF candidate id、parser rule version、最终 URL 脱敏身份和 RawAsset hash。

WP3-SH 离线验收至少覆盖：首镜像失败后第二镜像成功、页面无记录、挑战页、结构变化、相对/跨 host PDF、HTML 伪 PDF、参数化 MIME、截断/超限 PDF、重复 URL、重启重新解析和敏感 query 不落盘。不得调用 legacy `ScihubClient`，不得使用 `verify=False`，不得直接写目标文件。

### WP4：受限 landing-page translator

交付内容：

1. translator 只消费已下载、大小受限的 HTML/JSON，不执行页面 JavaScript。
2. 首版只解析 `citation_pdf_url`、标准 `link/meta`、明确的 iframe/embed/object 和经批准的站点 JSON 字段。
3. 按目标 DOI、canonical URL、标题或 provider 稳定 id 核对文章身份。
4. 区分主文、补充材料、数据附件和未知附件；未知角色不得当作 primary PDF 接受。
5. 站点 parser 与声明式 profile 分离，profile 不承载复杂选择器脚本。

退出标准：每个站点具备保存的离线 fixture，覆盖相对 URL、重复链接、补充材料、错配文章、无 PDF、HTML 挑战页和结构变更；结构未知时返回稳定“无候选/解析不支持”，不得猜测直链。

### WP5：保守批量调度与扩展吞吐

交付内容：

1. P0 先复用当前顺序 manifest 路径，增加可持久恢复的正文级全局节奏、每日上限和用户任务控制，不等待多候选能力。
2. M3 再增加进程内有界 worker pool，所有论文共享全局 host budget、provider health 和 circuit state。
3. 复用现有 catalog job 幂等与内部 pause/resume/claim 语义；不新建第二套队列数据库或第二种暂停状态。
4. 支持 graceful shutdown、resume、每批上限、每日上限和单 work 失败隔离。
5. 输出 JSON/JSONL 批次报告，按稳定错误类别聚合，不复制权威状态。
6. 增加正文级全局节奏控制：默认 worker=1，每 30 秒最多启动一篇新文献；provider 更慢预算和 `Retry-After` 优先。
7. 暂停、关闭、限流等待、每日上限耗尽和 circuit-open 期间不得通过其它调度路径绕过节奏控制。

P0 退出标准：默认配置下任意相邻新文献的启动时间间隔不少于 30 秒；达到每日上限后不再启动新文献；用户 pause、安全停止和重启分别复用现有 durable 状态，成功 work 不重复。

M3 完整退出标准：固定离线批次下不会超过 per-host 并发/速率；重复 work 收敛；中断后只续跑未完成项；单项异常不终止整个批次；报告计数能与 catalog attempt/job 对账。

### WP6：browser/session/institutional adapter

该工作包必须单独完成威胁建模和人工批准后才能进入 spec。最低设计要求：

- adapter 运行在明确隔离边界，core/catalog 只看到非敏感 context reference 和候选结果。
- cookie jar、local storage、登录表单数据和 token 不进入 durable plan、普通日志或测试 fixture。
- 登录必须由用户显式发起；支持 session 过期、撤销、清理和并发隔离。
- 浏览器捕获的响应仍通过 URL policy、大小限制、validation 和 coordinator。
- 失败或关闭时终止浏览器进程并清理临时 profile；持久 profile 必须由用户明确配置位置和生命周期。

退出标准：默认配置不启动浏览器进程；没有用户显式动作时不得开始登录；两个并发 access context 的 cookie/local storage 不互见；session 过期和用户撤销后不再执行候选并返回稳定暂停/重新登录状态；临时 profile 在取消、崩溃和正常关闭三种路径均清理，持久 profile 只在显式配置位置创建并遵守已批准的保留/删除生命周期；日志、catalog 和 fixture 中无 session 值；捕获响应仍通过 CandidateExecutor 和 validation；显式关闭 adapter 后普通 acquisition 行为不变。

### WP7：provider 运维闭环

把 `provider-operations.md` 的最小信息变为 provider 变更模板和 review checklist。对 key 失效、API 版本变化、限流和真实下载事故，记录证据等级、复核日期和最小不敏感复现。超过约定复核窗口且无法验证的 provider 不自动删除，但健康排序和用户报告必须能说明“配置/契约待复核”。

退出标准：所有活动 acquisition provider 均有完整准入记录、维护责任、最后核对日期、健康检查和退役条件；配置/契约待复核状态能进入批次报告；新增 provider 的文档缺失会被 review checklist 阻断。WP7 从 M0 建立模板，此后作为 M1-M5 每阶段的持续退出门。

### WP8：可解释排序与来源健康建议

只有 WP2 产生足量、分类可靠的 URL candidate attempt 后才实施。统计按 provider、host、access method、profile version 和非敏感 access-context class 分桶；设置最小样本、衰减、探索下限和静态优先级兜底。排序结果必须输出不含敏感信息的 reason code，并可用固定历史回放重复计算。相同聚合数据同时生成来源健康趋势和配置建议，例如 key 疑似失效、持续限流、代理不可达或某来源长期无增量命中。

退出标准：固定 attempt 回放产生逐字节一致的排序结果、reason code、健康趋势和建议；每条建议可追溯到稳定失败分类而不显示敏感值；低样本候选保持已批准的探索下限；禁用动态排序后恢复静态顺序；统计数据删除或损坏时 fail closed 到静态排序；不得按 DOI、用户身份或凭据值形成高基数分桶；建议不得自动修改配置。

### WP9：统一配置与运行前自检

现有严格 TOML loader、权限检查和 CLI 注入继续作为唯一配置基础，不创建第二套配置系统。扩展内容包括：

1. 为缺失 provider key、OpenAlex key、Sci-Hub base URL、代理、浏览器/session、正文间隔、批次上限、每日上限和容量预检增加严格字段。
2. 支持 API key 直接写入权限合格的 TOML，并保持环境变量覆盖；诊断只显示“已配置/缺失/失效”，不回显值。
3. 提供配置自检：schema/权限、路径/容量、provider 最小健康检查、代理连通性、浏览器可启动性、会话状态和最终生效策略。
4. 自检按检查项分别给出 `ready`、`missing`、`invalid`、`unreachable`、`needs_login`、`not_checked`，单项失败不掩盖其它结果。
5. 输出实际正文 worker、30 秒默认间隔、provider 更慢预算、批次/每日上限和启用来源，让用户在开始前确认。

M0 退出标准：一份 TOML 可以描述当前普通来源、保守节奏、批次/每日上限和已批准凭据；未知字段继续 fail closed；含凭据文件继续要求安全权限；自检不下载正文、不打印 secret，可发现缺/失效 key 和磁盘不足；尚未实现的代理、浏览器和 session 检查明确返回 `not_checked`，不得冒充成功。

完整退出标准：WP11/WP6 分别交付后，同一 TOML 可描述代理、Sci-Hub 和浏览器场景，自检可发现代理失败、浏览器不可启动和 session 过期；同一配置重复自检结果稳定。

### WP10：统一自动下载与失败诊断 UX

1. 提供一个面向普通用户的自动下载入口，接受单篇标识符、文献清单或 discovery 输出；内部仍通过 `DownloadManifest` 连接 discovery 和 acquisition。
2. 提供状态视图：总数、成功、失败、等待、暂停、当前项目、来源、下一允许请求时间和可解释的预计剩余时间。
3. 为 catalog failure/attempt/event 增加只读查询层，不通过 raw SQL 或解析内部 JSON 为用户提供功能。
4. 每个失败项目输出稳定 reason code、简明说明、来源/阶段、retryable、next retry、已尝试路径摘要和 action code。
5. 支持全部失败项、指定失败类别、指定 provider 或指定任务的重试；配置修复后不需要重跑成功项目。
6. 支持 pause、resume、graceful stop 和人工处理清单；需要登录/验证码的项目不阻塞其它可执行项目。
7. 提供终端摘要和脱敏 JSON/JSONL 报告；原始异常、host/path 和 request id 只进入详细诊断层。

建议动作使用封闭集合，例如 `update_config`、`replace_key`、`check_subscription`、`check_proxy`、`login_required`、`wait_and_retry`、`provide_url`、`free_disk_space`、`report_internal_error`。系统只建议，不自动改配置。

M0 退出标准：用户不读取数据库即可查看当前 acquisition job/attempt/failure 历史；已有失败被映射到稳定 reason/action；统一入口可提交单篇或 manifest；用户可以暂停、安全停止、恢复和重试全部失败项；成功项目不重复下载；报告完成脱敏。

M3 完整退出标准：同一失败在终端和 JSON 报告中的 reason/action 一致；可以按网络失败、配置缺失、key 已修复、provider 等类别重试；候选尝试摘要完整；需要人工处理的项目不阻塞其它任务；中断后状态、建议和重试范围保持一致。

### WP11：共享代理执行

1. 在 network 层增加统一代理 transport/config boundary，普通下载和浏览器 adapter 只消费同一份已验证代理配置。
2. 支持 HTTP、HTTPS 和 SOCKS 代理，并明确 DNS 解析、TLS 验证、redirect、超时和敏感 header 在代理路径上的行为。
3. 代理连接失败、认证失败、DNS 失败和目标 host 失败使用不同稳定原因；不得把代理凭据写入 URL、日志、catalog 或报告。
4. 配置自检使用最小无正文请求验证代理；浏览器能力未安装时仍可验证普通 HTTPS 代理路径。
5. 关闭代理后恢复普通 secure transport；代理不能成为绕过 URL policy、大小、validation 或 CandidateExecutor 的平行下载器。

退出标准：普通下载和浏览器使用同一代理选择结果；HTTP/HTTPS/SOCKS fixture 覆盖直连、认证、DNS、超时和关闭回退；代理 secret 全程不落入报告；关闭代理不改变普通 provider 行为；浏览器未启用时普通代理仍可独立工作。

## 7. 分阶段实施顺序

| 阶段 | 范围 | 进入条件 | 退出决策 |
|---|---|---|---|
| M0 产品基础与可信基线 | WP0、WP5 P0、WP7 模板、WP9 M0、WP10 基础 | owner 批准 P0 默认值、指标、四类 cohort 和 fixture 范围 | TOML 自检、30 秒节奏、状态/失败查询、任务控制和可信基线可用 |
| M1 候选内核 | WP1、WP2 | M0 通过；候选字段和持久化边界获批 | 单 provider 多候选离线验收通过 |
| M2 首批覆盖 | WP3 首批 resolver | M1 通过；各 provider 准入表完成 | 证明增量唯一候选和失败可诊断 |
| M3 页面与扩展批量 | WP4、WP5 并发扩展、WP10 完整 | M2 有真实失败分布与基线；站点/吞吐目标明确 | translator、批量并发、分类重试和最终报告分别通过 |
| M4 排序与健康建议 | WP8 | 足量可靠 attempt 数据 | 回放可重复、低样本不饥饿、健康趋势与建议可追溯 |
| M5 复杂访问 | WP6、WP11 | M1-M3 稳定；代理/session 安全设计和人工批准 | 代理可独立使用，browser/session 作为默认关闭 adapter 发布 |

阶段不能仅按代码完成宣布退出。每个阶段必须提供：批准后的 requirements/spec diff、实现与直接测试、离线验收报告、适用的现场报告、文档同步清单和回退说明。

WP9 和 WP10 是跨阶段产品工作：M0 交付当前能力范围内的 TOML 自检、统一自动下载、失败只读查询、保守默认值和用户任务控制；M1/M2 接入候选级原因与配置建议；M3 随批量扩展完成分类重试和最终报告。WP9 对尚未交付的代理/浏览器检查返回 `not_checked`，待 WP11/WP6 完成后扩展。不能等所有 provider 完成后才补用户诊断。

## 8. 测试与验收矩阵

| 层级 | 必测内容 | 禁止的替代证明 |
|---|---|---|
| 模型/codec 单元测试 | 字段校验、未知版本、缺字段、URL 脱敏、确定性 id | 只测试 happy path |
| resolver 单元测试 | 零/一/多候选、顺序、去重、过期、角色、身份错配 | 连接真实 provider 才能通过 |
| executor 单元测试 | 状态码、重试、deadline、redirect、header、流截断、上限 | 只给完整 `bytes` |
| validation 单元测试 | 参数化 MIME、HTML、magic/EOF、损坏、加密/空白/preview PDF、身份冲突 | 只检查扩展名或 HTTP 200 |
| orchestrator 集成测试 | URL candidate fallback、race、re-resolve/resume、pause、混合失败聚合、三类取消 | mock 掉本次要证明的状态迁移 |
| storage 集成测试 | 未完整内容不发布、相同内容收敛、crash recovery | 删除或覆盖损坏证据 |
| CLI/配置测试 | 30 秒默认节奏、自检、显式 provider、缺/失效凭据、代理/session、报告、分类重试、批量恢复 | 读取开发者本机环境作为 fixture |
| architecture/docs gate | 模块依赖、真相源、配置和 provider 表同步 | proposal 或 execution plan 冒充当前行为 |
| 现场验收 | 固定分层 DOI、固定配置、版本/日期、脱敏报告 | 用单次小样本宣称通用成功率 |

测试 fixture 不保存第三方受限正文。PDF 结构场景优先用仓库内程序化最小样本；页面 translator fixture 只保留完成解析所需的最小脱敏 HTML 片段，并记录来源结构版本和获取日期。

## 9. 基准与指标

### 9.1 基准协议

每次可比较基准必须固定并记录：

- DOI/标识符集合版本、四类 cohort 的证据依据、每组数量、最后复核日期和刷新规则。
- 启用 provider、profile 版本、凭据是否配置（仅布尔值）、网络区域和运行日期。
- connect/read/candidate/provider/job timeout、重试、并发和 host budget。
- 成功定义：指定角色的资产通过 validation、目标文章身份核对并完成 RawAsset 接收；仅解析到 URL、HTTP 200 或拿到有效但错配的 PDF 不算成功。
- 冷/热 cache 状态；重试运行不得与首次运行混算。

### 9.2 最小指标集

| 指标 | 用途 |
|---|---|
| resolver coverage | 有至少一个候选的 work 比例 |
| unique candidate yield | 每个 resolver 提供的去重后独有候选数 |
| candidate execution success | 已执行候选中通过 validation 的比例 |
| accepted asset rate | 请求中最终产生目标角色 RawAsset 的比例 |
| identity verification coverage | accepted asset 中完成目标身份核对的比例 |
| false acceptance | 资产与目标身份错配但被接收的数量，目标为 0 |
| local rejection rate | 因本地 contract/policy 缺陷失败的比例，目标为 0 |
| fallback recovery | 首候选失败但后续候选成功的数量和比例 |
| p50/p95 latency | resolver、candidate 和整 job 分层耗时 |
| request amplification | 每个 accepted asset 的 resolver/HTTP 请求数 |
| retry amplification | 每个 job 的额外重试请求数 |
| batch throughput | 固定预算下单位时间完成的 work 数 |
| provenance completeness | attempt 分类、候选身份、winner、hash 可对账比例，目标 100% |

M0 只建立可信基线，不承诺成功率提升。M1 以 fallback recovery、local rejection=0 和 provenance completeness 为主；M2 以后才按各来源的增量 accepted asset 和请求放大评估覆盖收益。

## 10. 安全、敏感数据与运维门

- 完整签名 URL、email query、cookie、Authorization、API key、session id 和用户身份视为敏感数据。
- 日志和 durable details 默认只保留 scheme、host、脱敏 path/query、状态码、错误类别、耗时和大小；必要 path 可存 hash。
- redirect 每跳复检；跨 host 默认剥离敏感 header；referrer 默认关闭并按候选显式最小开放。
- provider 响应体只在成功 validation 后进入 RawAsset；失败 HTML、认证页和挑战页不持久化为文献资产。
- 磁盘满、staging 写失败、hash/size 不符、target 冲突和 catalog 提交失败继续沿用 fail-closed 与恢复语义。
- 批量下载前必须增加容量预检、可配置的批次上限和每日上限；本提案不建议引入自动删除 RawAsset 的保留策略。
- 新 provider 或访问方法必须记录配置、预算、超时、健康检查、证据等级、最后复核日期和退役办法。

## 11. 发布、回退与兼容

1. 新候选路径先通过内部 feature flag 或显式配置启用；现有单候选 adapter 保留到 M2 稳定。
2. CandidateExecutor 首次 rollout 只启用一个多 location resolver；固定 canary 集连续两轮满足 local rejection=0、false acceptance=0、provenance completeness=100%，且请求放大不超过 M0 批准上限后再扩展。
3. translator 按站点独立开关；任一 identity mismatch、fixture 结构未知误接收或请求越界立即关闭该站点 translator，并回到上游候选路径。
4. 批量 worker 默认并发 1，正文默认每 30 秒最多开始一篇；只有 budget violation=0、取消/关闭任务泄漏=0、catalog 对账=100% 后才允许用户显式调高。关闭批量模式后仍可逐项 resume。
5. 动态排序独立开关；回放不确定、低样本饥饿或指标损坏时回退静态顺序，不删除 attempt 历史。
6. browser/session adapter 和 Sci-Hub provider 分别默认关闭；关闭后不得改变普通 provider 的 source plan、状态和配置要求。
7. 回退只关闭对应 resolver/executor/translator/scheduler/ranker/adapter 路径，不回滚或删除已接受 RawAsset、attempt、failure 和 event。
8. codec 必须保留读取上一版本 details 的能力；无法理解的新版本 fail closed，不猜测续跑位置。
9. 如需 catalog migration，必须单独制定迁移、备份、回滚和旧数据读取计划，并经过人工门禁。
10. 现场基准失败不能通过放宽 HTTPS、redirect、size、PDF validation、身份核对或凭据日志边界来“修复”。

## 12. 近期可执行 backlog

以下顺序是技术依赖建议，不代表已经承诺开发：

1. `DL-0001`：定义稳定 reason/action、脱敏 report schema、fixture 清单和产品状态文案。
2. `DL-0002`：扩展当前 TOML 的 P0 字段并提供不下载正文的配置自检。
3. `DL-0003`：建立 failure/attempt 只读查询、状态和脱敏报告。
4. `DL-0004`：实现默认单任务、每 30 秒一篇、批次/每日上限和用户任务控制。
5. `DL-0005`：提供统一自动下载、状态、暂停/继续和按现有失败类别重试入口。
6. `DL-0006`：修复参数化 `Content-Type`，增加网络流截断、慢读、硬 timeout 和清理测试。
7. `DL-0007`：定义 `RuntimeDownloadCandidate`、`DurableCandidateState` 和敏感 URL identity。
8. `DL-0008`：实现单候选兼容 adapter、URL-candidate details codec 和 CandidateExecutor。
9. `DL-0009`：将 OpenAlex、Unpaywall、Crossref 改为返回全部合格候选。
10. `DL-0010`：运行 M1 离线验收和分层现场基准，决定 M2 provider 顺序。
11. `DL-0011`：完成 Sci-Hub WP3-SH 独立准入和实施审批。
12. `DL-0012`：实现共享 HTTP/HTTPS/SOCKS 代理 transport 和普通下载自检。
13. `DL-0013`：增加 landing-page translators 与扩展批量并发。
14. `DL-0014`：接入浏览器/session，并完成代理共享与完整配置自检。
15. `DL-0015`：基于可靠 attempt 数据提供排序、来源健康趋势和配置建议。

每个 backlog 项获准进入执行计划时必须补充 owner、状态、依赖、受影响文件、明确 AC、验证命令和文档同步范围。工作项状态建议统一为 `proposed -> approved -> in_progress -> verified -> landed`，无法继续时使用 `blocked` 并记录阻塞证据；这不替代执行计划文档自身的 front matter 状态。

## 13. 待 owner 决策

| 决策 | 建议默认值 | 决策影响 |
|---|---|---|
| candidate details 是否先嵌入现有 attempt | 是，先避免 schema migration | WP1 范围和恢复模型 |
| 完整执行 URL 是否允许短期写入加密本地状态 | 否，第一版只保存在内存 | 签名 URL 的跨进程 resume |
| M0/M1 现场 DOI 集规模 | 每组至少 20，另保留小型 smoke 子集 | 基准成本与统计解释力 |
| 首批多候选 resolver | OpenAlex、Unpaywall、Crossref | M2 顺序 |
| translator 首批站点 | 由 M2 失败分布选择，不预先按知名度选择 | WP4 维护成本 |
| Sci-Hub 排期 | 技术方向已允许；作为 WP3-SH 独立显式 provider，在 M1 稳定后另行批准排期 | 不得成为架构例外 |
| browser/session 是否使用独立进程 | 建议是 | WP6 隔离和清理复杂度 |

## 14. 从 proposal 晋级为执行计划的检查表

- [ ] owner 已批准具体工作包和非目标。
- [ ] requirements/spec 已写入行为、状态、配置和 AC，planning 只保留路线与证据。
- [ ] 是否需要 ADR、schema migration 或安全人工门禁已经明确。
- [ ] implementation、直接测试、fixture 和责任文档范围已经列出。
- [ ] live-provider 测试只作为补充验收，CI 不连接真实 provider。
- [ ] 凭据、签名 URL、cookie、用户身份和响应正文的留存策略已评审。
- [ ] rollout、feature flag/显式配置、回退和旧 codec 读取策略已确定。
- [ ] 成功指标、基线版本和“不回归”指标已确定。

## 15. 代码质量与 Harness 约束

当前根目录 `HARNESS.md` 已经要求边界解析、明确类型、稳定错误、单一职责、兼容 adapter 和避免平行体系，本提案不建议创建第二份代码规范。后续获批执行计划还必须遵守：

- provider 只负责来源特有的解析和边界转换；网络、重试、限速、验证、存储和失败记录必须复用共享组件。
- TOML 只经过现有 strict loader；CLI 不自行解析另一套配置，浏览器和代理 adapter 也不读取散落环境变量。
- reason code、action code、provider、transport 和 access method 使用封闭类型或注册表，不在各 provider 复制 magic string。
- 自动下载入口只编排现有 discovery/acquisition/catalog 能力，不复制其状态机和持久化逻辑。
- 每个共享抽象必须有两个以上真实调用方或明确消除重复；不为未来猜测预建通用框架。
- provider fixture、错误映射和直接测试与实现一起增加；不得用真实网络作为 CI 通过条件。

当实现出现可机械识别的重复或边界违规时，优先给现有 `scripts/harness.py` 增加 architecture/docs 检查，例如禁止 v2 导入 legacy downloader、禁止 provider 绕过 CandidateExecutor、禁止新建非 TLS 下载 client。无法可靠机械判断的“优雅程度”和抽象质量继续由集中代码审查保证，不引入只统计行数或表面重复率的噪声门禁。
