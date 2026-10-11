# 同一生产数据库的主题与种子发现复验

2026-10-10，用户明确要求“上生产测试”，核对两种发现方式遇到已有文献时的行为。
运行基线为 `b30af24eee78933bc0775cd3ac6b5d0b2ee15439` 加当前工作区修复，
包含已通过 Full 的 Provider 可选字段边界修改。

结论：**主题发现、参考文献扩展与被引扩展均完成真实调用和正式入库；重复运行复用相同文献 ID 与引用边 ID。
当前仍重新请求供应商，并追加来源 observations，因此不能理解为已有文献完全不再请求、不再写入。**

## 生产范围与数据保护

- 通过配置 owner 解析当前 Catalog 的精确位置：仓库下
  `work/provider-live-battery-materials-overall-debug100-20260902/catalog.sqlite3`。
  实际使用现有生产库，未重定向到临时测试库；Catalog v2 保持不变。
- 写入前通过 SQLite backup API 保存一致性备份。脚本、备份、日志和详细结果统一位于
  `/tmp/sciretriever-production-discovery-repeat-20261010-DXVP8y/`，不提交真实数据。
- 每轮使用正式 `createApplication`、生产 Metadata assembly、Network、身份接纳、Storage 与 Library Query。
  没有注入 fake、resolver、代理或响应；仅包装现有方法记录调用数量、结果和接纳决定，返回值保持原样。
- 每轮关闭应用，下一轮重新打开同一库。最后使用独立 `createQueryApplication` 复核全部 11 个 DiscoveryRun 的结果 ID。
- 本轮只执行元数据与引用发现，没有启动 PDF 下载、Browser、模型或解析，没有修改个人配置、依赖、产品代码或数据库 schema。
  调用生产 TypeScript 操作入口，没有另外覆盖 CLI/MCP/Web 入口。

## 主题发现与重跑

查询为 `photoredox catalysis organic synthesis`，年份 2015–2025，
Crossref、Europe PMC 各扫描 50 个原始项。

| 操作 | 原始项 / 成功转换 | 新增文献 | 命中已有文献 | 结果 |
| --- | --- | --- | --- | --- |
| 首次主题发现 | 100 / 100 | 99 | 0 | COMPLETED，99 个结果 |
| 关闭重开后重复发现 | 100 / 100 | 0 | 99 | COMPLETED，99 个文献 ID 与首轮完全一致 |

未接纳的 1 条为 `10.1021/acs.orglett.5c05023`：后续正式 Crossref lookup 确认规范发表日期为
`2026-01-09`，不在 2015–2025 的请求范围内。它消耗原始扫描预算，但没有被这次主题发现接纳。

重跑没有创建 Literature 或 MetaLiterature，但增加了 99 条 MetadataObservation 和 1 个 DiscoveryRun。
两轮 Europe PMC 的 50 条来源记录 hash 全部相同，仍形成新的来源 observation。

## 种子发现与重跑

参考文献种子为 `10.3762/bjoc.21.200`，已在主题结果中；通过 Europe PMC 的明确 DOI 查询复用该文献。
方向为 references，深度 1，原始项预算 60、结果上限 100。

被引非空样本为 PMID `41065217`，通过 Europe PMC 明确 PMID 查询定位；该文献已存在于本轮库中。
方向为 cited-by，深度 1，原始项预算 30、结果上限 20。

| 操作 | 返回结果 | 新增文献 | 新增引用边 | 重复与方向核对 |
| --- | --- | --- | --- | --- |
| 种子参考文献首次扩展 | 45 | 45 | 45 | 正常耗尽，全部入库 |
| 同一种子参考文献重复扩展 | 45 | 0 | 0 | 45 个文献 ID 和 45 个引用边 ID 全部复用 |
| 非空被引首次扩展 | 4 | 3 | 3 | 其中 1 篇和对应引用边已由前面的参考文献扩展建立 |
| 同一种子被引重复扩展 | 4 | 0 | 0 | 4 个文献 ID 和引用边 ID 全部复用 |

