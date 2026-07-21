# SciRetriever v2 系统设计

- 状态：P0-P9 BUILT
- 目的：讲清 v2 的运行时数据流：一次检索或一个下载请求如何流经两个阶段的数据对象与状态，最终产出发布的 `DocumentPackageVersion`。
- 规范引用：[需求](./requirements.md)、[技术架构](./technical-architecture.md)、[ADR 0001](../adr/0001-sciretriever-scope-and-boundary.md)、[架构原则](../architecture/principles.md)、[README](../../README.md)。
- 当前态声明：P0-P9 的契约、catalog / identity、Discovery、不可变 Raw / derived 存储、角色化网络采集、确定性归一化、通用轻结构、质量门、版本发布、显式已有资产导入与只读 legacy SQLite 适配均已交付。导入一次性且可重放，不自动扫描或迁移 corpus；小写 `sciretriever` 为 v2 主路径，大写 `SciRetriever` 保留兼容。无替代文献库存在。多来源路由借鉴 `third_party/scansci-pdf`（仅本地设计参考，**不被调用、不导入、不 vendoring**），全部原生重写。

## 1. 两个阶段与交接边界

v2 是一条线性流水线，分两段，中间用一份 JSONL 清单显式交接：

```
阶段一 Discovery（发现，只读 catalog）
  SearchSpec ─▶ 多来源元数据检索 ─▶ 清洗剔除无效记录 ─▶ 批内去重
             ─▶ 跨来源元数据合并 ─▶ 读 catalog 比对 ─▶ 主要基于 title+abstract 标注
             ─▶ DownloadManifest (JSONL)
                        │
        ════════════════╪════════════  JSONL 交接边界（内部采集清单）
                        ▼
阶段二 Acquisition（采集，写 catalog）
  Work admission / create-or-reuse ─▶ DownloadRequest ─▶ AcquisitionJob ─▶ 校验后的 RawAsset
             ─▶ normalization ─▶ DocumentPackageVersion
```

**关键分工**：Discovery 只**读** catalog 做比对去重，**不创建 canonical `Work`**；`Work` 只在 Acquisition 下载前 create-or-reuse。清洗与所有去重都在消耗 token 的标注**之前**完成，catalog 已有可复用标签的候选不再重复标注。`DownloadManifest` 是**内部采集清单**（一行一条候选记录的 JSONL，不是单个大 JSON 数组），与下游领域 JSONL 数据集无关。

## 2. 三条入口

| 入口 | 起点 | 是否经完整 Discovery |
| --- | --- | --- |
| 主题 / 领域发现 | `SearchSpec` | 是：检索 -> 清洗 -> 去重 -> 合并 -> 比对 -> 标注 -> 清单 |
| 直接 DOI / 标识符 | 标识符列表 | 否：跳过检索，可选做轻量清洗 / 比对后直接进采集 |
| 导入现成清单 | 外部清单 / 列表 | 否：规整成 `DownloadManifest` 后直接进采集 |

三条入口最终都汇入同一段 Acquisition：先 create-or-reuse `Work`，再下载。

## 3. 数据对象

沿一条链推进，但持久化位置不同：Discovery 对象属于本次检索的运行上下文与工作文件，`DownloadManifest` 持久化为 JSONL；Acquisition 从 `Work` 开始写 catalog DB；文献字节始终存于文件系统。

**阶段一 Discovery**

| 对象 | 含义 | 关键不变量 |
| --- | --- | --- |
| `SearchSpec` | 一次检索的声明：主题 / 领域查询、过滤条件、来源集合、上限 | 声明式；决定检索什么、用哪些 provider |
| `IntakeRun` | 一次发现批次的执行上下文 | 记录 SearchSpec / 来源与产出候选数；可写运行日志与工作文件，但全程只读 catalog |
| `CandidateWork` | 身份解析前的候选记录 | 携带合并后的元数据与标签；**不是 canonical `Work`** |
| `DownloadManifest` | 发现段到采集段的 JSONL 交接清单 | 一行一条候选；内部采集清单，非下游领域数据集 |

**阶段二 Acquisition 与发布**

