# Literature 状态与搜索入口

2026-09-10。Application 已组装 `library.search()`，使用当前文献事实和 SQLite FTS5。该入口是 Node
Application API；后续[完整详情](literature-detail.md)、[Web 查询](workbench-library.md)与
[Browser→MinerU→Analysis relevance query](browser-mineru-analysis-journey.md)均复用本合同。

## 当前行为

- contracts 增加 LibrarySearchRequest、LiteratureSearchItem、LibrarySearchPage。请求缺省排序为
  publication-year-desc、limit=50、cursor=null；空 query 使用既有默认条件。未知字段、非法排序、越界年份
  和无 text 的 relevance 在数据库访问前拒绝。LibraryQuery 不加入分页或排序字段。
- `LiteratureQueryService` 拥有 contains、一般多值 OR、keywords AND、排序、查询 fingerprint 和 cursor
  规则。请求先规范化，再由 Storage 取得同一只读 snapshot 中的文献、元数据 revision/hash、state/missing step、
  人工 PDF 标记、discovery cause ID 和实际 FTS5 bm25 分数。筛选与分页只消费该快照，后续请求重新读取 current facts。
- 普通 text 转换为 Unicode 字母/数字/结合符 token，去除 AND/OR/NOT/NEAR 运算词并生成引用后的 AND 查询。
  纯标点或只有运算词时无匹配；不把输入当作 SQL/FTS 表达式。
- NFC、空白合并和 Unicode casefold 规则使用随源码携带的 Unicode 15.0 full case-fold 表（1530 项），
  从开发基线 Python 的 Unicode 数据生成。运行时不调用 Python，不新增依赖；不使用大小写近似或 locale 排序。
- 元数据写入和 observation 接纳都在原事务内刷新 FTS 当前 metadata 部分：作者包含明确姓名组成/ORCID，
  单位包含名称/ROR，identifier 包含 namespace/value。来源 observation、参考原文、URL、路径和 provenance
  不加入索引；不把元数据重复放入 content_body 改变 bm25。原有 content_body 保留给内容 owner 更新。
- 五种排序支持缺失值后置和 LiteratureId tie-break。不透明 cursor 绑定匹配条件与排序，不绑定 limit；
  relevance 使用真实 FTS5 分数。采用 Python query cursor 的 canonical JSON，包括 bm25 浮点格式，避免
  `1e-6` 与 `1e-06` 等表示差异导致旧 cursor 无法读取。
- `discovery_run_ids` 只匹配 cause 指向的具体 Literature，不扩展到同一 MetaLiterature 的其它版本。
  同一 snapshot 先验证指定运行的每个结果有有效 cause，topic observation 归属与版本一致，citation 两端存在、
  actual 属于其中一端且版本一致。缺失 cause 或损坏归属明确拒绝，不伪造空结果；未请求的运行不影响普通搜索。
- 人工 PDF 的 false 条件按既有 matcher 表示“不存在耗尽事实”。如果损坏/历史 catalog 同时保留主 PDF 与
  耗尽标记，不能用列表的 false 投影把它当成无标记。正式 Candidate 发布现在在同一 receipt 事务中清除该标记。
  text 命中重复 FTS Literature 行时拒绝返回重复结果或失真的 relevance。

## 引用分页与关系详情

`Application.library.references({literature_id,direction,limit?,cursor?})` 和
`Application.library.referenceDetail(referenceId)` 已组装。闭合请求在访问 catalog 前检查；不存在的端点、
不存在或没有 support 的关系返回 `literature-not-found`。空的有效端点返回空页。

- references/cited-by 共用同一 Reference，related_literature 为另一端的 SearchItem；普通列表只含
  support_count。固定按发表年份降序/缺失后置、规范化标题升序/缺失后置、LiteratureId 排序。
- cursor 绑定 LiteratureId、方向和稳定位置，不绑定 limit。沿用 Python `literature-references` v1
  canonical JSON 与 checksum；拒绝改方向、改端点、非规范编码、超长 cursor 和未知字段。
- SQLite 一次只读事务读取所选关系、两端 current facts 和 support。校验 provider 方向、metadata 原文的
  owner/index、当前 content hash 的 owner/index。无 support 边不计数；损坏 support 明确失败。
- ReferenceDetail 的 source/target 不交换，supports 只返回已有 `{reference_id,source}` locator，按类型、
  observation/hash、index 排序，不复制原文、provenance 或 Provider citation count。投影及嵌套 locator 不可变。

