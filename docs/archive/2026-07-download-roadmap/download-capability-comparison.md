+++
document_type = "proposal"
status = "under-review"
created = "2026-07-22"
+++

# 下载能力对比与吸收评估

> **归档状态：已被替代。** 本文仅保存 2026-07-23 产品重置前的对比证据，不是当前需求、产品方向或实施授权。当前方向见 [ADR 0002](../../adr/0002-work-centered-literature-library.md)和[文献库执行计划](../../planning/literature-library-execution.md)。下文 front matter 状态和正文保持历史原样。

- 记录日期：2026-07-22
- 对比对象：SciRetriever 当前 v2、`scansci-pdf`、Zotero 客户端与 translators
- 权威边界：[ADR 0001](../../adr/0001-sciretriever-scope-and-boundary.md)
- 相关台账：[能力差距台账](capability-gaps.md)
- 产品方向：[文献自动下载产品方案](download-product-shape.md)
- 实施草案：[文献下载实施提案](download-implementation-proposal.md)

## 1. 目的与口径

本文比较三个项目在全文候选发现、下载执行、页面解析、验证、调度、会话和证据留存方面的方法，用于判断 SciRetriever 可以系统吸收哪些设计。它是评估证据，不定义当前产品行为，也不跟踪实施状态；候选工作包、依赖和验收门见[文献下载实施提案](download-implementation-proposal.md)。

对比依据如下：

- SciRetriever 以活动的 `src/sciretriever/` 实现、测试和 2026-07-21 现场基准为准，不使用归档或大写 legacy 代码推断当前能力。
- `scansci-pdf` 以工作区参考快照和 canonical repository 的提交 `5e4a6f20ee32b16c0fcb52e37b66ca7a0b31edc5` 为准。
- Zotero 以客户端提交 `621c0fbb9134956329471da7b3ebe11deedb7029` 和 translators 提交 `588716b5e32b810ef669f645ec8a161e64f09df5` 为准；其托管 OA 服务端实现不属于已审计的开源客户端代码。

三个项目没有在相同 DOI、凭据、网络、超时和成功判据下运行，本文不比较项目间的下载率数字。

## 2. SciRetriever 当前基线

2026-07-21 的分层现场基准使用 20 个 DOI，其中 OA 组 10 篇、OpenAlex 标记为 `closed` 的组 10 篇。结果为：

| 分组 | 尝试 | 成功 | 观察成功率 |
|---|---:|---:|---:|
| OA | 10 | 3 | 30% |
| `closed` | 10 | 3 | 30% |
| 合计 | 20 | 6 | 30% |

该数字只描述当日样本、凭据、网络和 provider timeout 配置下的结果，不能表述为 SciRetriever 的通用下载成功率。`closed` 是聚合元数据分类，不是版权或授权结论；该组成功也不等同于通过出版社授权 API 获得付费全文。

现场失败混合了不同责任边界：resolver 没有 PDF URL、候选返回 `403`、凭据失效、网络或 provider 超时、目标不在来源覆盖范围，以及响应已经下载但媒体类型规范化失败。特别是以下两类问题说明当前低命中率不只是“来源数量不够”：

1. OpenAlex、Unpaywall 等 resolver 可能返回多个 location，当前 provider 通常选择第一个 URL；该 URL 失败后不会继续同一 provider 内的其它候选。
2. Crossref 样本出现带参数的合法 PDF `Content-Type` 被严格媒体类型模型拒绝，说明边界规范化缺陷会把已获取内容误记为失败。

## 3. 下载能力对比