| 对象 | 含义 | 关键不变量 |
| --- | --- | --- |
| `Identifier` | `Work` 的外部标识别名（DOI / arXiv / PMID / provider URL） | `(namespace, value)` 唯一；多别名指向一个 `Work` |
| `Work` | 规范化的文献身份 | 采集段 create-or-reuse；歧义转 review；合并 / 拆分显式可审计 |
| `DownloadRequest` | 对某 `Work` 获取全文的请求 | 幂等；同一 `Work` 的并发请求收敛 |
| `AcquisitionJob` | 某 (`Work`, 资产目标) 的采集工作单元 | 每 (`Work`, 资产目标) 至多一个非终结 job |
| `AcquisitionAttempt` | 针对一个来源的一次尝试 | 记录来源、结果、耗时、失败类型 |
| `AssetIntent` | Raw 硬链接发布前的不可变重放意图 | 含 Work / job / attempt / role / 相对 staging / target path / expected hash + size / media type / format / provenance |
| `RawAsset` | 已接受的不可变文件 | 每个 SHA 一条；相对 `path + SHA-256 + format + size`，字节不入 BLOB |
| `NormalizedArtifact` | 由 Raw 派生的规范化内容 | 可对同一 Raw 重跑重建 |
| `LightStructure` | 下载后的摘要 / 标签 / 引用关系 | 显式有损；**区别于 Discovery 的元数据预标注** |
| `ProcessingRun` | 发布前处理流水线运行 | 各阶段可续跑、带失败态 |
| `DocumentPackageVersion` | 发布的带版本包 | 含 `schema_version` 与 lineage |

## 4. 阶段一：发现（Discovery）

Discovery 线性推进，产出干净、带标签的采集清单，全程只读 catalog：

1. **检索**：按 `SearchSpec` 向当前内置来源（Crossref / Europe PMC / arXiv，可插拔）拉元数据，得到一批 `CandidateWork`；OpenAlex / Semantic Scholar 属于后续采集段全文定位来源。
2. **清洗**：规范字段并剔除明显损坏或完全无法识别的记录。缺 DOI 或缺摘要本身不构成无效；只要仍有标题或其它可用标识符，就进入后续合并与补全。
3. **批内去重**：同一批结果内按标识符与规范化标题收敛重复候选。
4. **跨来源合并**：把指向同一文献的多来源记录合并成一条，互补字段（补齐缺失的 abstract / keywords / 标识符）。
5. **catalog 比对**：读 catalog 判断候选是否已在库、是否已有可复用标签；**只读，不写、不建 `Work`**。
6. **标注**：对清洗去重后的候选，主要基于 title + abstract 打标签；命中 catalog 中同一标签体系下可复用标签的直接复用，不再消耗 token。
7. **写清单**：产出 `DownloadManifest`（JSONL，一行一条）。

**缺摘要的线性处理**：候选缺 abstract 时，先在第 4 步从其它来源合并 / 富化补齐；若仍缺，则用 title 加可得的 keywords / topics 标注，并在该行标 `missing_abstract`。**不编造摘要，也不因仅缺摘要就自动丢弃。** 标注保持简单：标签，加证据不足时的 `missing_abstract` / 复核标记；不引入置信度、相关性状态机、优先级、主动学习或复杂打分。

## 5. 阶段二：采集与请求处理（P4+ 目标态）

清单（或直接 DOI）进入采集段。每个 `DownloadRequest` 在一个事务内决策，保证并发幂等：

1. **规范化标识符**：统一 DOI 大小写、剥离 URL、解析 arXiv id 等，得到 canonical id。
2. **身份 create-or-reuse**：事务化 lookup/upsert 到唯一 `Work`，并发同 id 收敛。跨标识符歧义不自动合并，转 review / merge 候选；内容 hash 相同也绝不静默合并；合并 / 拆分显式可审计。
3. **已有合格 PDF**：跳过采集，仍检查并续跑缺失的下游阶段，已发布则返回其 `DocumentPackageVersion`。
4. **仅有 XML / HTML**：调度 primary PDF 补全 job；补全期间仍可提供 XML / HTML 与受限包。
5. **已有非终结 job**：同 (`Work`, 资产目标) 存在在途 job，attach 到该 job，不新建。
6. **可重试失败**：按退避重新激活同一 job 重试。
7. **受限 / 需复核**：job 挂起，对用户暴露状态，不自动重试（新请求仍 attach）。
8. **均不满足**：新建 `Work`（若需）+ `DownloadRequest` + `AcquisitionJob`。

