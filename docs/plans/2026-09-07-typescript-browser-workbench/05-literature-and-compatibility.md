# M4｜全部业务能力迁移与兼容关闭

## 结果

本文件承接原始 T037–T045。M4 的完成标准是所有现有 Metadata、Acquisition、Literature、Discovery、Import、Parsing、Analysis、Query、Export 和 CLI 能力均由 TypeScript 实现，并有离线差分、失败边界、生产组装和文档证据。Browser 首阶段和一个 Crossref 代表性切片不能替代业务全集迁移。

## 当前可复用切片

- Literature 身份、版本、Candidate 发布、current facts、查询、详情、引用和 Artifact 读取已有 TS 实现与 loopback 证据；
- Crossref 已完成一个代表性离线转换差分；
- Browser → Candidate → Literature → loopback MinerU → 两阶段 Analysis → Library 已有 source-checkout 旅程；
- MinerU client、archive conversion、artifact rules、current 发布和两阶段 Analysis 已经纯 TS；Python 历史文件按 T061 退役报告标记为非运行材料，不进入生产包。

这些证据保留在 `migration/evidence/runtime/`，只减少后续实现量，不改变 T037–T045 的退出条件。

## 原始任务

| ID | 必须完成的能力 | 直接验收 | 当前状态 |
| --- | --- | --- | --- |
| T037 | 迁移 11 个 Metadata Provider、Auto/Custom、search/lookup/citations、分页和逐来源 raw limit | 每个 Provider 有协议 fixture、分页终止、标识转换、引用能力和未支持能力记录；不访问真实 Provider | **完成**；11 Provider、实际 capability、生产组装、分页/limit、readiness 与凭据边界见 [`metadata-provider-matrix.md`](../../../migration/evidence/runtime/metadata-provider-matrix.md) |
| T038 | Literature 身份接纳、冲突/合并、版本、引用 support 和 current facts | 同输入 ID、关系、排序、hash、来源 observation 与稳定 Python 行为一致 | **完成**；严格 identity/fallback、Provider record、user replay、metadata projection、版本聚合、原子 CAS、三级状态和三类 Reference support 见 [`literature-identity-publication.md`](../../../migration/evidence/runtime/literature-identity-publication.md) |
| T039 | 迁移 7 个 Acquisition source 和 CORE/Elsevier/Wiley 授权 provider | 每个旧 adapter 有 TS 实现或批准退役；Public/API/Browser 走相同字节、身份和发布门 | **完成**；全集、选择/readiness、publisher evidence、landing/object、凭据、真实 provenance 与统一 Candidate 发布门见 [`acquisition-source-matrix.md`](../../../migration/evidence/runtime/acquisition-source-matrix.md) |
| T040 | 迁移 topic/citation DiscoveryRun、六类 selector、BibTeX/BibLaTeX、RIS、CSL-JSON 和 Import | 多来源部分失败保留已提交事实；导入 created/enriched/matched/rejected；用户文件只读 | **完成**；逐 run Provider 限额、部分失败持久事实、无截断 selector、逐记录 codec、四格式往返、identity outcome 和只读 CLI 输入见 [`discovery-import-typescript.md`](../../../migration/evidence/runtime/discovery-import-typescript.md) |
| T041 | 迁移 MinerU client、上传授权、资源路径、ParserResult 和 current 结果发布 | 最终代码不调用 Python；remote origin/credential 有独立边界；失败不撤销旧结果 | **完成**；纯 TS loopback/remote 协议、primary JSON、archive/resource 安全、current CAS、远程上传授权和 exact-origin token 已验，生产 export/Application 不再暴露 Python parser seam；见 [`mineru-typescript.md`](../../../migration/evidence/runtime/mineru-typescript.md) |
| T042 | 迁移 metadata/content 两阶段 Analysis、结构化输出、Markdown、引用提取和 NoUsableContent | schema、hash、输出、provenance、lineage 和失败保留有差分；模型文本不直接成为 current content | **完成**；TS AgentRuntime 直接执行两阶段 schema，元数据证据保护、固定 Markdown/引用对齐、canonical hash、provenance/lineage、NoUsableContent、陈旧/取消/预算/失败保留均有离线测试，生产源码不再包含 Python Analysis seam；见 [`analysis-typescript.md`](../../../migration/evidence/runtime/analysis-typescript.md) |
| T043 | 完成 FTS/search/detail/references/cited-by 与 metadata/pdf/content 原子导出 | 本地读取不联网；同一快照；格式往返；默认不覆盖，显式覆盖仍原子 | **完成**；本地 Query/Detail/Reference snapshot、四格式批量导出代表版本/显式顺序、verified PDF/content 读取和原子 no-clobber/overwrite 均有 TS 离线证据；见 [`library-query-export-typescript.md`](../../../migration/evidence/runtime/library-query-export-typescript.md) |
| T044 | 完成 `discover/complete/literature/import/export/config` 全命令树和 TS 单次 Application | 安装包无 Python RPC；JSON、stdout/stderr、退出码、非 TTY 和 local status 行为兼容 | **完成**；TS CLI 还提供 storage、doctor、jobs create/run，安装后 smoke 已验证 |
| T045 | 关闭全部模块、Provider、CLI、配置和测试差分清单 | `migration/inventory.json` 每项有 TS target/test/evidence、任务和处置；无未归属能力 | **完成**；242 模块、8 入口、11 Provider、7 Source、3 授权 Provider、23 CLI、161 测试均已登记 |

完整 Provider 和 Acquisition 清单见[迁移映射](migration-map.md)。

## 实施切片

为避免一次性机械翻译，每个切片都按相同顺序完成：

1. 从 Python 公开边界和直接测试冻结合成输入、输出、原字节、错误与副作用；
2. 在所属 TS 模块实现中性 contract 和一个 adapter/用例；
3. 用 fake/fixture/loopback 验证成功、分页/预算/取消和错误，不连接真实服务；
4. 接入唯一 Application、CLI 或工作台；
5. 更新 inventory disposition 和证据；
6. 运行相关 Vitest、`pnpm quick` 和代码交付时的 `pnpm full`。

T037–T043 已关闭。后续完成 CLI，再以 T045 的逐项 inventory 差分关闭 M4。

## 兼容与有意变化

必须逐项比较 canonical bytes/hash、Unicode 身份、DOI/arXiv、null/undefined、时间精度、SQLite int64、作者/关键词/引用顺序、查询排序、报告、退出码和导入导出转义。发现 Python 旧错误时保留 fixture，在 intentional-change ledger 中说明新行为、依据和审批状态；不能通过重算旧数据、吞错或弱化测试获得绿色结果。

## 退出门

T037–T045 全部有产物、直接测试、Application/CLI 生产组装和必要文档；当前 242 个活动模块（原始 235 个 + 7 个迁移 bridge）、8 个公开入口、11 个 Metadata Provider、7 个 Acquisition source、3 个授权 provider、23 个 CLI 路径和 161 个测试语义没有未归属项。最终安装包仍可在 M6 前保留未发布状态，但 M4 业务代码不得依赖 Python 运行时。
