# Block 04｜业务能力与正式文献发布

## 块身份

- 状态：`Pending`
- Tasks：36 项，以本文件 `Tasks` 为唯一任务定义；包括 `META-ARXIV`、`META-CORE`、`META-CROSSREF`、`META-DATACITE`
  `META-ELSEVIER`、`META-EUROPE-PMC`、`META-OPENALEX`、`META-OPENCITATIONS`
  `META-SEMANTIC-SCHOLAR`、`META-SPRINGER`、`META-WEB-OF-SCIENCE`、`META-DISPATCH`
  `LIT-IDENTITY`、`LIT-CURRENT-FACTS`、`LITERATURE-ASSET-PUBLICATION`、`LIT-REFERENCES`、`LIT-DELETE`
  `DISCOVERY-ENTRY`、`IMPORT-METADATA`、`IMPORT-PDF`、`EXPORT-METADATA`
  `EXPORT-ARTIFACT`、`PARSER-MINERU`、`ANALYSIS-METADATA`、`ANALYSIS-CONTENT`
  `ANALYSIS-REFERENCES`、`LIBRARY-QUERY`、`ENTRY-APPLICATION`、`CLI-DISCOVERY`
  `CLI-COMPLETION`、`CLI-LIBRARY`、`CLI-EXCHANGE`、`MODEL-CATALOG`
  `CONFIG-PROBE`、`CONFIG-EDITOR`、`CLI-CONFIG`
- 前置块：Block 02 `RUNTIME-FOUNDATION-ACCEPTANCE`、Block 03 `BROWSER-ACQUISITION-ACCEPTANCE`
- 下游块：Block 05
- 恢复点：前置块通过后从 `META-ARXIV` 开始；不得从旧的 execution/service Task 恢复

## 块结果

按能力和 adapter 完成 Metadata、Literature、Discovery、Import/Export、Parsing、Analysis、查询、CLI 和配置中心迁移；
由 Literature owner 消费 Block 03 的 durable Candidate，原子发布正式 Asset/LiteratureAsset 与 current facts。

## 进入条件

Block 02/03 的 contracts、repositories、Candidate receipt、Network、Browser 和工作台均有 R3 证据；活动能力
清单已逐项闭合到具体 Task；Block 03 没有写入 Literature current facts；不读取真实 Catalog、Profile 或凭据。

## 责任与改动面

每个 Metadata adapter 拥有自己的 vendor 请求/响应转换和 failure mapping；Literature 拥有 identity/current facts；
Entry 拥有协议和 CLI 边界；Parsing 只管理 MinerU handoff；Analysis 拥有分析规则；Acquisition 提供 Candidate
evidence/receipt；Literature 决定正式资产关系与 current facts；Storage 只持久化已确认命令。

## 需要保持的行为

保留 Provider-neutral 合同、保守 Literature identity、provenance/lineage、MinerU operator-managed 边界、现有
CLI/config 用户行为和 v1 数据；不把占位实现写成 parity，不把 MinerU 状态写入核心业务状态，不双写生产库；
本块不建立 v2 execution schema、可恢复队列或常驻服务 API。

## Tasks

本节是本块 Task 定义与状态的唯一位置，按列出顺序串行执行。[任务索引](task-ledger.md)仅用于定位。
反引号中的文件路径均相对仓库根目录；未实现任务的路径是拟新增落点，不表示文件或测试已经存在。
每项完成还须满足本块公共退出条件；测试名只描述行为，禁止按计划顺序命名。

### META-ARXIV