`AcquisitionJob` 的非终结态（pending / active / retryable / paused）在每 (`Work`, 资产目标) 上唯一，新请求一律 attach；仅终结态下才按显式策略对同一资产目标开新 job。

## 6. 来源规划与路由（P5 已交付边界）

路由原生实现，借鉴 `scansci-pdf` 的分层与自适应思想。**采集按资产目标分别推进**：primary PDF、Supplementary PDF、XML / HTML 各有独立目标与完成判据。每次尝试产生一条 `AcquisitionAttempt`。免费 / OA 层内 primary PDF 可并行竞速，先得合格 PDF 者胜出并**只取消其它 primary-PDF 尝试**；Supplementary PDF 独立进行；机构 / 受限层作回退：

| 来源层 | 说明 |
| --- | --- |
| 本地 cache | 已有 `RawAsset` 或近期尝试结果，先命中避免重复网络 |
| OA APIs | 开放获取解析（Unpaywall / OpenAlex / Semantic Scholar / Europe PMC / arXiv 等）拿直链 |
| 出版商 direct / API | 按 publisher profile 走授权 API 或直链（Elsevier / Wiley 等） |
| HTML discovery | 抓落地页，发现正文 PDF 与 Supplementary PDF 链接 |
| browser / institutional | Playwright 或机构 / 代理通道，处理 JS 渲染与受限访问（回退层） |

PDF 路由全部耗尽仍无 PDF，则 PDF 目标标记为 explicitly missing 且可重开，此时 XML / HTML 可支撑“有限制”达标，但不改变 PDF 优先、不掩盖 PDF 缺失。自适应控制：

- **per-host budget**：按 host / 域的最小间隔 + 并发上限 + 可选礼貌延时；遵守 `forbidden_urls`。
- **adaptive source health**：按 EMA 成功率与时延给来源打分排序，优先高健康来源。
- **circuit breaking**：按 host / 域失败连击熔断退避，后续 job 暂时跳过。
- **resume**：source plan 进度与每条 attempt 都落 catalog DB，中断后从下一个未尝试来源续跑，不重跑已成功步骤。

P5 已交付 strict canonical `SourcePlan`、serial / same-tier race、restart resume、due retry jobs、per-host budget、health EMA、circuit breaker、角色校验，以及 OpenAlex / Semantic Scholar / Elsevier / Wiley / Springer 原生 provider。source plan、attempt、retry time 与状态持久化；budget / health / circuit 为进程内状态。凭证只从环境 / 配置注入且不进入 durable catalog 数据。

生命周期只有一个 owner：`MultiSourceOrchestrator` 负责 claim、attempt、资产接受、重试、暂停、取消与终态；P4 `AcquisitionOrchestrator` 仅把原 API 转换为单 entry serial plan。catalog 不导入 acquisition 类型，仅保存 acquisition 边界已校验的 canonical plan JSON 与通用 role / schema version metadata。candidate attempt details 使用严格版本化 JSON codec；含 candidate 字段但缺失或破损的 codec metadata 显式失败，无关 legacy details 可忽略。混合耗尽状态由全部 candidate 的聚合结果决定，不依赖 race 完成顺序；任一 retryable failure 或 open circuit 均保留 job 的 retryability。

每次 CLI 调用只创建一个 acquisition runtime，复用 provider、orchestrator、per-host budget、health EMA、circuit breaker 与 retry policy。publisher provider 的 credential env 和 host budget hint 来自声明式 profile；显式 CLI budget 参数覆盖 profile hint。

publisher profile 是声明式数据（非硬编码逻辑），控制每个出版商 / host 的入口、角色、端点模板、媒体类型、限速与 credential env 名。当前 P5 不实现 browser / institutional automation，也不执行 profile selector / script；表中该层仍为后续目标态。

## 7. P3 资产存储与接受边界（已交付）

