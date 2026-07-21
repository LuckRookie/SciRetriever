# SciRetriever v2 需求规格

- 状态：P0-P9 BUILT
- 目的：说明 SciRetriever v2 为什么做、为谁做、必须做到什么、坚决不做什么。这是三份 v2 文档的需求基线。
- 规范引用：[ADR 0001](../adr/0001-sciretriever-scope-and-boundary.md)、[架构原则](../architecture/principles.md)、[系统设计](./system-design.md)、[技术架构](./technical-architecture.md)、[AGENTS.md](../../AGENTS.md)、[README](../../README.md)。
- 当前态声明：P0-P9 已交付 contracts、catalog / identity、Discovery、不可变 Raw / derived preservation、角色化 acquisition、normalization、enrichment、质量门、`DocumentPackageVersion` publication、已有资产导入与中性 Paper/Optera 适配。导入仅处理显式提供的现有文件或只读 SQLite，一次性、可重放，不自动迁移 corpus。小写 `sciretriever` 是 v2 主路径；大写 `SciRetriever` 仅保留兼容代码与安全守卫。Batch 015 退役的九个库无替代。

冲突时以 ADR 0001 为准。本文只提需求，不定实现；实现见系统设计与技术架构。

## 1. 产品目标（为什么做）

SciRetriever v2 把文献工作拆成前后衔接的两段，中间用一份显式清单交接：

1. **发现（Discovery）**：按主题 / 领域或标识符检索多来源元数据，清洗掉无效记录、去重、跨来源合并，再主要基于 title + abstract 给候选打标签，产出一份内部采集清单。
2. **采集与编目（Acquisition）**：消费该清单（或直接给定的 DOI），create-or-reuse 规范文献身份，下载全文、校验、编目、归一化，最终发布带版本与溯源的 `DocumentPackageVersion`。

核心诉求：同一篇文献在多来源、多次请求、多进程并发下不重复下载、不丢来源、不改证据，任何一次失败都能安全续跑；并且在消耗 token 的标注之前先把数据清干净、去重干净，不为垃圾或重复记录付费。领域抽取（反应、分子、路线等）明确留给下游。

本文中，`SearchSpec` 是一次主题检索声明，`Work` 是正式 catalog 中的唯一文献身份，`RawAsset` 是下载、校验并登记后的不可变原始文件。

## 2. 用户角色（为谁做）

| 角色 | 诉求 |
| --- | --- |
| 检索者 / 研究者 | 按主题 / 领域或标识符检索，先拿到一份干净、去重、带标签的候选清单，再换取可用全文与规范化内容 |
| 采集运维 | 批量补全语料，监控来源健康、失败与续跑，控制配额与标注 token 开销 |
| 下游领域 pack 作者 | 按稳定 id + hash 读 `DocumentPackageVersion`，产出自有 portable dataset |
| 平台维护者 | 演进内部存储与 schema，不破坏边界契约与溯源 |

## 3. 核心用例（UC）

- UC1 主题 / 领域发现：给一个主题或领域查询，返回一份已清洗、去重、合并并打好标签的候选清单（DownloadManifest）。
- UC2 单篇获取：给 DOI / arXiv id / URL，跳过检索直接进采集，返回或调度其 PDF 与规范化内容。
- UC3 导入清单：导入一份现成的标识符列表 / 清单，跳过检索直接进采集。
- UC4 批量补全：把发现清单排程采集，按来源健康与配额续跑。
- UC5 重复请求：对已获取或正在处理的文献再次请求，命中已有结果或已有工作，不新建重复工作。
- UC6 失败恢复：可重试失败自动重试；受限 / 需人工复核的挂起，恢复后续跑。
- UC7 发布与消费：文献达标后发布 `DocumentPackageVersion`，下游按稳定引用读取。
- UC8 领域记账：记录下游 domain run 的状态、输出指针与 hash，不落任何领域字段。

## 4. 范围

### 4.1 In scope
- 三条入口：主题 / 领域检索、直接 DOI / 标识符、导入现成清单。
- 多来源可插拔元数据检索（当前内置 Crossref / Europe PMC / arXiv，provider 可插拔增删；OpenAlex / Semantic Scholar 属于采集段全文定位来源）。
- 检索结果清洗、批内去重、跨来源合并，以及与 catalog 比对。
- 主要基于 title + abstract 的简单元数据标注，产出内部采集清单（DownloadManifest，JSONL）。
- 多来源下载全文（PDF、Supplementary PDF、XML、HTML）与并发安全的幂等采集。
- 一张规范文献 catalog DB 作为控制平面；Raw 与 derived 字节存文件系统，DB 只存元数据、路径与 hash。
- 归一化到统一 `DocumentPackage`，含完整章节 / 表格 / 参考文献 / 证据定位。
- 下载后的通用轻结构（摘要、标签、引用关系）。
- 达标判定与发布 `DocumentPackageVersion`。
- domain-run 记账（仅状态 + 输出指针 + hash）、存储根与凭证配置。