| 维度 | SciRetriever 当前 v2 | `scansci-pdf` | Zotero / translators | 对 SciRetriever 的判断 |
|---|---|---|---|---|
| 候选表示 | `SourcePlan` 表达 provider、tier、priority 和无凭据配置引用；`ProviderContent` 是 provider 最终返回的单份字节内容，没有统一的 URL/pageURL/referrer 候选对象 | 同时构造出版社直链、OA/repository 来源和页面提取 URL，并按策略分层 | file resolver 产生 DOI、item URL、PMCID、OA 和 custom resolver 候选，下载器消费规范化后的有限候选集合 | 需要在 provider 级计划之下新增统一下载候选层，而不是再增加一套顶层工作流 |
| OA 候选发现 | 已接入 arXiv、Crossref、Unpaywall、Europe PMC、OpenAlex、Semantic Scholar 等路径 | 组合 Unpaywall、OpenAlex、Semantic Scholar、DOAJ、Crossref、Europe PMC、CORE、PMC 等来源，另通过私有 OA search API 提供额外路径 | 客户端调用 Zotero 托管的私有 OA search API；服务端排序和选择逻辑未在已审计客户端中公开 | 继续直接接入公开 OA API；不能把 Zotero 托管服务的未知内部实现当作可复制能力 |
| 出版社候选 | 重点 profile 为 Elsevier、Wiley、Springer；通用 metadata provider 多只消费第一个明确 URL | 声明式 publisher profile、DOI/PII/article-number 路由和多个 URL 模板 | 大型 translators 语料按站点解析元数据、附件和中间页面 | 可吸收“声明式 profile + 少量受测 translator”模式，但不按供应商数量机械复制 |
| Landing page 解析 | 当前通用 acquisition 不解析 publisher landing page 的 PDF 候选 | 从 `citation_pdf_url`、链接、iframe、embed、object、脚本和站点路径规则提取候选，并过滤补充材料和错配文章 | 将 document 交给匹配的 web translator，提取附件或后续页面 | 这是统一候选层之后价值最高的覆盖扩展之一；解析器必须限制站点、字段和输出，不执行任意页面脚本 |
| 回退与竞速 | 支持 provider 间 serial/race、tier、健康排序、host budget、熔断、持久化 retry/resume；竞速会等待已启动同步线程 drain | 多来源和多 tier 并发竞速，首个有效文件获胜，并有 timeout 后文件扫描和机构来源回退 | 候选去重并限制尝试数量；直接 URL 失败后可尝试 pageURL，通过有界下载重试继续 | 保留现有 durable orchestrator；补齐同一 provider 内的候选级串行回退。不能把当前 race 描述为首个成功后立即返回 |
| 重试与限流 | 有 provider retry policy、HostBudget 和 CircuitBreaker | 对 `429`、`5xx` 和网络错误重试，另有来源级 timeout | 下载最多有界重试，限制 redirect，并按域控制请求节奏和连续失败 | 把重试决策从 provider 内散落逻辑收敛到统一 executor，并按错误分类决定换候选、退避或停止 |
| Referrer 与访问方法 | 没有统一表达 referrer、pageURL、access method 或 session context | 机构路径可携带 browser user-agent、referrer 和 cookies | 候选可携带 `referrer`、`accessMethod`，并使用 cookie jar 或隔离 cookie context | 普通 HTTPS 候选应支持最小、可审计 referrer；cookie/session 只能由隔离 adapter 持有，不能进入 durable plan 或 core/catalog |
| 浏览器与机构访问 | 未实现；`browser_required` 只是 profile 字段 | 支持 persistent browser context、可见 SSO、CARSI、WebVPN、EZProxy 等，另含反检测和灵活来源路径 | 支持普通浏览器环境、cookie 和 translator；没有观察到与 `scansci-pdf` 等价的机构网关编排 | 作为可选 adapter/plugin 实现；用户按需启用；默认关闭 |
| 内容验证 | 校验角色、MIME、大小、HTML 排除、PDF magic/EOF、可解析性、页数和单页 preview；网络层有 HTTPS、DNS pinning、重定向复检和响应上限 | 校验 magic、EOF、最小大小、响应类型，并用启发式拒绝疑似封面或预览 | 下载后 sniff 文件类型，只接受预期 PDF/EPUB，删除无效文件 | SciRetriever 已较强；应先修复媒体类型边界规范化，并增加候选与目标文章身份核对，而不是放宽验收 |
| 自适应排序 | `ProviderHealth` 参与运行期 provider 排序，但没有可审计、跨运行的候选方法/域级统计模型 | 持久化来源成功率和延迟 EMA，并据此排序 | 已审计客户端路径以配置和静态 resolver 顺序为主 | 可借鉴 EMA 思路，但必须按 host、方法、profile 版本和授权上下文分桶，设置最小样本与探索下限，保留排序解释 |
| 状态与 provenance | attempt、failure、event、source plan、provider、初始/最终 URL、candidate ID、hash、RawAsset 和 lineage 可持久化；RawAsset 不可变 | 主要面向成功文件、来源标签和本地分数，durable lineage 弱于 SciRetriever | 主要面向文献管理器附件创建和来源 URL，不提供 SciRetriever 式不可变证据链 | 保留 SciRetriever 的状态和证据模型；每个 URL 尝试都应成为可诊断 attempt，但签名 URL 和敏感 query 必须脱敏 |
| 许可证 | 项目自身规则 | Apache-2.0，可在遵守许可证、归属及存在时的 NOTICE 条件下复用代码；仍应优先按本项目边界重写 | Zotero 和 translators 为 AGPLv3 | 只借鉴 Zotero 行为和公开接口，清洁重实现；未经许可证评估不复制 AGPL 代码 |