P3 从调用方提供的二进制流开始，不联网、不选择 provider、不验证 PDF 业务格式，也不增加 CLI 命令。P4 已在调用 P3 前完成网络获取与内容接受校验。因此，**网络成功不等于资产接受**：HTTP 200 且有响应体只是采集步骤成功；PRIMARY_PDF role、magic bytes（`%PDF-`）、`%%EOF` trailer、content-type、正数大小上下限、PyPDF2 可解析且至少一页均须先通过。失败 HTTP body 不会成为 `RawAsset`。

P3 已交付的持久化流程为：

```
binary stream ─▶ durable staging + SHA-256 / size ─▶ persist AssetIntent(pending)
              ─▶ os.link create-if-absent ─▶ durable target verification
              ─▶ register RawAsset + Work role link + intent(published)
              ─▶ durable staging removal ─▶ intent(finalized) ─▶ final target verification
```

- **存储根与布局**：根目录必须预先存在、必须是真实目录，路径任一段不得是 symlink。P3 只管理相对路径 `staging/<intent-id>.part`、`staging/.lock` 与 `raw/<sha256[:2]>/<sha256>`；不把绝对路径写入 catalog。
- **权限与 staging durability**：`staging`、`raw` 与 hash shard 为 `0700`，锁文件为 `0600`，staged / raw 文件为只读 `0400`。staging 对输入流只读一遍，同时计算 SHA-256 与严格正数 byte size；文件内容、chmod 后文件和目录均严格 fsync，任一 durability 失败均 fail closed。
- **不可变 intent**：在发布前持久化 Work / job / optional attempt / role、temp / target 相对路径、expected SHA-256 / size、media type、format 与每次采集自己的 provenance。重放元数据不可修改，状态只允许 `pending -> published -> finalized` 或 `pending -> abandoned`。
- **硬链接发布**：发布只调用同一文件系统上的 `os.link` create-if-absent；绝不 rename、replace、copy、fallback copy 或 overwrite。跨文件系统明确失败。新目标与 `EEXIST` 目标都必须按 expected size 重读 SHA-256，并 fsync 目标文件、shard 与 `raw` 目录；既有错误目标保留原 inode 与字节并报 corruption。
- **catalog 登记边界**：仅在目标通过 durability 与 hash / size 验证后，事务化创建或复用每 SHA 唯一的 `RawAsset`，增加 per-Work + role link，并将 intent 置 `published`。同字节的并发接收收敛为一个 target / raw row；每个 Work link 与每个 intent provenance 仍保留。staging 耐久删除后 intent 才 `finalized`，随后再次验证目标。
- **关系库存元数据，不存字节**：catalog 只保存相对路径、hash、size、media type / format、关系、provenance、event 与 failure；无 Raw BLOB、无绝对路径。精确 intent 重放、状态 event 与相同 failure 重放均幂等。

正常 coordinator 从 stage 到最终验证全程持 shared lock；reconciler 扫描 intent 与 staging、修复、清理期间持 exclusive lock。对账只使用不可变 intent 元数据和确定性相对路径，不猜 provenance，也不把损坏证据当作 missing。恢复矩阵如下，表内动作均以 catalog 元数据匹配为前提；不匹配时保持原状态与所有文件并记录 failure：

| intent 状态 | target valid | target missing | target corrupt |
| --- | --- | --- | --- |
| `pending` | 登记 / 复用 Raw + Work link；valid staged 删除，missing staged 无需处理，corrupt staged 保留并记 failure；最终 `finalized` | valid staged 经硬链接发布、登记、删除后 `finalized`；missing staged 因证据全失转 `abandoned`；corrupt staged 保留并转 `abandoned` | target 与 staged 均保留，记 failure，转 `abandoned` |
| `published` | valid staged 删除，missing staged 无需处理，corrupt staged 保留并记 failure；最终 `finalized` | valid staged 重建 target、删除后 `finalized`；missing / corrupt staged 保持 `published` 并记 missing target，corrupt staged 另记 corruption | target 与 staged 均保留，保持 `published` 并记 failure |
| `finalized` | valid staged 作为冗余删除；missing staged 不动作；corrupt staged 保留并记 failure | 保持 `finalized`，保留任意 staged，记 integrity failure，不猜测或降级 | 保持 `finalized`，target 与任意 staged 均保留，记 integrity failure |
| `abandoned` | 不发布、不删除、不改变状态 | 不发布、不删除、不改变状态 | 不发布、不删除、不改变状态 |

