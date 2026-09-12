# LiteratureDetail 与内容合同

2026-09-10。`Application.library.detail(literatureId)` 已组装完整文献详情，使用真实 SQLite read-only
snapshot 和正式 FileStore。此入口属于 Node Application；独立 artifact stream/export 的后续实现见
[读取与导出](literature-artifact.md)，后续[Web 文献库](workbench-library.md)与
[Browser→MinerU→Analysis 联合旅程](browser-mineru-analysis-journey.md)均已接入。

## 实现范围

- 详情包含当前 Literature/MetaLiterature、metadata revision/hash、状态与 missing step、人工 PDF 标记、
  所属不可变 MetadataObservations、主 PDF/其它资产及各自关系/provenance、当前 ParserResult、已接纳内容、
  同聚合其它版本和本地引用/被引数量。不存在的 ID 返回 `literature-not-found`。
- SQLite 一次 `BEGIN` 读取全部 catalog 事实。复用关系读取的 support 归属/方向验证，计数不使用 Provider
  声称的 citation count。引用边与 support 不无界嵌入详情。代表 Literature 必须属于当前 MetaLiterature。
- 来源按真实 observed_at 降序和 observation ID 排序；该顺序不覆盖 current metadata。其它版本按既有
  role 顺序和 LiteratureId 排序，资产按 role/关系 ID 排序。来源 version_links 和 asset_hints 完整保留。
- 新增 observation 写入支持已有 v1 的 version_links/asset_hints 表；同 observation ID 的完整事实必须一致，
  重试不追加或覆盖原来源事实。已有 owner 与新 owner 冲突时拒绝。未新增 catalog 表或字段。

## Parser 与 Content

`packages/contracts/src/content.ts` 定义 path-free ArtifactRef/ParserArtifactRef、ParserResource、
ParserProvenance、ParserResult、LiteratureSection/Subsection 和 LiteratureContent。

- ParserResult 检查 PDF source ID/hash、page count、非空 Markdown、资源唯一性和安全相对引用、Parser
  身份/provenance，并重算规范 manifest SHA-256。资源按 Unicode code point 顺序排序，不使用 locale 或
  UTF-16 字符串近似顺序。结果 hash 不纳入观察时间或 provenance ID。
- LiteratureContent 检查四个固定角色唯一且有序、固定标题限制、additional 章节标题、`未提供` 的精确用法、
  引用文本和 Analysis provenance，重算 metadata hash + ordered sections + references 的内容 hash。
- Parser/content 使用既有 Python 对规范 domain value 的 JSON 序列化规则；章节 Markdown 保留 Unicode
  原字节含义，不再次做 NFC 改写。未知字段、缺字段、非法类型和不匹配 hash 均拒绝。
- 详情只在 snapshot 后读取该 snapshot 绑定的不可变 structured JSON。FileStore 校验路径、no-follow、
  普通文件和读取期间文件身份；Literature 再校验实际字节数/SHA-256、canonical JSON 字节、metadata
  revision/hash、主 PDF ID/hash、生成时 parser hash 对应的 Analysis input hash、provenance、references
  投影和规范 Markdown descriptor。重新解析不能把已接纳内容的生成谱系改成最新 parser hash。
- PDF、Parser Markdown/资源及规范内容 Markdown 的完整字节不进入详情。结构化 JSON 读取当前有 16 MiB
  单次内存上限，超限明确拒绝；大产物流式读取仍是独立后续工作。当前详情不会宣称已经验证独立文件导出流程。

## 直接证据

`apps/server/test/literature-detail.test.ts` 从真实 Application/SQLite/FileStore 构造合成文献、版本、来源、
PDF、Parser Markdown/资源和 canonical content JSON，验证：

- 空详情、not-found、来源排序、当前元数据不被 observation 展示顺序覆盖；
- version links/asset hints 完整读写、同 observation 幂等和不可变事实冲突拒绝；
- 主资产/附属资产、正反向本地引用数量与来源声称数量分离；
- 正式文件与完整内容详情、失败替换保留既有内容；
- 非法 Parser source/manifest/path/重复资源，以及缺失/重复/非法标题章节、无效缺失标记、错误 provenance
  和内容 hash 的拒绝；
- 在读取不可变 artifact 期间并发增加来源 observation，当前响应保留原完整 snapshot，下一次请求看到新来源；
- structured artifact 同长度异字节及文件缺失时 fail closed。

TS 调用现有 Python 的 ParserResult、LiteratureContent、LiteratureDetail 合同读取实际 TS 输出；Parser
manifest hash 一致，完整 content canonical JSON 字节一致。fixture 包含分解 Unicode 文本和 BMP/非 BMP
资源引用，避免只测 ASCII 掩盖排序或规范化差异。这不是 Python 测试 runner。

本次 TS Full 通过：62 文件、208 测试，含目标 Cloak 的 loopback 工作台旅程；日志
`/tmp/sciretriever-detail-full.log`。未运行 Python Quick/Full/unittest，未新增依赖或变更 v1 schema。

## 后续闭环与边界

后续[内容接纳 owner](content-acceptance.md)、[实际 Parser/Analysis](browser-mineru-analysis-journey.md)和
[Web 文献库](workbench-library.md)已经接入同一 Detail/FTS 合同；[身份索引容量](literature-identity-index.md)覆盖
超过 10,000 篇的查询。更大正文和高关系扇出的压力基准不属于首阶段支持声明，真实外部效果仍需单独授权。