## 4. 当前差距的根因判断

当前最重要的差距不是缺少另一个 provider 名称，而是 resolver 和 downloader 被压在同一个 `AcquisitionProvider.acquire()` 调用中：

```text
AcquisitionTarget
      │
      ▼
provider.resolve-and-download()
      │
      └── ProviderContent（单个最终结果或失败）
```

这个形状导致 provider 发现多个候选时难以统一去重、排序、逐个尝试和记录失败；landing page、referrer、短期签名 URL、授权上下文和最终资产也没有共同表达。顶层 `MultiSourceOrchestrator` 可以切换 provider，却看不到 provider 内第一个 URL 失败后本可继续尝试的候选。

建议目标形状为：

```text
AcquisitionTarget
      │
      ├── public OA resolvers
      ├── publisher/API resolvers
      └── bounded landing-page translators
                    │
                    ▼
          DownloadCandidate[]
                    │
             policy / ranking
                    │
                    ▼
            CandidateExecutor
                    │
          validate / accept / persist
                    │
                    ▼
          immutable RawAsset + lineage
```

这不是要求立即替换现有 provider 协议。实施时可以先让一个 provider 内部产生多个中性候选，由统一 executor 顺序执行；验证稳定后，再判断是否需要演进公开协议和 durable `SourcePlan` schema。

## 5. 吸收矩阵

### 5.1 可直接吸收的设计

| 方法 | 来源启发 | 本项目约束下的吸收方式 |
|---|---|---|
| 统一候选对象 | Zotero resolver/executor 分离、`scansci-pdf` 多 URL 构造 | 表达 URL、pageURL、role、media hint、resolver、referrer policy、priority、expiry 和非敏感 auth-context reference；禁止携带凭据值 |
| Provider 内候选回退 | 两个参考项目的有界多候选尝试 | 同一 resolver 返回的候选去重后逐个执行；每次失败保留错误类别和 provenance |
| Landing page translator | publisher router 与 Zotero translators | 先覆盖现场失败最多且有稳定 fixture 的站点；只解析允许的 HTML/JSON 元数据和链接，不运行任意脚本 |
| 声明式 publisher profile | `scansci-pdf` profile | 只描述域、DOI 前缀、URL 模板、候选过滤、资产角色、媒体类型和预算；复杂页面逻辑进入独立受测 translator |
| 有界重试和 redirect | Zotero 下载器、`scansci-pdf` HTTP retry | 在共享 executor 中按 `429`、`5xx`、timeout、无效内容、认证失败等类别做不同决策 |
| Referrer 传播 | 两个参考项目 | 只允许从已验证 landing page 到同一受信站点候选的最小传播；沿用敏感 header 跨域剥离规则 |
| 内容 sniffing | 三个项目 | 在 transport 边界规范化 MIME 参数，在 validation 层继续以字节和解析结果决定是否接收 |
| 可审计自适应排序 | `scansci-pdf` EMA | 统计按 provider/host/method/profile-version 分桶，记录样本量、最近更新时间和排序原因；低样本来源保留探索机会 |