staging 扫描只把符合 `staging/<uuid>.part` 且为普通文件、同时没有对应 intent 的条目视为 recognized orphan，并可在 exclusive lock 下 unlink + fsync 目录。未知文件、目录、symlink 与所有 corrupt staging 均保留并报告，绝不自动删除；corrupt target 同样绝不覆盖或删除。

P3 验收覆盖六个 durability crash checkpoints、重启后的两轮对账收敛、并发相同字节只产生一个 target / raw row、每个 intent provenance 与 per-Work role link 不丢失，以及 SQLite `integrity_check=ok`、`foreign_key_check` 为空。P4 acquisition / CLI 已通过该公开 API 闭合端到端下载；job 的完成判据是已接受资产、`RawAsset` 注册且无未决 intent。

## 8. 归一化、编目、发布（P6-P8 已交付）

发布前处理由确定性 `ProcessingRun` 编排为持久化、可续跑的阶段链：`raw acceptance → normalization → enrichment → package validation → publication`；阶段使用 active / succeeded / failed 等现有状态，精确 replay 复用已完成产物。文件系统持久发布先于 catalog 登记，事务不跨文件 I/O。

- **归一化与证据**：对同一 Raw 运行归一化，产出 `NormalizedArtifact`（完整章节 / 表格 / 参考文献）与 `evidence[]`（片段回指源文件与位置）。可重跑，损失感知。
- **下载后轻结构**：`LightStructure` 产出摘要 / 标签 / 引用关系，仅作发现辅助、显式有损。**这是采集后基于全文的富化，区别于 Discovery 段基于元数据的预标注，两者不混用。** search projection 可从 catalog 重建，非权威源。
- **质量门与达标**：有合格 PDF 主证据为一种达标；无合格 PDF、靠 XML / HTML 支撑为“有限制”达标，并在包内记明缺失与限制。二者皆可发布，状态不同。
- **包版本化**：达标后发布带 `schema_version` 与 lineage 的 `DocumentPackageVersion`；草稿包不是已发布包；契约变更须新 ADR。
- **引用关系**：只按精确规范标识符链接 catalog 中既有 `Work`；未命中项保留为 unresolved citation，富化阶段不创建新 `Work`。
- **用户可见状态与恢复**：每个 `Work` 对外暴露 job 状态（active / paused / succeeded / failed）；paused 场景在外部条件满足后可恢复续跑。

## 9. <a id="responsibility"></a>职责表

| 关注点 | catalog DB | Raw store | derived store | search projection | 下游 domain pack |
| --- | --- | --- | --- | --- | --- |
| 控制平面状态（requests/jobs/attempts/status/关系） | 拥有 | 无 | 无 | 无 | 无 |
| 不可变原始字节（PDF / suppl / XML / HTML） | 仅存 path+hash | 拥有 | 无 | 无 | 无 |
| 派生字节（归一化 / 结构化中间物） | 仅存 path+hash | 无 | 拥有 | 无 | 无 |
| 发现 / 检索索引 | 权威元数据 | 无 | 无 | 拥有（可重建） | 无 |
| 身份 / 去重 / lineage / failures | 拥有 | 无 | 无 | 无 | 无 |
| 达标与包版本 | 拥有 | 无 | 存包体字节 | 无 | 读 |
| 领域数据集（JSONL / CSV / schema / manifest） | 仅记 run 指针+hash | 无 | 无 | 无 | 拥有 |

`DownloadManifest` 是使用 Discovery 时到 Acquisition 的内部交接文件（JSONL）；直接 DOI / 标识符可跳过该交接。它既不是权威控制平面状态，也不是下游领域数据集。一句话：**库存状态与关系，文件系统存字节，下游存领域数据集。** 每个已接受文件都有 DB 记录，但不是每个失败响应都成为 `RawAsset`。SciRetriever 止于已发布的 `DocumentPackageVersion`，领域抽取在边界外由下游进行，只有 domain-run 记账这一条线回穿边界。
