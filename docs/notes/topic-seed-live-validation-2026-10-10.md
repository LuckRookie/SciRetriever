# 主题发现与种子引用扩展真实测试

2026-10-10（北京时间）按用户要求测试现有文献发现流程。测试基线为 `b30af24eee78933bc0775cd3ac6b5d0b2ee15439`。

同批文献后续的 [PDF 下载测试与统一问题汇总](pdf-live-validation-and-issues-2026-10-10.md)已另行记录；下文保留元数据发现阶段的原始结果。

结论：**主题发现可以接纳、持久化和查询文献，但年份限制和部分记录转换失败；种子引用扩展未通过，正式新增文献与确认引用关系均为零。** 原因包含供应商协议适配错误和发现流程的预算分配问题，本轮不能判定为可用于长期自动扩库。

## 执行范围

- 使用正式 `createApplication`、`TopicDiscoveryService`、`CitationDiscoveryService`、身份接纳、Storage 和 Library Query，调用真实 Crossref、Europe PMC，以及补测 Semantic Scholar。
- 使用服务器网络和生产 Network、DNS、限速策略，无 fake、代理或 resolver 注入。诊断包装仅记录响应摘要与异常，保持原返回值和错误。
- 使用独立临时 home 和新 catalog，无 API key；没有读取个人配置、操作现有文献库或用户材料。
- 主测试来源为 Crossref、Europe PMC，各扫描最多 100 条；引用测试显式指定来源，深度为 1，并设置扫描与结果上限。不是所有 Provider 的全面验收。
- 本次获取文献元数据及引用关系，没有下载 PDF、启动 Browser、调用模型或执行解析。没有测试 CLI/MCP/Web 操作入口、万篇容量或长期运行。
- 没有修改产品代码、配置合同、schema、依赖或测试；所有 API 对照请求只用于诊断，不能当作正式业务链路成功。

## 主题发现

主题为光氧化还原催化与有机合成，查询：`photoredox catalysis organic synthesis`，请求年份为 2015–2025。

| 项目 | 实际结果 |
| --- | --- |
| 首轮运行 | 约 9.9 秒，`PARTIAL` |
| Crossref | 扫描 100 条，91 条转换成功，9 条 `metadata-record-invalid`；有效结果仍被接纳 |
| Europe PMC | 扫描 100 条，100 条转换成功，来源报告 `SCAN_LIMIT_REACHED` |
| 身份接纳 | 190 篇不同文献，1 次匹配已有身份；保存 191 条元数据 observation |
| 按发现运行查询 | 返回 190 篇；关闭后以只读 Application 重开，仍可查询，分页可用 |
| 年份约束 | 结果中 97 篇为 2026 年、1 篇年份未知；请求上限未有效约束 Europe PMC |
| 重复运行 | 新增 1 篇、匹配 190 次，库从 190 增至 191 篇；再次运行的发现结果为 190 篇 |

重复运行新增的 DOI 是 `10.1055/s-0035-1560790`，首轮返回的 `10.26434/chemrxiv.11573400.v1` 则没有出现在第二轮扫描名单中。因此这次增加来自供应商结果集合变化，没有发现重复文献。最终检查全部在库标识，也未发现相同 namespace/value 分属不同 Literature 的情况。来源 observation 继续积累，不能将 observation 数当成文献数。

没有对全部召回结果做人工相关性评价；这些数量不代表精准相关文献数量。

## 种子扩展

种子均由正式发现与身份接纳取得，没有手工插入记录。