### 5.2 需要独立适配的能力

- 浏览器自动化、cookie jar、persistent profile 和本地存储作为独立 adapter/plugin 实现，与 core/catalog 解耦。
- 机构访问（CARSI、EZProxy、WebVPN 等）由用户按需启用；凭据、cookie 与 session 不进入 durable source plan、日志或 provenance。
- 浏览器获取作为可选 adapter；默认关闭，用户按需启用。
- 短期签名 URL 不宜原样长期持久化；实施时按需处理脱敏与过期策略。


## 6. 评估得出的建议顺序

以下阶段是架构评估结论，不代表已经批准开发。后续决策以[文献下载实施提案](download-implementation-proposal.md)中的候选工作包、进入条件和退出门为输入；能力进入开发前仍须先更新 requirements/spec 并新建活动执行计划。

### 阶段 0：修正基准与可观测性

1. 固定四类 DOI 集：已知公开资产、已确认当前配置可访问的出版社/API 资产、resolver 有记录但预期无全文候选、已知候选存在但当前执行会拒绝或失效；分别记录证据与最后复核日期。
2. 把“无候选”“候选失效”“认证/授权失败”“限流”“网络失败”“内容无效”“本地模型拒绝”拆成稳定错误类别。
3. 记录 resolver 数、去重后候选数、逐候选结果、winner、耗时和最终资产 hash；报告不得包含凭据或敏感 query。
4. 修复 `Content-Type` 参数规范化等已知边界缺陷后重新建立基线。

完成标准：同一离线 fixture 产生确定性分类；现场报告可以区分覆盖问题、访问问题和本地实现问题。阶段 0 不设成功率提升承诺。

### 阶段 1：统一候选层和 provider 内回退

1. 定义无凭据的 `DownloadCandidate` 与稳定错误分类。
2. 从 OpenAlex、Unpaywall、Crossref 等可返回多个 location 的 resolver 开始，保留全部合格候选而不是只取第一个。
3. 由共享 executor 完成 URL policy、host budget、redirect、下载、验证和 attempt 记录。
4. 保持 `AssetAcceptanceCoordinator`、RawAsset 不可变发布和现有恢复语义不变。

完成标准：离线测试证明第一个候选 `403`、HTML、损坏或 timeout 时会尝试第二个候选；重复 URL 只执行一次；凭据和签名 query 不进入 durable state。

### 阶段 2：受限 landing-page translator

1. 根据阶段 0 的失败分布选择少量高价值出版社，不追求 translator 数量。
2. 优先支持 `citation_pdf_url`、标准 link/meta、受控 JSON 和稳定 URL 模板。
3. 每个 translator 使用保存的 HTML fixture 测试错配文章、补充材料、相对 URL、重复候选和无 PDF 页面。

完成标准：translator 只输出符合站点和文章身份约束的候选，且不执行任意 JavaScript、不连接真实站点完成测试。

### 阶段 3：批量吞吐与排序数据积累

1. 增加跨论文受控并发，复用 HostBudget、CircuitBreaker、幂等 catalog 和 resume，同时积累分类可靠的 URL-candidate attempt 数据。
2. 批量默认并发保持保守，先证明预算、取消、关闭、对账和恢复语义，再提高上限。

完成标准：同 host 并发和速率不超过 profile 预算；取消和关闭不会留下活动任务；批次报告与 catalog 对账。

### 阶段 4：可解释候选排序

在 URL-candidate attempt 数据足够且错误分类稳定后，引入成功率/延迟排序。统计必须分桶、可解释、可关闭，并为低样本候选保留探索下限。

完成标准：固定回放数据下排序可重复、可解释；关闭动态排序后恢复静态顺序；低样本候选不永久饥饿。

### 阶段 5：浏览器与机构访问可行性

该阶段必须另行安全设计和人工批准。只有前述普通路径完成并经过真实失败分布验证后，才评估独立 browser/session adapter；不得把它作为提升数字的默认捷径。