另测试了 DOI `10.3762/bjoc.21.200` 的 cited-by 两轮，均为正常耗尽、零结果，没有误报失败。
以上引用响应自带可接纳的目标元数据，实际额外 `lookupProvider` 调用均为 0。
这证明本批无需逐篇补查，不能据此宣称测到了“首次需要 lookup、重跑省去 lookup”的请求差值。

## 跨供应商身份核对

对已有 DOI `10.3762/bjoc.21.200` 使用正式 Crossref 精确 lookup，再由身份 owner 接纳：
`created=false`、`outcome=enriched`，复用 Europe PMC 已建立的 Literature/MetaLiterature ID，
文献数量不增加，增加 1 条 Crossref 来源记录。

附加对照也显示：将 DOI 字符串直接作为 Crossref **主题搜索文本**不能当作精确 lookup。
这次第一名返回 `10.1080/01973762.2006.9658780`（Notes for Contributors），被按正常主题候选接纳为另一篇文献。
该对照贡献了总增量中的 1 篇，原样保留；没有把它误报为重复文献，也没有擅自删除。
已知 DOI 的精确定位应使用 lookup，不能以主题搜索首项代替。当前主题发现不提供领域语义相关性保证，见 ADR 0013。

## “跳过”的实际范围

1. **文献实体去重**：成立。同一稳定标识符命中已有 Literature，来源不同也复用身份；有新增信息时可补充统一元数据。
2. **引用边去重**：成立。同一 source/target 复用 Reference，追加来源支持；重复结果数不等于新增文献数。
3. **跳过供应商请求**：不会因为上次执行过同一主题或种子就跳过。每次显式发现仍查询来源；引用目标已经在库中或响应有可接纳元数据时，无需额外目标 lookup。
4. **跳过来源写入**：当前新请求会生成新的 observation ID；Provider observation 只对同一 ID 的重放去重。
   即使内容未变化也可能追加来源记录。这符合当前独立来源观察的实现，不能把它宣传为完全无重复写入。
5. **只统计新文献**：不是当前结果/预算合同。已有文献仍计入发现结果与原始扫描预算，
   不会为了凑齐指定数量的新文献而无限继续请求，见 [ADR 0013](../architecture/decisions/0013-decoupled-discovery-and-database-maintenance.md)。

来源长期保存的边界见 [ADR 0002](../architecture/decisions/0002-literature-identity-and-incremental-processing.md)。
若今后要求完全相同内容不重复保存，或者重复发现自动走缓存，需要单独确定来源刷新与保留语义；本轮测试没有修改策略。

## 数据库前后与验收

| 数据 | 测试前 | 测试后 | 增量 |
| --- | --- | --- | --- |
| Literature / MetaLiterature | 482 / 482 | 630 / 630 | 各 148 |
| MetadataObservation | 490 | 791 | 301 |
| Reference | 0 | 48 | 48 |
| Provider relation observation | 16,038 | 16,136 | 98 |
| 引用边来源支持 | 0 | 98 | 98 |
| DiscoveryRun | 3 | 14 | 11 |
| Asset | 206 | 206 | 0 |

原有 482 行 Literature 身份/状态记录与备份逐行一致；原有 206 行 Asset 记录逐行一致。
所有重复运行的文献 ID、引用边 ID 一致；全库不存在同一 namespace/value 的多文献归属，
也不存在相同 source/target 的重复 Reference。SQLite `foreign_key_check` 无错误，`integrity_check=ok`。

执行证据：

- `run.mjs` / `supplement.mjs`、`results.json`：11 个真实 DiscoveryRun、调用统计、前后计数和结果 ID。
- `lookup-check.mjs` / `lookup-check.json`：跨供应商精确定位、年份排除原因。
- `verify.mjs` / `verification.json`：对照备份、去重、持久化与 SQLite 完整性断言，最终退出码 0。
- `reopen.json`：11 次发现结果关闭重开后的稳定性。
- `catalog-before.sqlite3`：本轮写入前的一致性备份，未用于覆盖生产库。

本轮未新增或修改产品代码，因此没有重复执行 Full；本轮开始前的集成状态已通过
205 文件 / 1,448 项测试，39 项按既有条件跳过。新增文档检查 diff、相对链接与事实一致性。
本次实测覆盖 Crossref、Europe PMC，以及有界重复发现；不证明所有 Provider、万篇规模或长期采集性能。
