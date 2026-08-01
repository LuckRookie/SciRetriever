# ADR 0005：DocumentPackage 2.0 不兼容合同

- Status: Accepted
- Date: 2026-07-31
- Supersedes: `DocumentPackage` schema 1.x 序列化合同
- Superseded by: none
- Related: [ADR 0001](0001-sciretriever-scope-and-boundary.md)、[ADR 0002](0002-literature-identity-and-incremental-processing.md)、[设计文档](../design.md)、[技术文档](../technical.md)

## 背景

`DocumentPackage` 是供下游读取的不可变、可移植文献处理快照。旧格式没有完整冻结递归字段、数组顺序、hash 域、稳定 ID 与重放时间语义；继续接受旧字节会使两个实现对同一文献事实生成不同身份，或把不完整的旧对象误认为新合同。

Owner 在 `.omo/drafts/requirement-led-design.md` 的已解决决策中批准：有意以 schema 2.0 替换当前格式，拒绝 v1，并以本 ADR 长期记录这项不兼容选择。经批准计划的 SHA-256 为 `f5e5f5ed2d09296bd9df72a8f0cbfcafee4a91d0481dc2154d27ffe26b8b4a74`。

## 决策理由

Package 的内容 hash 同时承担快照完整性、内容身份和重放判断。只有递归 schema、规范化字节和时间选择规则同时固定，不同实现才能对同一输入得到同一 Package。保留 v1 reader 或兼容 shim 会重新引入未定义的嵌套形状与排序，并使 2.0 的 hash 身份失去唯一含义；项目当前没有需要迁移的受支持 v1 Package，因此选择一次明确的不兼容切换，而不是长期双格式解释。

## 决策

### 1. 完整递归 schema

顶层是 closed object，且字段恰好为：

```text
{schema_version:"2.0",package_id:PackageUrn,work_id:UUID,
 work_version_id:UUID,published_at:UTC-RFC3339,package_sha256:sha256,
 metadata:MetadataSnapshot,assets:[PackageAssetView],
 light_document:LightDocumentSnapshot|null,
 analysis:AnalysisSnapshot|null,references:ReferenceSnapshot,
 tags:TagSnapshot,provenance:[Provenance],lineage:[LineageEntry]}
```

递归类型固定如下；所有 object 都是 closed object，所有字段必需，nullable 值显式写为 `null`，集合显式写为 array：

- `PackageUrn = "urn:sha256:<lowercase-sha256>"`，不是 UUID。
- `Identifier = {namespace:str,value:str}`。
- `Provenance = {provenance_id:UUID,source_kind:"metadata-provider"|"asset-provider"|"parser"|"analysis-model"|"user",source_name:str,source_record_id:str|null,observed_at:UTC-RFC3339,input_sha256:sha256|null,parameters_sha256:sha256|null}`。
- `Author = {display_name:str,family_name:str|null,given_name:str|null,orcid:str|null,affiliations:[str]}`。
- `MetadataValues = {title:str,authors:[Author],abstract:str|null,publication_date:str|null,publication_year:int|null,document_type:str|null,language:str|null,venue:str|null,publisher:str|null,volume:str|null,issue:str|null,pages:str|null,article_number:str|null,open_access_status:str|null,identifiers:[Identifier]}`。
- `MetadataSnapshot = {revision:int>=1,sha256:sha256,values:MetadataValues,provenance:[Provenance]}`。
- `PackageAssetView = {asset_id:UUID,role:"primary-pdf"|"supplementary-pdf"|"xml"|"html"|"supplementary",sha256:sha256,media_type:str,byte_size:int>=0,provenance:[Provenance]}`；catalog 相对存储路径不进入 Package。
- `SourceLocator = {asset_id:UUID,page_start:int>=1,page_end:int>=page_start,block_id:str,char_start:int>=0,char_end:int>=char_start}`。
- `EvidenceText = {text:str,evidence:[SourceLocator]}`。
- `ReferenceView = {reference_id:UUID,raw_text:str,title:str|null,authors:[Author],publication_year:int|null,source:str|null,identifiers:[Identifier],resolved_work_id:UUID|null,resolved_work_version_id:UUID|null,evidence:[SourceLocator]}`。
- `Block` 恰为 paragraph `{kind:"paragraph",block_id:str,text:str,evidence:[SourceLocator]}`、list `{kind:"list",block_id:str,ordered:bool,items:[EvidenceText]}`、table `{kind:"table",block_id:str,caption:EvidenceText|null,columns:[str],rows:[[str]],evidence:[SourceLocator]}`、formula `{kind:"formula",block_id:str,text:str,label:str|null,evidence:[SourceLocator]}` 或 figure-caption `{kind:"figure-caption",block_id:str,text:str,evidence:[SourceLocator]}`。
- `Section = {section_id:str,level:int>=1,title:EvidenceText|null,blocks:[Block],children:[Section]}`。
- `LightDocument = {schema_version:"1",title:EvidenceText|null,abstract:[EvidenceText],sections:[Section],references:[ReferenceView],provenance:[Provenance]}`。
- `LightDocumentSnapshot = {artifact_id:UUID,sha256:sha256,document:LightDocument,provenance:[Provenance]}`。
- `Classification = {document_type:str|null,language:str|null,subjects:[EvidenceText]}`，`ContentOverview = {summary:EvidenceText|null,conclusions:[EvidenceText]}`，`ConclusionsAndLimitations = {conclusions:[EvidenceText],limitations:[EvidenceText]}`，`KeywordsAndTags = {keywords:[str],tags:[str]}`。
- `AnalysisProposal = {schema_version:"1",final_bibliography:MetadataValues,classification:Classification,content_overview:ContentOverview,research_objectives:[EvidenceText],methods:[EvidenceText],key_results:[EvidenceText],conclusions_and_limitations:ConclusionsAndLimitations,keywords_and_tags:KeywordsAndTags,references:[ReferenceView]}`。
- `AnalysisSnapshot = {artifact_id:UUID,sha256:sha256,provider:str,model:str,input_sha256:sha256,proposal:AnalysisProposal,provenance:[Provenance]}`。
- `ReferenceSnapshot = {complete:bool,items:[ReferenceView]}`，`TagView = {name:str,evidence:[SourceLocator]}`，`TagSnapshot = {complete:bool,items:[TagView]}`。
- `LineageItem = {id:str,sha256:sha256}`，`LineageEntry = {lineage_id:UUID,stage:str,inputs:[LineageItem],outputs:[LineageItem],parameters_sha256:sha256,completed_at:UTC-RFC3339}`。