### 4.2 Out of scope
- 任何领域抽取 schema（反应 / 分子 / 路线 / 产率 / 材料属性）与 catalog 内任何领域字段、表或列。
- 生成 JSONL / CSV 领域数据集的归属（属于下游 domain pack）。**注意：Discovery 产出的 DownloadManifest JSONL 是内部采集清单，不是下游领域数据集。**
- 标注上的置信度分值、相关 / 不相关 / 不确定状态机、优先级、主动学习、复杂打分。
- 下游分析、预测、路线规划。
- 微服务、外部工作流平台、向量库、Web UI（见 ADR 0001 决策 11）。
- 把语料存进代码仓库。

## 5. 功能需求（FR）

**发现（Discovery）**

- **FR-1 三条入口**：支持主题 / 领域检索、直接 DOI / 标识符、导入现成清单三种入口；三者最终都汇入同一条采集流程。
- **FR-2 可插拔多来源检索**：当前内置 Crossref / Europe PMC / arXiv，provider 可插拔，新增 / 移除来源不改上层；OpenAlex / Semantic Scholar 在采集段用于全文定位，不属于当前 Discovery provider。
- **FR-3 先清洗去重、后标注**：检索结果先清洗无效记录、批内去重、跨来源合并，并读 catalog 比对；**所有清洗与去重必须在任何消耗 token 的标注之前完成**；catalog 中已有同一标签体系下可复用标签的条目直接复用，不再消耗标注 token。缺 DOI 或缺摘要本身不构成无效记录。
- **FR-4 简单标注**：主要基于 title + abstract 给候选打标签；证据不足时打 `missing_abstract` / 复核标记。不做置信度分值、相关性状态机、优先级、主动学习或复杂打分。
- **FR-5 缺摘要线性处理**：候选缺摘要时，先尝试从其它来源合并 / 富化补齐；仍缺则用 title 加可得的关键词 / 主题标注，并标 `missing_abstract`；**不编造摘要，也不因仅缺摘要就自动丢弃**。
- **FR-6 清单交接**：Discovery 产出 `DownloadManifest`（JSONL，一行一条候选）作为与采集段的显式交接；Discovery 只读 catalog 做比对去重，**不创建 canonical `Work`**。

**采集与编目（Acquisition）**

- **FR-7 采集期建身份**：Acquisition 消费清单或直接 DOI，**下载前先 create-or-reuse `Work`**；命中已有文献则复用，不新建重复身份。
- **FR-8 幂等并发安全**：同一标识符的并发或重复请求收敛到同一 `Work` 与同一在途工作，不产生重复下载或重复采集工作。
- **FR-9 去重与身份**：标识符（DOI / arXiv / PMID / provider URL）精确命中收敛到同一 `Work`；叠加文件内容 hash 去重；跨标识符歧义转显式可审计的 review / merge，绝不静默合并。
- **FR-10 PDF 优先且 Raw 不可变**：PDF 与 Supplementary PDF 为主视觉证据，XML / HTML 为辅助或回退且永不优先；下载文件写一次、只读留存，修错靠对同一 Raw 重跑归一化。
- **FR-11 单一控制平面、字节在库外**：唯一一张 catalog DB 管理身份 / 请求 / 工作 / 文件关系 / 状态 / 失败 / lineage 与 domain-run 记账，是流程状态的唯一权威；Raw 与 derived 字节写配置存储根，DB 只存路径与 hash，禁止字节入库。

**归一化与发布**

- **FR-12 损失感知归一化**：`DocumentPackage` 保留完整章节、表格、参考文献与证据定位，轻结构不得成为内容唯一副本。
- **FR-13 下载后轻结构**：归一化后产出通用摘要、标签、引用关系，仅作发现辅助、显式有损；**这是采集后基于全文的富化，区别于 Discovery 段基于元数据的预标注。**
- **FR-14 达标与版本发布**：给出质量门判定，区分“有合格 PDF”与“仅靠 XML / HTML 支撑”两种达标状态；发布带版本与 lineage 的 `DocumentPackageVersion`。
- **FR-15 领域下游化**：领域抽取不在此实现；catalog 只记 domain-run 的状态 / 指针 / hash，领域产物为下游拥有的 portable dataset。