| 种子 | 来源与方向 | 供应商实际返回 | 正式结果 |
| --- | --- | --- | --- |
| *Visible-light-driven NHC and organophotoredox dual catalysis for the synthesis of carbonyl compounds.*，2025，DOI `10.3762/bjoc.21.200`，PMID `41293073` | Europe PMC，参考文献 | 总计 45 条，第一页已返回全部 45 条 | 解析器拒绝分页字段，`FAILED`，0 篇；重复运行仍失败 |
| 同上 | Europe PMC，被引用 | 0 条 | `COMPLETED`、0 篇；空结果不构成正向扩展成功证据 |
| *Organic Photoredox Catalysis*，2016，DOI `10.1021/acs.chemrev.6b00057`，PMID `27285582` | Europe PMC，参考文献 | 报告总计 579 条，第一页返回 100 条 | 第一页分页校验失败，0 篇 |
| 同上 | Europe PMC，被引用，扫描上限 300 | 报告总计 3,073 条，第一页通过，第二页已返回 | 第二页分页校验失败，`FAILED`，0 篇、0 条确认引用关系 |
| 同上 | Europe PMC，被引用，扫描上限 50、结果上限 10 | 已转换 50 条关系和 50 条附带元数据 | 没有执行目标 lookup；`COMPLETED` / `SCAN_LIMIT_REACHED`，0 篇、0 条确认引用关系 |
| *A Simplified, One-Pot, Procedure for the Deoxygenative Alkylation of Aryl Bromides.*，2025，DOI `10.1021/acs.orglett.5c03643`，PMID `41065217` | Europe PMC，被引用，扫描上限 50 | 全部 4 条关系解析成功 | 4 次目标 lookup 均为零，`COMPLETED`，0 篇、0 条确认引用关系 |
| 第一篇 2025 年种子 | Semantic Scholar，参考文献 | 当前 adapter 请求返回 HTTP 400 | `FAILED`，0 篇；仅改变 `fields` 的诊断对照取得 64 条，未交付正式引用扩展 |

这三篇种子仍属于同一个化学主题。较早综述用于排除“种子太新、没有引用”的解释；只有 4 条施引文献的样本用于排除“大页数或预算不足”的解释。

全部测试后，临时库共有 **192 篇文献、384 条元数据 observation、154 条供应商关系 observation、0 条确认引用关系、0 个资产**。192 篇由首轮 190 篇、主题复跑新增 1 篇、第三篇种子准备新增 1 篇组成；较早综述的 PMID 补充匹配到现有文献。没有任何文献是由正式种子扩展新增的。供应商关系 observation 仅是已保存的来源证据，不能当成可供 Library 查询的确认引用关系。

## 已复现的原因

### 1. Crossref 没有规范化供应商的展示文本

9 条转换失败中，5 条失败路径是 `title`，4 条是作者机构 `affiliations.*.name`。标题中有实际换行；复查 `10.1021/acs.joc.7b00088` 的机构字段为 `Institut für Organische\rChemie, ...`，包含回车。中性文本合同拒绝控制字符，而 adapter 对标题直接赋值、对机构只执行 `trim()`。

应在 [Crossref adapter](../../apps/server/src/providers/crossref/record.ts) 规范化外部展示文本，再进入中性合同；这不是请求未到达供应商，也不需要按 DOI 特判或放宽全局安全校验。

### 2. Europe PMC 年份条件没有转换为查询语法

[Europe PMC adapter](../../apps/server/src/providers/europe-pmc/metadata.ts) 将 `year_from`、`year_to` 作为独立 URL 参数传入。实际响应的 `request.queryString` 仍只有主题词，100 条中 97 条为 2026 年。

同一生产 transport 的对照请求使用 `(photoredox catalysis organic synthesis) AND PUB_YEAR:[2015 TO 2025]`，取得 100 条记录，全部 `pubYear=2025`。另一次 `FIRST_PDATE` 对照仍含 2026 年的 `pubYear`，说明首次发表日期与出版年份有不同语义，不能简单互换字段。

### 3. Europe PMC 引用分页被当成统一的记录偏移量

当前 `parseRelationPage` 要求返回 `request.offSet` 等于内部记录偏移 `0, 100, ...`。真实响应为：

- references 第一页 `page=1`，返回 `offSet=1`；两篇种子均因此立即失败。
- citations 第一页返回 `offSet=0`，第二页返回 `offSet=1`；当前第二页预期 100，因此失败。

异常为 `Europe PMC relation offset changed`。数据已到达，错误在供应商分页语义的解释；不能用增加超时解决。现有 fixture 使用 `offSet=0` 或累计记录偏移，没有覆盖此次真实响应。

### 4. Europe PMC 目标 lookup 混淆 source、记录 ID 和 DOI

引用目标的 `record_id` 为 `MED:41065217`，adapter 直接生成 `EXT_ID:MED:41065217`，真实返回 0 条。保持同一供应商和文献，`EXT_ID:41065217 AND SRC:MED` 返回 1 条。DOI lookup 也被写成 `EXT_ID:10.1021/acs.chemrev.6b00057` 并返回零；使用 `DOI:10.1021/acs.chemrev.6b00057` 返回正确文献。

