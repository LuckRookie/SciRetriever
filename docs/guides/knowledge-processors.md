# 统一知识加工：处理器、批量任务与结果

从已经存在的可读文档或已保存结果开始，选择一个处理器和规范，提交任务，再读取结果集合。加工不会获取 PDF、解析、修复原文或发现新文献。新功能要求 Catalog v10；已有库必须经[显式升级](upgrade.md)，普通启动不升级。

## 当前处理器

`sciretriever processors list` 或 MCP `processor_query`（`action: "list", request: {}`）返回处理器版本、输入类型、规范 schema 与方法描述。

正式 HTTP 也提供 `POST /api/v1/query/processors`（`{protocol_version:1, operation:action, request}`）和受认证保护的 `POST /api/v1/maintenance/processor-submit`（`{protocol_version:1, request:ProcessorBatchRequest, start}`），使用同一应用边界。Web 的“提取”提供标签/记录表单、持久任务、已有结果/集合、字段筛选与证据，以及选定记录综合和完整结果导出。接口认证、请求／响应上限和只读边界见[产品接口技术说明](../architecture/technical/01-product-interface.md#421-统一处理器-http-适配2026-10-18)。

| id（version 均为 `1`）                      | 范围     | 规范与行为                                                                              |
| ------------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `knowledge-overview` / `knowledge-detailed` | 单文档   | `spec: {}`；沿用现有知识分析产物和证据                                                  |
| `knowledge-question`                        | 单文档   | `question` 必填                                                                         |
| `knowledge-long`                            | 单文档   | `purpose` 为 overview/detailed/question；question 用途须填写问题                        |
| `knowledge-synthesis`                       | 整个集合 | `question`、`policy: require-all / allow-partial`；接受文档、结果或旧知识引用           |
| `labels`                                    | 单文档   | `question`、`answer_type: boolean / string / enum`；枚举加 `choices`；证据不足返回 null |
| `records`                                   | 单文档   | `record_meaning`、`fields`，可选 `inclusion`；同一记录的字段联合提取                    |

处理器是可信仓库代码。新增方法通过注册接入，不支持执行用户上传的代码，也没有通用 DAG 编辑器。原来的分析、综合和提取交付入口继续有效。

## 提交、运行和恢复

把下面内容保存为自己的请求文件。示例 UUID 是占位符，需要替换为库中真实 ID。

```json
{
  "schema_version": 1,
  "idempotency_key": "my-extraction-001",
  "name": "空气暴露观测",
  "processor": { "id": "records", "version": "1" },
  "spec": {
    "record_meaning": "一组条件下的一条原文观测，不合并重复测量",
    "fields": [
      { "name": "material", "description": "材料原名" },
      {
        "name": "temperature",
        "description": "测试温度",
        "type": "number",
        "unit": "C"
      },
      { "name": "humidity", "description": "空气相对湿度原串" }
    ],
    "reading": { "scope": "full", "max_chunk_bytes": 12000 }
  },
  "inputs": [
    {
      "kind": "document",
      "document_version_id": "00000000-0000-0000-0000-000000000001"
    }
  ]
}
```

```bash
sciretriever processors submit --request /absolute/path/request.json --json
sciretriever jobs run <返回的 job_id> --json
sciretriever jobs show <job_id> --json
# 或提交后在本进程等待完成
sciretriever processors run --request /absolute/path/request.json --json
```

MCP 写工具需以 maintenance 模式启动。`submit_processor` 接收 `{request: 上述对象}`，提交后启动后台任务；用 `read_task` 查看，`control_task` 暂停、恢复、取消或显式重试失败目标。CLI 用已有 `jobs pause/cancel/resume/retry`。运行依赖所属进程持续存活；重启后显式运行同一 job 即可恢复。

输入还可写为 `{kind:"literature",literature_id}`，提交时解析为当时的主 PDF 默认文档；没有材料的成员保留为缺口。后续任务可使用 `{kind:"result",result_id,record_ids:null}`（整份结果）或指定记录 ID 子集，也可使用 `{kind:"knowledge",artifact_id}`。文献 ID、文档 ID、结果 ID 是不同种类的引用。

提交冻结输入、规范、方法和模型配置。同一 key/同一请求返回原运行；同 key 改请求会冲突。默认文档随后变化不会改变已入队任务；模型绑定无法重建时明确失败，不悄悄换模型。新范围应使用新 key。

复用只接受输入、规范、方法、执行配置一致且完整、可读的结果。100 篇变为包含它们的 120 篇，复用 100、处理 20；120 篇中只重叠 80 篇，则复用 80、处理 40。结果集合只包含本次选定的成员，旧集合不被改写。综合绑定整个输入集合，变化后整体生成新结果。partial 可以显式另起任务，整篇重做；失败目标走原任务 retry。首版没有对完整成功结果的同身份强制重算。

任务的 `collections` 给出不可变集合 ID 和 reused/computed/failed/partial 计数。`results` 保存逐目标结果引用，失败与未完成目标在集合内保留缺口。模型调用 provenance/usage 保存在结果中；computed 是新产物目标数，不等于模型调用次数。并发争用允许多次模型调用，发布时选择已提交的完整产物。

## 提取范围和证据

字段名使用 ASCII 字母开头的字母、数字和下划线。省略类型时固定为可空字符串；可声明 `string`、`boolean`、`number`。数值值为 `{value,raw,unit}`，保留原数字串及原单位；unit 可为 null，不按规范默认单位偷换原文。schema、数值格式、证据位置和 hash 均校验，但这些不能证明科学解释、条件归属和提取完整性正确。

`raw` 支持十进制、e 记法，以及原文中的 TeX/Unicode 科学计数法（例如 `7.25 \times 10^{-3}`、`7.25 × 10⁻³`）；其数量级必须与 `value` 一致，`raw` 和 `unit` 必须能在引用文本中找到。标量字段不把区间、上下界或“±”表达式当作一个精确数值。需要保留误差、近似说明或区间时，应在规范中添加相应描述字段；不能把一个区间的端点悄悄当成测量值。方法身份包含数值规则与提示词，规则变化后新任务重新计算，已有产物保留。

`labels` 和 `records` 按完整片段分批调用模型。`reading.scope: search` 必须给 query，只处理关键词命中的片段，并明确标记 partial；零命中不等于全文未报告。超过 `max_chunk_bytes` 的单片段不截断为完整结果，而是报告缺口。分批失败保留已完成部分；全部批次失败记为任务失败。

首版只处理当前可读文本及 Markdown 表格文本。证据定位到文档片段，不能承诺表格单元格、图片数据或 PDF 精确坐标。SI 只有显式选中且已有可用表示时才可能参与；不会自动下载或解析。每个非空字段带来源引用，空字段附缺失理由。`empty` 只用于完整处理所选范围且没有记录；不确定、失败与无记录分别表达。

## 查询、组合与导出

CLI 统一为 `processors <action> --request <JSON 文件>`；MCP 为 `processor_query`，参数 `{action,request}`。不传文件的 `list`、`results`、`collections` 使用空请求。

| action                          | request                                                    |
| ------------------------------- | ---------------------------------------------------------- |
| `list`                          | `{}`                                                       |
| `results`                       | 可选 `limit`（1–200）、`after`、`literature_id`                             |
| `collections`                   | 可选 `run_id`、`limit`、`offset`                           |
| `collection`                    | `{collection_id}`，返回精确成员、输入、规范与缺口          |
| `read`                          | `{result_id}`，返回不可变内容、schema、执行身份及覆盖      |
| `search` / `search-collections` | `{query,limit?,offset?}`，分别检索正文/记录与集合名称/规范 |
| `query`                         | 下列固定查询格式；SQL 不对外开放                           |
| `evidence`                      | 完整 citation（例如下列字段引用）                          |
| `export`                        | `{result_id,format:"json" / "csv" / "markdown"}`           |
| `transfer` | `{result_id,content_sha256,format:"result" / "json" / "csv" / "markdown",max_bytes,continuation}` |

```json
{
  "collection_id": "00000000-0000-0000-0000-000000000002",
  "result_ids": [],
  "filters": [{ "field": "/temperature/value", "operator": "ge", "value": 20 }],
  "sort": { "field": "/temperature/value", "direction": "asc" },
  "limit": 50,
  "offset": 0
}
```

`collection_id:null` 时使用 `result_ids`。支持 `eq/ne/gt/ge/lt/le`，字段可为顶层名称或 schema 声明的嵌套 JSON Pointer；字段拼错会返回可用字段。筛选、排序和分页由服务端执行。FTS 是词法检索，不是语义或自动翻译；不同语言或同义词需要调用方调整查询。索引陈旧时显式报错，通过 `processors rebuild` 或 MCP `rebuild_processor_index` 重建，不调用模型。

```json
{
  "kind": "result",
  "result_id": "00000000-0000-0000-0000-000000000003",
  "content_sha256": "替换为结果返回的64位hash",
  "record_id": "r0",
  "pointer": "/temperature/value"
}
```

综合中的记录引用可以逐层展开到原文。输入同一篇论文的多条记录/多份结果，不会变成多个独立文献来源。结果的 `literature_ids` 表示引用所涉及的文献，完整输入范围在 invocation/coverage 中另行保存。

导出返回内容及媒体类型，CSV/Markdown 同时返回追溯元数据；JSON 保留整个不可变结果。CSV 用 payload_json/evidence_json 列保持嵌套数据，适合程序再次展开，不把复杂记录默默压平。调用方保存整个返回对象或保留配套 metadata。

外部提取交付仍只产生原来的回执。要长期托管，显式使用 `processors retain --request <完整 ExtractionSubmission>` 或 MCP `retain_extraction`。平台经原交付校验后保存候选、关系、规范、manifest 与来源，登记独立保护关系；回执过期不会解除长期结果的证据保护。记录包装在 `record` 字段，原候选完整保存在 provenance；历史回执本身没有正文，不能凭回执重建候选。

`results.literature_id` 通过已有的固定材料、文档、知识及上游结果输入查找关联产物，不推断标签含义，也不以缺少字段证据排除“无法判断”结果。结果仍按 result_id 排序，用 next_after 续读；它是只读投影，不新增 catalog schema。Web 阅读辅助区、CLI 和 MCP 共用此参数。

单份结果文件最多 8 MiB，MCP 单次响应仍受 4 MiB 预算约束；查找局部内容优先用记录分页与字段证据。完整大结果和导出使用三端共有的 `transfer`：固定 result_id/hash，首次 continuation:null、max_bytes:262144，逐次把 next 传为 continuation，直到 next:null。按 start/end 拼接 text，校验 total_bytes 与 transfer_sha256 后解析 JSON。format:result 返回完整 read 对象；json/csv/markdown 返回完整 export 封套，CSV/Markdown 的 metadata 必须一起保存。每块是有效 UTF-8，不会把截断当成完整结果。

当前离线测试证明执行、保存、复用、恢复和证据链机制；真实语料的抽取准确率、漏抽率和领域适用性仍须单独评估。

[指南索引](README.md) · [技术合同](../architecture/technical/05-knowledge-processing.md) · [ADR 0034](../architecture/decisions/0034-unified-processors-and-results.md)