未知字段、重复 set-like 元素、非有限数字、缺失字段、错误 union 形状和不满足上述范围的值一律拒绝；不允许由实现自行补全嵌套形状。

### 2. 规范化与数组顺序

Canonical Package JSON 是 UTF-8 文本：`ensure_ascii=true`、`allow_nan=false`、object key 按字典序排列、分隔符为 `,` 与 `:`，且没有无意义空白。

数组顺序完整固定为：

- identifiers 按 `(namespace,value)`；provenance 按 `provenance_id`；assets 按 `(role,asset_id)`；lineage 按 `(stage,lineage_id)`，其 inputs/outputs 按 `(id,sha256)`；
- affiliations、analysis keywords 与 `keywords_and_tags.tags` 按 `(casefold(text),text)`；`TagView` 按 `(casefold(name),name)`；evidence 按 `(asset_id,page_start,page_end,block_id,char_start,char_end)`；
- authors 保留书目顺序；list block items、abstract、sections、blocks、child sections、analysis 中的 EvidenceText lists 和 authoritative references 保留明确的阅读或引用顺序；table columns/rows/cells 保留来源顺序。

Package 2.0 内不存在其它 array 形状。

### 3. hash 与身份

Hash 域是完整递归验证后的顶层对象，仅省略 `package_id` 和 `package_sha256`。`package_sha256` 是该 canonical hash 域的 lowercase SHA-256 hex；`package_id` 必须恰为 `urn:sha256:<package_sha256>`。最终 canonical 对象包含这两个字段，读取时必须重算并同时验证 hash 与 URN。

### 4. 时间、重放与旧来源

发布先从一个一致来源快照计算完整 source fingerprint，并用它查找已有 preparation，再决定时间：

1. 新的一致快照只创建一次 `published_at`，值必须是 UTC RFC 3339。
2. 相同 source fingerprint 的重复发布复用原 `published_at` 和原 canonical bytes，因此 hash 与 `package_id` 不变。
3. 来源随后变化时创建新的 preparation、时间、hash 和 ID；旧 Package 仍可读取，不被新快照隐藏或改写。
4. canonical staged bytes 一旦持久化，后续来源更新或删除不使该历史快照失效；恢复必须发布已暂存的精确字节，不得从可变来源重新生成，也不得为同一 preparation 选择新时间。
5. 来源事实在一致快照完成前缺失或内部变化时，发布在形成 preparation 前失败，不得留下可被误认作 Package 的部分结果。

### 5. v1 明确不受支持

`DocumentPackage` v1 不支持读取、导入、升级或静默接受。任何 `schema_version` 不是精确字符串 `"2.0"` 的 Package 都必须在边界被拒绝；不提供 v1 reader、兼容 shim、双写或迁移路径。

## 不属于本 ADR

本 ADR 不定义模块化 CLI 或 JSON envelope、admission/文件锁、catalog bootstrap、供应商 SDK 协议，也不记录实施进度。这些主题仍由当前合同或技术文档负责，不能从本 ADR 推导。

## 后果

- Package producer 和 consumer 对完整递归 schema、canonical bytes、hash、URN、时间和重放具有同一解释。
- 2.0 是唯一受支持的 Package schema；旧字节失败是有意的边界结果，不是待补兼容缺陷。
- 变更上述任一递归形状、排序、hash 域、身份或重放规则，都需要新的 owner 决策与 ADR。