- [ ] **META-ARXIV — 迁移 arXiv XML search/lookup、分页、identity 和失败映射。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：经共享 Network XML search/lookup、分页及 arXiv 版本标识；在 adapter 内转换为中性 observation/provenance，具体 endpoint/字段取现有 adapter 和技术合同。
  - 改动面：`apps/server/src/metadata/providers/arxiv/`。
  - 依赖：[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)、[REPOSITORY-OBSERVATION](02-runtime-storage-network.md#repository-observation)。
  - 验收：独立合成 fixture 覆盖合法 Atom 页与空页、畸形 XML、重复分页和不可用条目；与 Python 对相同输入做记录/标识/作者顺序/分页终止差分；敏感值不进失败，未支持能力不伪装成功，所有请求只到 fake/loopback。
  - 直接验证：`apps/server/test/arxiv-provider.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/arxiv-provider.md`（尚未生成）。

### META-CORE

- [ ] **META-CORE — 迁移 CORE JSON search/lookup、分页、凭据和失败映射。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：经共享 Network JSON search/lookup、分页及 CORE 凭据注入；在 adapter 内转换为中性 observation/provenance，具体 endpoint/字段取现有 adapter 和技术合同。
  - 改动面：`apps/server/src/metadata/providers/core/`。
  - 依赖：[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)、[REPOSITORY-OBSERVATION](02-runtime-storage-network.md#repository-observation)。
  - 验收：独立合成 fixture 覆盖合法/空 search、missing record、401/429 与坏 JSON；与 Python 对相同输入做记录/标识/作者顺序/分页终止差分；敏感值不进失败，未支持能力不伪装成功，所有请求只到 fake/loopback。
  - 直接验证：`apps/server/test/core-provider.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/core-provider.md`（尚未生成）。

### META-CROSSREF

- [ ] **META-CROSSREF — 迁移 Crossref search/lookup、polite identity 和 envelope。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：经共享 Network works search/lookup、polite identity 与 envelope；在 adapter 内转换为中性 observation/provenance，具体 endpoint/字段取现有 adapter 和技术合同。
  - 改动面：`apps/server/src/metadata/providers/crossref/`。
  - 依赖：[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)、[REPOSITORY-OBSERVATION](02-runtime-storage-network.md#repository-observation)。
  - 验收：独立合成 fixture 覆盖合法/空 message、URL 编码 DOI、未知字段边界及 429；与 Python 对相同输入做记录/标识/作者顺序/分页终止差分；敏感值不进失败，未支持能力不伪装成功，所有请求只到 fake/loopback。
  - 直接验证：`apps/server/test/crossref-provider.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/crossref-provider.md`（尚未生成）。

### META-DATACITE

- [ ] **META-DATACITE — 迁移 DataCite works/dataset lookup、分页和 identifier mapping。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：经共享 Network works/dataset lookup、分页和 identifier mapping；在 adapter 内转换为中性 observation/provenance，具体 endpoint/字段取现有 adapter 和技术合同。
  - 改动面：`apps/server/src/metadata/providers/datacite/`。
  - 依赖：[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)、[REPOSITORY-OBSERVATION](02-runtime-storage-network.md#repository-observation)。
  - 验收：独立合成 fixture 覆盖类型不同的 DOI 记录、空页、坏 attributes 及错误 next link；与 Python 对相同输入做记录/标识/作者顺序/分页终止差分；敏感值不进失败，未支持能力不伪装成功，所有请求只到 fake/loopback。
  - 直接验证：`apps/server/test/datacite-provider.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/datacite-provider.md`（尚未生成）。

### META-ELSEVIER

- [ ] **META-ELSEVIER — 迁移 Elsevier search/lookup、quota/access feedback 和 cursor。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：经共享 Network search/lookup、cursor 与 quota/access feedback；在 adapter 内转换为中性 observation/provenance，具体 endpoint/字段取现有 adapter 和技术合同。
  - 改动面：`apps/server/src/metadata/providers/elsevier/`。
  - 依赖：[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)、[CONFIG-CREDENTIAL](02-runtime-storage-network.md#config-credential)。
  - 验收：独立合成 fixture 覆盖search entry、单条缺失、401/403/429、坏 cursor；与 Python 对相同输入做记录/标识/作者顺序/分页终止差分；敏感值不进失败，未支持能力不伪装成功，所有请求只到 fake/loopback。
  - 直接验证：`apps/server/test/elsevier-provider.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/elsevier-provider.md`（尚未生成）。

### META-EUROPE-PMC

- [ ] **META-EUROPE-PMC — 迁移 Europe PMC search/lookup/citation/reference pages。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：经共享 Network search/lookup/citation/reference 分页；在 adapter 内转换为中性 observation/provenance，具体 endpoint/字段取现有 adapter 和技术合同。
  - 改动面：`apps/server/src/metadata/providers/europe_pmc/`。
  - 依赖：[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)、[REPOSITORY-OBSERVATION](02-runtime-storage-network.md#repository-observation)。
  - 验收：独立合成 fixture 覆盖PMID/PMCID 映射、空页、缺目标记录和坏关系页；与 Python 对相同输入做记录/标识/作者顺序/分页终止差分；敏感值不进失败，未支持能力不伪装成功，所有请求只到 fake/loopback。
  - 直接验证：`apps/server/test/europe-pmc-provider.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/europe-pmc-provider.md`（尚未生成）。

### META-OPENALEX

- [ ] **META-OPENALEX — 迁移 OpenAlex search/lookup、abstract location 和分页。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：经共享 Network search/lookup、abstract/location 重建与分页；在 adapter 内转换为中性 observation/provenance，具体 endpoint/字段取现有 adapter 和技术合同。
  - 改动面：`apps/server/src/metadata/providers/openalex/`。
  - 依赖：[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)、[REPOSITORY-OBSERVATION](02-runtime-storage-network.md#repository-observation)。
  - 验收：独立合成 fixture 覆盖倒排摘要、缺位置记录、空页、循环 cursor 和坏字段；与 Python 对相同输入做记录/标识/作者顺序/分页终止差分；敏感值不进失败，未支持能力不伪装成功，所有请求只到 fake/loopback。
  - 直接验证：`apps/server/test/openalex-provider.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/openalex-provider.md`（尚未生成）。

### META-OPENCITATIONS

- [ ] **META-OPENCITATIONS — 迁移 OpenCitations lookup/citation/reference relation。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：经共享 Network lookup/citation/reference 关系转换；在 adapter 内转换为中性 observation/provenance，具体 endpoint/字段取现有 adapter 和技术合同。
  - 改动面：`apps/server/src/metadata/providers/opencitations/`。
  - 依赖：[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)、[REPOSITORY-REFERENCE](02-runtime-storage-network.md#repository-reference)。
  - 验收：独立合成 fixture 覆盖多边结果、缺失标识、重复边及畸形 relation；与 Python 对相同输入做记录/标识/作者顺序/分页终止差分；敏感值不进失败，未支持能力不伪装成功，所有请求只到 fake/loopback。
  - 直接验证：`apps/server/test/opencitations-provider.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/opencitations-provider.md`（尚未生成）。

### META-SEMANTIC-SCHOLAR

- [ ] **META-SEMANTIC-SCHOLAR — 迁移 Semantic Scholar search/lookup/citation/reference pages。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：经共享 Network search/lookup/citation/reference 分页；在 adapter 内转换为中性 observation/provenance，具体 endpoint/字段取现有 adapter 和技术合同。
  - 改动面：`apps/server/src/metadata/providers/semantic_scholar/`。
  - 依赖：[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)、[REPOSITORY-OBSERVATION](02-runtime-storage-network.md#repository-observation)。
  - 验收：独立合成 fixture 覆盖paper ID 到官方标识、缺失嵌套条目、429 和坏 next offset；与 Python 对相同输入做记录/标识/作者顺序/分页终止差分；敏感值不进失败，未支持能力不伪装成功，所有请求只到 fake/loopback。
  - 直接验证：`apps/server/test/semantic-scholar-provider.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/semantic-scholar-provider.md`（尚未生成）。

### META-SPRINGER

- [ ] **META-SPRINGER — 迁移 Springer search/lookup、access feedback 和 cursor。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：经共享 Network search/lookup、access feedback 和 cursor；在 adapter 内转换为中性 observation/provenance，具体 endpoint/字段取现有 adapter 和技术合同。
  - 改动面：`apps/server/src/metadata/providers/springer/`。
  - 依赖：[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)、[CONFIG-CREDENTIAL](02-runtime-storage-network.md#config-credential)。
  - 验收：独立合成 fixture 覆盖records/total 映射、空结果、认证拒绝及坏分页；与 Python 对相同输入做记录/标识/作者顺序/分页终止差分；敏感值不进失败，未支持能力不伪装成功，所有请求只到 fake/loopback。
  - 直接验证：`apps/server/test/springer-provider.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/springer-provider.md`（尚未生成）。

### META-WEB-OF-SCIENCE

- [ ] **META-WEB-OF-SCIENCE — 分别迁移 WoS starter/expanded search/lookup/citation/reference adapter。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：经共享 Network 分别实现 starter 与 expanded 的 search/lookup/citation/reference 能力边界；在 adapter 内转换为中性 observation/provenance，具体 endpoint/字段取现有 adapter 和技术合同。
  - 改动面：`apps/server/src/metadata/providers/web_of_science/`。
  - 依赖：[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)、[CONFIG-CREDENTIAL](02-runtime-storage-network.md#config-credential)。
  - 验收：独立合成 fixture 覆盖两个协议各自的合法页、缺能力拒绝、认证/限额错误及畸形 envelope；与 Python 对相同输入做记录/标识/作者顺序/分页终止差分；敏感值不进失败，未支持能力不伪装成功，所有请求只到 fake/loopback。
  - 直接验证：`apps/server/test/web-of-science-provider.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/web-of-science-provider.md`（尚未生成）。

### META-DISPATCH

- [ ] **META-DISPATCH — 统一 Source 选择、逐来源扫描和 publication。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：按 Auto/Custom 和每来源 raw-item limit 串行调用独立 adapter，向 Literature publication port 交付 observations 和失败信息。
  - 改动面：`apps/server/src/metadata/`。
  - 依赖：[META-ARXIV](#meta-arxiv)、[META-CORE](#meta-core)、[META-CROSSREF](#meta-crossref)、[META-DATACITE](#meta-datacite)、[META-ELSEVIER](#meta-elsevier)、[META-EUROPE-PMC](#meta-europe-pmc)、[META-OPENALEX](#meta-openalex)、[META-OPENCITATIONS](#meta-opencitations)、[META-SEMANTIC-SCHOLAR](#meta-semantic-scholar)、[META-SPRINGER](#meta-springer)、[META-WEB-OF-SCIENCE](#meta-web-of-science)。
  - 验收：Custom 精确保留顺序且允许为空，Auto 不靠凭据/在线探测推断；去重前 item 计数，混合成功/失败保留成功，不在 Metadata 阶段用语义相关性过滤。
  - 直接验证：`apps/server/test/metadata-dispatch.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/metadata-dispatch.md`（尚未生成）。

### LIT-IDENTITY

- [ ] **LIT-IDENTITY — 保持保守身份收敛与单一版本成员归属。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：保持 MetaLiterature/Literature 保守身份收敛、单一版本归属和冲突可审计；不增加无合同依据的公开 merge/split 操作。
  - 改动面：`apps/server/src/literature/`。
  - 依赖：[REPOSITORY-OBSERVATION](02-runtime-storage-network.md#repository-observation)、[META-DISPATCH](#meta-dispatch)。
  - 验收：不同来源的相同文献收敛且 observations 留存；矛盾标识/version_links 不强行合并，重复接纳幂等；无本地身份的 Provider ID 不成为 Literature ID。
  - 直接验证：`apps/server/test/literature-identity.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/literature-identity.md`（尚未生成）。

### LIT-CURRENT-FACTS

- [ ] **LIT-CURRENT-FACTS — 迁移 version/current facts、observation precedence 和 stale CAS 处理。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：按业务规则选择当前 metadata、version 和阶段可用状态，使用 CAS 更新，不由 Storage 推断业务。
  - 改动面：`apps/server/src/literature/`。
  - 依赖：[LIT-IDENTITY](#lit-identity)、[REPOSITORY-OBSERVATION](02-runtime-storage-network.md#repository-observation)。
  - 验收：用户导入非空值优先、Provider 差异保留；stale CAS 不覆盖新事实；后续解析/分析失败不撤销 metadata 或已接纳资产。
  - 直接验证：`apps/server/test/current-facts.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/current-facts.md`（尚未生成）。

### LITERATURE-ASSET-PUBLICATION

- [ ] **LITERATURE-ASSET-PUBLICATION — 由 Literature owner 将已确认 Candidate 发布为正式文献资产。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：消费 durable Candidate、identity/version evidence 与 receipt；在确认 Literature/版本成员和 current-facts 前置后，调用原子发布 port 建立 Asset、LiteratureAsset、primary-pdf/current 引用和 provenance。
  - 改动面：`apps/server/src/literature/`、`apps/server/src/storage/`。
  - 依赖：[LIT-IDENTITY](#lit-identity)、[LIT-CURRENT-FACTS](#lit-current-facts)、[CANDIDATE-PUBLICATION](03-browser-and-acquisition.md#candidate-publication)、[REPOSITORY-ATOMIC-PUBLICATION](02-runtime-storage-network.md#repository-atomic-publication)。
  - 验收：同 receipt/hash 重放幂等；错误 Literature、冲突版本、uncertain verdict、异 hash 和 stale CAS 不覆盖现有主资产；文件发布与 DB 提交间崩溃可对账；只有本 Task 的 Literature owner 能写 primary-pdf/current facts。
  - 直接验证：`apps/server/test/literature-asset-publication.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/literature-asset-publication.md`（尚未生成）。

### LIT-REFERENCES

- [ ] **LIT-REFERENCES — 迁移 metadata/content/provider reference acceptance 和 closure。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：接受 metadata/content/provider 三类 reference support；仅在目标已得到本地身份后建立关系。
  - 改动面：`apps/server/src/literature/`。
  - 依赖：[LIT-CURRENT-FACTS](#lit-current-facts)、[REPOSITORY-REFERENCE](02-runtime-storage-network.md#repository-reference)。
  - 验收：未解析原文可保存而不造占位文献；同边多支持可查询；移除某一支持不误删仍被其它支持维持的关系，查询不无界物化目标。
  - 直接验证：`apps/server/test/literature-references.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/literature-references.md`（尚未生成）。

### LIT-DELETE

- [ ] **LIT-DELETE — 迁移 deletion、replacement 和 no-usable-content cleanup 语义。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：实现已获准的替换和 NoUsableContent 清理，先验证输入 hash/关系前置条件，再由各 owner 删除对应事实。
  - 改动面：`apps/server/src/literature/`。
  - 依赖：[LIT-REFERENCES](#lit-references)、[REPOSITORY-ASSET](02-runtime-storage-network.md#repository-asset)。
  - 验收：仅明确 NoUsableContent 清理对应 PDF/解析/分析关系；超时、未知和解析错误保留资产；stale 输入或替换中断不删除新主资产，用户原文件不受影响。
  - 直接验证：`apps/server/test/literature-deletion.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/literature-deletion.md`（尚未生成）。

### DISCOVERY-ENTRY

- [ ] **DISCOVERY-ENTRY — 迁移 topic/citation discovery、scope、report 和 cancellation。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：分别实现 topic 与 bounded citation discovery，冻结逐 Source raw limit 和目标边界，发布 DiscoveryRun 及独立报告。
  - 改动面：`apps/server/src/entry/`、`apps/server/src/metadata/`。
  - 依赖：[LIT-IDENTITY](#lit-identity)、[ACQUISITION-ROUTE](03-browser-and-acquisition.md#acquisition-route)。
  - 验收：重复/被过滤 item 仍计 raw limit；一个 Provider 失败不撤销其它成功；citation 只在方向/深度/数量内物化，不自动 PDF/Parsing/Analysis，也不逐篇全源补查。
  - 直接验证：`apps/server/test/discovery-entry.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/discovery-entry.md`（尚未生成）。

### IMPORT-METADATA

- [ ] **IMPORT-METADATA — 迁移 BibTeX/CSL JSON/RIS import、逐记录结果和 provenance。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：分别实现 BibTeX、CSL JSON、RIS 逐记录解析与接纳，形成用户 observation、provenance 和导入报告。
  - 改动面：`apps/server/src/entry/codecs/`、`apps/server/src/entry/`。
  - 依赖：[LIT-IDENTITY](#lit-identity)、[REPOSITORY-OBSERVATION](02-runtime-storage-network.md#repository-observation)。
  - 验收：三格式合成输入覆盖作者顺序/标识/缺失值；坏记录不吞掉其它合法记录，重复 matched 不造新事实，非空导入值不被 Provider 覆盖。
  - 直接验证：`apps/server/test/metadata-import.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/metadata-import.md`（尚未生成）。

### IMPORT-PDF

- [ ] **IMPORT-PDF — 迁移用户指定 Literature 的 PDF admission 和 immutable asset。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：复制用户显式指定 Literature 的 PDF 到受控 staging，经相同基本 PDF 验收后，生成导入 Candidate 并调用 Literature 的正式资产发布边界。
  - 改动面：`apps/server/src/entry/`。
  - 依赖：[PDF-ACCEPTANCE](03-browser-and-acquisition.md#pdf-acceptance)、[LITERATURE-ASSET-PUBLICATION](#literature-asset-publication)。
  - 验收：有效合成 PDF 可复制接纳且原文件 hash/位置不变；无效输入、缺目标或已有主 PDF 默认拒绝；失败只清理自有 staging。
  - 直接验证：`apps/server/test/pdf-import.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/pdf-import.md`（尚未生成）。

### EXPORT-METADATA

- [ ] **EXPORT-METADATA — 迁移 scoped BibTeX/CSL JSON/RIS export 和 no-clobber output。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：按 scope 从当前 metadata 导出 BibTeX/CSL JSON/RIS；保持作者、ID、Unicode 和格式约定。
  - 改动面：`apps/server/src/entry/`。
  - 依赖：[LIT-CURRENT-FACTS](#lit-current-facts)、[FILE-PUBLICATION](02-runtime-storage-network.md#file-publication)。
  - 验收：无 PDF 的合法 metadata 可导出并由对应 parser 重读；错 scope 不触发外部补查；输出存在时遵守显式 overwrite 合同，失败不损坏原输出。
  - 直接验证：`apps/server/test/metadata-export.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/metadata-export.md`（尚未生成）。

### EXPORT-ARTIFACT

- [ ] **EXPORT-ARTIFACT — 迁移 PDF/content artifact export、overwrite 保护和 raw stdout。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：按稳定文献 ID 导出 PDF/content 已发布产物，校验相对引用和 hash，区分原始 stdout 与文件输出。
  - 改动面：`apps/server/src/entry/`。
  - 依赖：[REPOSITORY-ASSET](02-runtime-storage-network.md#repository-asset)、[FILE-PUBLICATION](02-runtime-storage-network.md#file-publication)。
  - 验收：导出 bytes/hash 一致，stdout 不混入日志；缺失/坏 hash/路径越界可见失败；现有目标默认保留，显式 overwrite 只影响指定导出副本。
  - 直接验证：`apps/server/test/artifact-export.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/artifact-export.md`（尚未生成）。

### PARSER-MINERU

- [ ] **PARSER-MINERU — 迁移 operator-managed MinerU health/submit/poll/result handoff，不引入服务状态 owner。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：保持 operator-managed health/submit/poll/result handoff，由 Network 处理凭据、上传许可和限额，转换为 parser-neutral Markdown/artifacts。
  - 改动面：`apps/server/src/parsing/`。
  - 依赖：[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)、[REPOSITORY-ASSET](02-runtime-storage-network.md#repository-asset)。
  - 验收：loopback fixture 覆盖成功/轮询/坏返回/超时/取消；无上传许可零上传，资源引用与输入 hash 保留；服务失败不删除 PDF，也不新建第二套 MinerU 业务状态。
  - 直接验证：`apps/server/test/mineru-handoff.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/mineru-handoff.md`（尚未生成）。

### ANALYSIS-METADATA

- [ ] **ANALYSIS-METADATA — 迁移 metadata analysis prompt、budget、schema 和 receipt。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：以同一 ParserResult 先做实际内容判断与最终 metadata，记录输入 hash、schema 校验和 Analysis provenance。
  - 改动面：`apps/server/src/analysis/`。
  - 依赖：[AGENT-RUNTIME](02-runtime-storage-network.md#agent-runtime)、[LIT-CURRENT-FACTS](#lit-current-facts)、[PARSER-MINERU](#parser-mineru)。
  - 验收：合成模型返回有效/NoUsableContent/无法判断/坏 schema 时分支可区分；只有明确无内容触发清理；偏离检索主题不能被当作无内容。
  - 直接验证：`apps/server/test/metadata-analysis.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/metadata-analysis.md`（尚未生成）。

### ANALYSIS-CONTENT

- [ ] **ANALYSIS-CONTENT — 迁移 markdown content analysis、chunk/lineage 和 artifact publication。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：以已确认 metadata 和同一解析结果总结 Markdown，保持标题、“未提供”、引用顺序、单一 current content 与 lineage。
  - 改动面：`apps/server/src/analysis/`。
  - 依赖：[ANALYSIS-METADATA](#analysis-metadata)、[REPOSITORY-ASSET](02-runtime-storage-network.md#repository-asset)。
  - 验收：输出结构与冻结合同一致；分块输入有界且引用资源可追溯；模型失败或发布失败保留已提交 metadata/原 PDF，不发布半成品 content。
  - 直接验证：`apps/server/test/content-analysis.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/content-analysis.md`（尚未生成）。

### ANALYSIS-REFERENCES

- [ ] **ANALYSIS-REFERENCES — 迁移 reference analysis、evidence 和 relation publication。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：从分析得到的有序参考文献形成带原文/证据的解析请求，由 Literature 接受身份和关系。
  - 改动面：`apps/server/src/analysis/`。
  - 依赖：[ANALYSIS-CONTENT](#analysis-content)、[LIT-REFERENCES](#lit-references)。
  - 验收：无法解析条目保留原文，不伪造 DOI/目标；已解析本地目标建立带 support 的关系，失败重放不复制边；模型不直接写数据库。
  - 直接验证：`apps/server/test/reference-analysis.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/reference-analysis.md`（尚未生成）。

### LIBRARY-QUERY

- [ ] **LIBRARY-QUERY — 迁移 search/detail/reference/cited-by、sort、cursor 和 structured output。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：实现 search/detail/references/cited-by 的一致快照、FTS、排序、cursor 和结构化可用性输出。
  - 改动面：`apps/server/src/literature/`、`apps/server/src/entry/`。
  - 依赖：[LIT-REFERENCES](#lit-references)、[ANALYSIS-REFERENCES](#analysis-references)。
  - 验收：在合成 v1 库按相同查询与 Python 差分；并列排序/分页无重漏，坏 cursor 拒绝；纯查询零外部 I/O、零事实写入。
  - 直接验证：`apps/server/test/library-query.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/library-query.md`（尚未生成）。

### ENTRY-APPLICATION

- [ ] **ENTRY-APPLICATION — 闭合业务公共入口和生产对象图。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：把迁移后的公开 Application/业务 API、报告和取消连接到唯一 bootstrap；CLI、服务及外部 Agent 消费同一应用边界。
  - 改动面：`apps/server/src/entry/`。
  - 依赖：[DISCOVERY-ENTRY](#discovery-entry)、[LITERATURE-ASSET-PUBLICATION](#literature-asset-publication)、[LIT-DELETE](#lit-delete)、[IMPORT-METADATA](#import-metadata)、[IMPORT-PDF](#import-pdf)、[EXPORT-METADATA](#export-metadata)、[EXPORT-ARTIFACT](#export-artifact)、[PARSER-MINERU](#parser-mineru)、[ANALYSIS-REFERENCES](#analysis-references)、[LIBRARY-QUERY](#library-query)、[APP-LIFECYCLE](02-runtime-storage-network.md#app-lifecycle)。
  - 验收：从安装入口调用公开操作，集成真实合成 repositories 与文件 store；无 duplicate owner/secret/vendor 对象外泄；失败与中断报告从操作结果形成，盘点的公开符号均有实际归属。
  - 直接验证：`apps/server/test/application-api.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/application-api.md`（尚未生成）。

### CLI-DISCOVERY

- [ ] **CLI-DISCOVERY — 实现 `discover topic` 与 `discover citations` 的参数、JSON、错误和退出码。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：把 discover topic/citations 参数映射到同一应用入口，输出操作报告、JSON 和稳定退出码。
  - 改动面：`apps/server/src/entry/cli/`。
  - 依赖：[DISCOVERY-ENTRY](#discovery-entry)、[ENTRY-APPLICATION](#entry-application)。
  - 验收：帮助与基线 command specs 一致；合法 fake 结果与报告匹配；坏参数在调用前失败，部分失败和受控中断保留已完成结果且 JSON 无日志污染。
  - 直接验证：`apps/server/test/cli-discovery.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/cli-discovery.md`（尚未生成）。

### CLI-COMPLETION

- [ ] **CLI-COMPLETION — 提供 pdf/parse/content 数据库补全命令。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：提供 pdf/parse/content 三种目标及受支持 selector，按当前缺失阶段冻结目标并输出统一补全报告。
  - 改动面：`apps/server/src/entry/cli/`。
  - 依赖：[IMPORT-PDF](#import-pdf)、[ANALYSIS-CONTENT](#analysis-content)、[ENTRY-APPLICATION](#entry-application)。
  - 验收：目标和 selector 与基线入口一致；重复执行复用有效阶段；取消保留部分报告，系统/解析/模型失败不触发跨版本回退，稳定缺失才允许版本回退。
  - 直接验证：`apps/server/test/cli-completion.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/cli-completion.md`（尚未生成）。

### CLI-LIBRARY

- [ ] **CLI-LIBRARY — 实现 `literature search/show/references/cited-by` 的帮助和结果。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：提供 literature search/show/references/cited-by 的参数、帮助、分页和 JSON/人类输出。
  - 改动面：`apps/server/src/entry/cli/`。
  - 依赖：[LIBRARY-QUERY](#library-query)、[ENTRY-APPLICATION](#entry-application)。
  - 验收：命令结果与应用查询一致；未知 ID/坏 cursor/互斥参数有稳定错误，所有纯查询不加载远程客户端或触发联网。
  - 直接验证：`apps/server/test/cli-library.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/cli-library.md`（尚未生成）。

### CLI-EXCHANGE

- [ ] **CLI-EXCHANGE — 实现 `import metadata/pdf`、`export metadata/pdf/content` 的参数与输出。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：连接 import metadata/pdf 与 export metadata/pdf/content 到同一应用入口，保持 scope、路径和 overwrite 语义。
  - 改动面：`apps/server/src/entry/cli/`。
  - 依赖：[IMPORT-METADATA](#import-metadata)、[IMPORT-PDF](#import-pdf)、[EXPORT-METADATA](#export-metadata)、[EXPORT-ARTIFACT](#export-artifact)、[ENTRY-APPLICATION](#entry-application)。
  - 验收：三格式导入/导出与 PDF/content 均可从 CLI 重放；坏输入有逐记录报告，stdout 字节不含状态文本，默认不覆盖已有目标。
  - 直接验证：`apps/server/test/cli-exchange.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/cli-exchange.md`（尚未生成）。

### MODEL-CATALOG

- [ ] **MODEL-CATALOG — 在模型配置流程执行有界模型目录读取。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：新增远程 Provider/Model 时由配置 owner 隐藏接收 key，执行一次有界只读目录请求；失败或空列表才进入手工输入。
  - 改动面：`apps/server/src/configuration/`。
  - 依赖：[CONFIG-PUBLICATION](02-runtime-storage-network.md#config-publication)、[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)、[AGENT-RUNTIME](02-runtime-storage-network.md#agent-runtime)。
  - 验收：合成目录结果只在当前流程可用，不持久化或当 capability 证明；status/首页零请求，超限/取消/redirect 遵守 Network，key 不进预览。
  - 直接验证：`apps/server/test/model-catalog.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/model-catalog.md`（尚未生成）。

### CONFIG-PROBE

- [ ] **CONFIG-PROBE — 提供按 owner 组织的无 Storage 探测。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：为 Provider/Model/Search/Download/Parse/Analyze/Browser 提供共用 Probe，明确每次安全请求和不可用能力，不实例化文献 Storage。
  - 改动面：`apps/server/src/configuration/`。
  - 依赖：[MODEL-CATALOG](#model-catalog)、[AGENT-RESPONSES](02-runtime-storage-network.md#agent-responses)、[AGENT-CHAT](02-runtime-storage-network.md#agent-chat)、[AGENT-ANTHROPIC](02-runtime-storage-network.md#agent-anthropic)、[PARSER-MINERU](#parser-mineru)、[SOURCE-BROWSER](03-browser-and-acquisition.md#source-browser)。
  - 验收：明确调用才发最小 fake/loopback 请求；Model 探测不能被目录成功替代；无安全 probe 的 Download 返回 unavailable，不下载任意 PDF；结果保留安全类别/下一步且不含响应正文或 vendor message。
  - 直接验证：`apps/server/test/configuration-probe.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/configuration-probe.md`（尚未生成）。

### CONFIG-EDITOR

- [ ] **CONFIG-EDITOR — 完成普通配置和凭据的交互编辑闭环。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：交互流程按 owner 管理 Provider/Model/Search/Download/Parse/Analyze/Browser，任务只选 Model；保存前展示不含 secret 的摘要。
  - 改动面：`apps/server/src/entry/`。
  - 依赖：[CONFIG-PUBLICATION](02-runtime-storage-network.md#config-publication)、[CONFIG-PROBE](#config-probe)。
  - 验收：合成输入可新增/修改/删除并由同一 parser 重读；Browser 只列出图片 Model，Model 更新不污染另一任务；取消编辑零写入，重复名称和孤立引用在保存前拒绝。
  - 直接验证：`apps/server/test/configuration-editor.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/configuration-editor.md`（尚未生成）。

### CLI-CONFIG

- [ ] **CLI-CONFIG — 实现 `config/status/test` 的 owner target、脱敏和退出码。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：让 config 交互入口与 status/test 调用相同 Configuration/Probe 服务，按 Provider/Model/Search/Download/Parse/Analyze/Browser owner 展示。
  - 改动面：`apps/server/src/entry/cli/`。
  - 依赖：[CONFIG-EDITOR](#config-editor)、[CONFIG-PROBE](#config-probe)。
  - 验收：status 纯本地且脱敏；test 只调用显式选中对象，CLI 与交互结果一致；错误保留安全类别和下一步，不泄漏 vendor message 或伪称 entitlement。
  - 直接验证：`apps/server/test/cli-configuration.test.ts`。
  - 证据：拟写入 `migration/evidence/business-service/cli-configuration.md`（尚未生成）。

## 执行方式与集成点

串行完成每个 provider adapter，再汇合到 Literature；Candidate 只有在 identity/version 与 Literature owner
共同闭合后才发布正式资产。随后推进 Discovery、导入导出、Parsing、Analysis、Query、配置和 CLI；每个切片
执行预检、直接正反例、差分审查与证据记录，不启用并行实施。

## 审查门

R1 检查 Browser/Storage 交接；R2 检查每个 Provider 的凭据、请求、响应、分页、失败和业务 owner；R3 检查
Literature 正式资产发布、全部业务 parity、公开入口和对象图。真实库写入、Candidate 越权写 current facts、
双写或万能解析器属于 blocking finding。

## 接口 / 数据 / 依赖影响

增加业务 API，并由 Literature owner 接入 Candidate 正式发布；不在本块增加 execution schema、队列或服务认证。
v1 schema 与读写语义保持兼容；供应商专属 schema 不进入通用 contracts，vendor 对象不越过 adapter。

## 验证与证据

证据目录为 `migration/evidence/business-service/`。每个 Metadata Task 使用行为命名测试（例如
`arxiv-provider.test.ts`、`crossref-provider.test.ts`），业务和 CLI 使用 `literature-identity.test.ts`、
`metadata-import.test.ts`、`library-query.test.ts`、`cli-discovery.test.ts` 等名称；测试只使用合成响应、fake
Network、loopback 和合成数据库。现有记录若位于旧证据目录，可在执行时迁移索引，但不得把目录移动当作验收。

## 退出条件

36 项 Task 全部闭合；11 个 Metadata adapter 各自有 parity 证据；Literature identity/current facts/正式资产发布、
输入输出、Parsing、Analysis、Query、配置、CLI、公共 Application 入口和 R3 审查全部通过。

## 完成证据

执行后填写每个 Task 的覆盖、差分范围、副本指纹、恢复演练、命令、跳过项和残余风险；当前为空。

## 失败与恢复

Provider 差异回到对应 `META-*`；身份/current facts 差异回到 `LIT-*`；Candidate 正式发布差异回到
`LITERATURE-ASSET-PUBLICATION`；输入输出、Parsing、Analysis、Query、配置或 CLI 差异回到对应 Task；对象图
差异回到 `ENTRY-APPLICATION`/`APP-COMPOSITION`。保留合成失败材料，不修改真实资料。

## 下游交接

向 Block 05 交接业务公开入口、逐 Provider parity 证据、正式 Literature 资产发布边界、配置/CLI 行为和已知限制；
不交接 execution schema、常驻服务完成声明、真实迁移结果或未授权切换决定。