## 6. 质量属性

| 属性 | 要求 |
| --- | --- |
| 幂等 / 并发安全 | 重复与并发请求不产生重复下载或重复采集工作（FR-8） |
| 成本可控 | 清洗、去重在标注前完成；catalog 已有可复用标签不重复消耗 token（FR-3） |
| 溯源 / 可审计 | 每一步追加 lineage；任一规范化片段可回溯到源文件与位置 |
| 可复现 | Raw 不可变 + 确定性 hash + 归一化可重跑得同一结果 |
| 格式无关 | 边界下游不因原始格式（PDF / XML / HTML）分支 |
| 可靠 / 可续跑 | 部分失败后可对账并续跑，不留孤儿文件或悬挂工作 |
| 可配置 | 存储根与凭证来自配置，无硬编码路径 |
| 安全 | fail closed；凭证不入代码 / 不上命令行；遵守来源速率与 `forbidden_urls` |
| 可移植 | 下游只依赖 `document_id` / `file_id` / `artifact_id` / hash 与 provenance |

## 7. 数据归属（摘要）

catalog DB 拥有全部状态与关系；Raw store 拥有不可变原件；derived store 拥有归一化 / 派生产物；search projection 是可重建的检索投影；下游 domain pack 拥有领域数据集。`DownloadManifest` 是发现段到采集段的**内部交接文件**，既不是权威状态，也不是下游领域数据集。库不存字节，字节不存状态。详细职责表见[系统设计](./system-design.md#responsibility)。

## 8. 验收标准（AC）

- **AC-1（FR-1/2/6）** 主题检索产出清单：给定主题查询，产出的 `DownloadManifest` 为 JSONL（一行一条，非单个大 JSON 数组），已清洗、已去重，每条带标签或 `missing_abstract` 标记。
- **AC-2（FR-3）** 标注前先清洗去重：可验证清洗与去重发生在标注之前；命中 catalog 可复用标签的候选不再触发新的标注调用。
- **AC-3（FR-4/5）** 缺摘要不丢弃：缺摘要且无法补齐的候选仍出现在清单里，标 `missing_abstract`，未被编造摘要、未被自动丢弃。
- **AC-4（FR-6/7）** 阶段分工：跑完发现段后 catalog 中不新增 canonical `Work`；`Work` 只在采集段下载前 create-or-reuse。
- **AC-5（FR-8/9）** 重复 DOI 请求：命中已有 `Work`，attach 到在途工作或返回已有结果，DB 不新增重复 `Work` 或重复工作。
- **AC-6（FR-10/14）** 仅有 XML / HTML：调度 PDF 补全；补全前可发布“有限制”达标包并记明缺 PDF。
- **AC-7（FR-11/12）** Raw 可溯源：已接受的 PDF 存于文件系统存储根，DB 有路径 + hash 记录，原件不可变，规范化片段可回溯到源文件与位置。
- **AC-8（FR-11/15）** 领域隔离：尝试给 catalog 加反应 / 分子 / 产率等领域列必须被拒；下游仅凭 `document_id` + hash 即可取 `DocumentPackageVersion`，无需触碰内部 ORM 表。
- **AC-9（FR-8）** 并发：N 个并发同标识符请求，最终只存在一个 `Work` 与一份在途采集工作。

## 9. MVP 分期边界

产品级 MVP 分三块，可分别交付、组合成闭环：

- **发现 MVP**：一条 `SearchSpec` 经多来源检索 -> 清洗 -> 批内去重 -> 跨来源合并 -> catalog 比对 -> 基于 title+abstract 标注，产出一份干净、带标签的 `DownloadManifest`（JSONL）。
- **采集 MVP**：消费该清单或直接 DOI，create-or-reuse `Work`，单来源 PDF 采集 + 校验 + 登记，跑通去重 / 幂等 / 对账，闭合到 `RawAsset`。
- **组合 MVP**：发现 + 采集串起来，从 `SearchSpec` 一路到 `RawAsset`。

MVP 之后的 P5 多来源路由、P6 归一化、P7 下载后轻结构、P8 质量门 / 版本发布及 P9 显式已有资产导入与 legacy 适配均已交付。领域记账 repository 已存在，领域抽取始终在下游，不进任何阶段。分期里程碑见[技术架构](./technical-architecture.md#phases)。