4 条施引文献的小样本已在正式流程复现：关系查询正常，四次 `EXT_ID:MED:...` lookup 全部为空。程序的 `COMPLETED` 只表示本次运行正常结束，不能解释为供应商没有可扩展文献。

### 5. 公共引用发现流程先消耗扫描预算，再处理目标

[CitationDiscoveryService](../../apps/server/src/entry/discovery.ts) 先完整调用关系扫描；当来源达到 `scan_limit` 时，将该来源标为终态。随后处理关系，对尚未找到本地身份的目标直接跳过 lookup。返回的附带目标 metadata observation 也没有在这里直接接纳。

实测扫描上限 50 时，已经得到 50 条关系与 50 条附带元数据，随后没有任何 lookup，结果为零。提高上限不是根本解决办法：引用集合比预算大的种子仍可能先把预算耗尽。后续修复应保证有界扫描能够产生已接纳目标与有来源的引用边，同时维持资源上限。

### 6. Semantic Scholar 引用请求的 fields 不符合接口

[Semantic Scholar adapter](../../apps/server/src/providers/semantic-scholar/metadata.ts) 在引用请求中同时发送 `citedPaper.*`、`citingPaper.*` 的字段列表，真实接口返回 HTTP 400。

对照保留 DOI 路径、`limit=100`、`offset=0`，只把 `fields` 改成 `paperId,title,abstract,year,publicationDate,authors,externalIds,venue,citationCount,openAccessPdf`，成功返回 64 条参考文献。这证明本次 400 与请求字段有关；不能解释为论文不可获取、网络不通或匿名额度耗尽。对照没有改变正式 adapter，也没有将这 64 条手工入库。

## 验证边界与后续验收

本轮真实测试已完成，但两条能力未共同通过验收。可以继续小批量主题收集，尚不能依赖当前种子扩展自动积累文献。应先修复以上已复现阻碍，再用同样的种子复跑参考文献、施引文献、低预算、高引用数和重复运行；无需以本轮结果为由增加新的基础设施。

另外运行了 5 个现有相关 Vitest 文件，共 **12 个测试通过**：`metadata-crossref`、`metadata-europe-pmc`、`metadata-reference-adapters`、`discovery-topic`、`discovery-citation`。这些离线测试通过而真实流程失败，表明当前 fixture 与端到端用例未覆盖实际协议和预算行为，不能作为功能已可用的替代证据。

没有修改产品代码，因此未重跑 Quick/Full。种子扩展未形成确认引用边，故没有声称验证了引用方向、非空关系重跑去重、多层扩展或种子扩展中断恢复。年份限制以外的元数据完整度、全量召回和跨来源质量也未全面验收。

## 复现证据

本机隔离目录：`/tmp/sciretriever-live-discovery-20261009-GHy0tc/`。目录名使用 UTC 日期，执行事件为北京时间 2026-10-10。

| 文件 | 内容 |
| --- | --- |
| `run-topic.mjs`、`topic-result.json`、`topic-records.json` | 原始主题请求、生产回执与首轮文献列表 |
| `run-seed.mjs`、`seed-results.json` | 第一篇种子的双向扩展与重复运行 |
| `diagnose.mjs`、`diagnostic-events.ndjson`、`diagnostic-results.json` | 原异常、分页响应摘要、Crossref 拒绝字段、主题复跑和旧种子准备 |
| `verify-seed-and-controls.mjs`、`control-results.json`、`control-events.ndjson` | 旧种子的双向扩展、ID 与年份查询对照、复跑名单差异和重开查询 |
| `additional-paths.mjs`、`additional-results.json` | Semantic Scholar 正式调用、50 条预算、4 条施引文献、PUB_YEAR 对照和最终重复标识检查 |
| `s2-control.mjs`、`s2-control.json` | 保持路径和分页参数、只改变 fields 的对照 |
| `offline-tests.log` | 现有 5 个文件 / 12 个离线测试通过的日志 |
| `home/` | 隔离运行配置和实际入库 catalog；没有用户原有材料 |

临时目录可能被系统清理。本报告保存可公开的结论、请求条件和复现线索，不提交运行数据库、整批语料、凭据、Cookie 或签名 URL。未执行 Git 提交。