## 7. 推荐结论

1. **优先实施统一候选 resolver/downloader，而不是继续堆 provider。** 这是吸收两个参考项目共同优点、同时复用 SciRetriever 现有 durable orchestrator 和不可变证据链的最小架构变化。
2. **第二优先级是少量、受控、fixture 驱动的 landing-page translator。** 它解决 API 只给 landing page 或第一个直链失效的问题，但维护成本高，必须由真实失败分布驱动。
3. **先修本地误拒绝，再评价外部覆盖。** MIME 参数规范化、timeout 终止和错误分类会直接影响当前基准可信度。
4. **自适应排序有价值，但不能先于可靠 attempt 数据。** 否则 EMA 只会学习网络、凭据和错误分类噪声。
5. **浏览器和机构访问只做隔离、显式授权的后置能力。** 它不能削弱 HTTPS、凭据隔离、访问控制和 provenance 边界。

## 8. 证据索引

### SciRetriever

- `src/sciretriever/acquisition/models.py`：`AcquisitionProvider`、`ProviderContent`。
- `src/sciretriever/acquisition/plan.py`：无凭据的 `SourceEntry`、`SourcePlan`。
- `src/sciretriever/acquisition/multi_orchestrator.py`：provider 级 serial/race、retry/resume、attempt 和验收。
- `src/sciretriever/acquisition/providers.py`、`providers_p5.py`：当前 resolver/download 组合实现。
- `src/sciretriever/acquisition/validation.py`：PDF/XML/HTML 验收。
- `src/sciretriever/network/secure.py`：HTTPS、DNS、redirect、响应上限和敏感 header 边界。
- `src/sciretriever/storage/coordinator.py`：不可变 RawAsset 接收和恢复。
- 现场基准：工作区 `.sciretriever-download-benchmark-credentialed-20260721/report.json`。

### `scansci-pdf`

- [多来源构造与竞速](https://github.com/Rimagination/scansci-pdf/blob/5e4a6f20ee32b16c0fcb52e37b66ca7a0b31edc5/src/scansci_pdf/sources/__init__.py)
- [publisher PDF router](https://github.com/Rimagination/scansci-pdf/blob/5e4a6f20ee32b16c0fcb52e37b66ca7a0b31edc5/src/scansci_pdf/publisher_pdf_router.py)
- [publisher profiles](https://github.com/Rimagination/scansci-pdf/blob/5e4a6f20ee32b16c0fcb52e37b66ca7a0b31edc5/src/scansci_pdf/publisher_profiles.py)
- [PDF validation](https://github.com/Rimagination/scansci-pdf/blob/5e4a6f20ee32b16c0fcb52e37b66ca7a0b31edc5/src/scansci_pdf/pdf_utils.py)
- [adaptive source scoring](https://github.com/Rimagination/scansci-pdf/blob/5e4a6f20ee32b16c0fcb52e37b66ca7a0b31edc5/src/scansci_pdf/sources/scoring.py)
- [Apache-2.0 license](https://github.com/Rimagination/scansci-pdf/blob/5e4a6f20ee32b16c0fcb52e37b66ca7a0b31edc5/LICENSE)

### Zotero

- [attachment resolvers and downloader](https://github.com/zotero/zotero/blob/621c0fbb9134956329471da7b3ebe11deedb7029/chrome/content/zotero/xpcom/attachments.js)
- [document-to-attachment translator bridge and private OA lookup](https://github.com/zotero/zotero/blob/621c0fbb9134956329471da7b3ebe11deedb7029/chrome/content/zotero/xpcom/utilities_internal.js)
- [HTTP and cookie contexts](https://github.com/zotero/zotero/blob/621c0fbb9134956329471da7b3ebe11deedb7029/chrome/content/zotero/xpcom/http.js)
- [ScienceDirect translator example](https://github.com/zotero/translators/blob/588716b5e32b810ef669f645ec8a161e64f09df5/ScienceDirect.js)
- [AGPLv3 license](https://github.com/zotero/zotero/blob/621c0fbb9134956329471da7b3ebe11deedb7029/COPYING)