## 状态与谱系

Literature 的 `deriveCurrentState` 是纯函数，SQLite worker 调用同一函数。无主 PDF 为 UNREVIEWED，主 PDF
存在为 ASSET_READY；内容只有在 metadata revision/hash、当前主 PDF ID/hash、Analysis provenance 与原生成
输入 hash 全部一致时才能成为 CONTENT_READY。重新解析产生不同的当前 ParserResult 不撤销已接纳内容；
内容谱系使用生成时 parser hash，不能错误地追随当前 parser。下一缺失步骤先检查主 PDF，再检查对齐 parser，
最后检查内容。搜索与 currentFacts 使用相同规则。

`literature-state.test.ts` 直接验证 truth table，并在真实 SQLite 中验证主 PDF→parser→已接纳 content 的
投影、失败替换保留和重新解析后的状态。这里使用合成持久化事实测试读取规则，不代表真实 Analysis 服务已经接入。

## 验证与限制

`literature-query.test.ts` 验证 Unicode contains/FTS、关键词 AND、年份/标题缺失值、稳定分页、cursor
跨条件/排序拒绝、普通 FTS 输入去语法化、默认值与非法请求。五种排序生成的 cursor 均由 TS 驱动既有 Python
纯 query 模块解码并重新编码，fingerprint 和 cursor 字节一致。还验证 observation 未接纳前不被搜索，接纳后
新 metadata 入索引、旧 metadata 退出，来源参考文本始终不被搜索。

`literature-reference-query.test.ts` 通过真实 Application/SQLite 验证四条受支持关系、无 support 边排除、
年份/标题缺失排序、双向页面、不同 limit 的续页、support 去重和稳定 locator、not-found 与损坏归属拒绝。
两种页面位置（含缺失标题）的 cursor 经 TS 调用 Python 纯 query 模块往返后字节相同。
`literature-state.test.ts` 还通过真实 SQLite 验证 content support 的当前 hash/index 投影：失败替换与重新解析
均保留原已接纳内容的 ReferenceDetail 和 locator。

`literature-query-integrity.test.ts` 在同一合成 catalog 上，由 TS 调用既有 Python matcher 对比 24 组过滤条件，
覆盖作者姓名/ORCID、identifier、年份、venue/publisher、语言、文献类型、keywords、version、状态、missing step、
人工 PDF 和 topic/citation discovery；再验证 PDF 加入后的四组条件及缺失/损坏 cause。Python 仅消费临时
catalog，不运行 Python 测试入口。`candidate-acceptance.test.ts` 验证真实 PDF 接纳后耗尽事实在发布事务中清除。

当前性能路径会在 snapshot 中物化 text 命中范围（无 text 时为全部 Literature），再应用其它条件和分页。
一次本地容量测量使用 5,000 个合成 Literature，独立 MetaLiterature/DOI，10% 缺失标题、每 11 篇有一篇缺失年份，
均无 PDF/content，交替 even/odd 关键词；所有首屏 limit=50。实际编译后的 Application/SQLite 写入约 16.6 s，
普通列表命中 5,000 篇耗时 966 ms，稀疏全文命中 50 篇耗时 19 ms，普通全文命中 4,450 篇耗时 1,050 ms，
关键词命中 2,500 篇耗时 1,071 ms。脚本和日志分别在 `/tmp/sciretriever-query-capacity.mjs`、
`/tmp/sciretriever-query-capacity.log`；临时 catalog 已清理。这是本机单次元数据容量观察，不是性能 SLA，
也不代表多用户、深分页、完整内容和大量引用的容量验收。大候选范围仍需优化。

后续[内容接纳](content-acceptance.md)已在同一事务维护正文索引，[Web 文献库](workbench-library.md)已接入查询、
详情、关系和文件入口。本文的早期搜索切片单独不代表完整 Parsing/Analysis 旅程；完整证据由联合旅程承担。

上一状态/搜索切片 TS Full：59 文件、205 测试通过，日志 `/tmp/sciretriever-literature-query-full.log`。
本次关系/完整性补齐后 TS Full：61 文件、207 测试通过，含目标 Cloak loopback 旅程，日志
`/tmp/sciretriever-query-integrity-full.log`。补充 content support 失败保留测试后再次通过同数量 Full，最终日志
`/tmp/sciretriever-reference-final-full.log`。未运行 Python Quick/Full/unittest，未增加依赖或变更 v1 schema。
