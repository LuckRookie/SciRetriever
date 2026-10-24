# 统一知识加工：处理器、批量任务与结果

类型：指南
负责：算子选择、批量执行、结果查询与导出
状态：现行

从已经建档就绪的文献开始，选择算子与读取范围，提交任务，再读取结果。加工只读取校订稿，不获取 PDF、不解析、不自动建档。当前 catalog 由单一 schema 定义；旧开发数据库按明确授权离线重建，不提供逐版本迁移。

## 当前处理器

`sciretriever processors list` 或 MCP `processor_query`（`action: "list", request: {}`）返回处理器版本、输入类型、规范 schema 与方法描述。

正式 HTTP 也提供 `POST /api/v1/query/processors`（`{protocol_version:1, operation:action, request}`）和受认证保护的 `POST /api/v1/maintenance/processor-submit`（`{protocol_version:1, request:ProcessorBatchRequest, start}`），使用同一应用边界。Web 的“提取”提供标签/记录表单、持久任务、已有结果/集合、字段筛选与证据，以及选定记录综合和完整结果导出。接口认证、请求／响应上限和只读边界见[产品接口技术说明](../architecture/technical/01-product-interface.md#421-统一处理器-http-适配)。

| 算子（均为版本 `2`）  | 输入     | 行为                                                                                                 |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `summary`             | 就绪档案 | DSH 持续阅读全文、回查与查看已保存图片；purpose 为 overview/detailed/question，问题模式必填 question |
| `labels`              | 就绪档案 | 问答标注；question 和 answer_type，枚举加 choices                                                    |
| `records`             | 就绪档案 | record_meaning、fields，可选 inclusion；联合提取同一记录的字段                                       |
| `knowledge-synthesis` | 快照     | 先运行或复用 summary，再基于其记录生成带引用报告；question、policy 必填                              |

单篇只能读取 `archive-document`，多篇只能选择 `snapshot`。不能把原始解析、旧总结或另一算子的结果直接传给单篇算子。处理器是可信代码，不支持上传代码。外部提取提交协议保持独立；其输入准备要求就绪校订稿，长期保留的结果标识为 `external-extraction@2`。

`spec.reads` 可指定 `parts: main/supplementary/all` 和 `roles: all/角色数组`。上下文中看不到未声明的部分、角色和原始对照。summary 固定读取完整正文。单篇复用键包含实际读取部分的内容版本、算子版本、规范、方法和模型；修改标题、标签不会让单篇结果失效。

## 提交、运行和恢复

把下面内容保存为自己的请求文件。示例 UUID 是占位符，需要替换为库中真实 ID。

```json
{
  "schema_version": 1,
  "idempotency_key": "my-extraction-001",
  "name": "空气暴露观测",
  "processor": { "id": "records", "version": "2" },
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
    "reading": { "scope": "full" }
  },
  "inputs": [
    {
      "kind": "literature",
      "literature_id": "00000000-0000-0000-0000-000000000001"
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

输入使用 `{kind:"literature",literature_id}` 或 `{kind:"snapshot",snapshot_id}`。提交固定当时的校订内容版本；未就绪单篇记为可见缺口，不自动建档。快照创建只纳入 READY 成员，回执单列排除数量。多篇只能选一个快照；同一文献的多条记录不会成为多篇独立证据。

```bash
sciretriever snapshot create --ids <文献ID列表>
sciretriever snapshot create --filter /absolute/path/library-query.json
sciretriever snapshot show <快照ID>
sciretriever snapshot diff <旧快照ID> <新快照ID>
sciretriever processor run summary@2 --literature <文献ID>
sciretriever processor run knowledge-synthesis@2 --snapshot <快照ID> --spec /absolute/path/spec.json
sciretriever processor results --stale
sciretriever processor result <结果ID>
```

MCP 对应 `snapshot_create`、`snapshots_query`、`submit_processor` 与 `processor_query`。快照与大结果读取均分页有界，按 next_offset / next_after / continuation 续读。快照固定成员及描述，不原地更新；比较明确区分新增、移除、内容变化和描述变化。

运行记录按文献去重计“有结果”（with_result）、“结果为空”（empty）、“读取不完整”（incomplete）；同篇的正文、SI 或多条记录不重复计数，读取不完整优先。coverage.parts 的 outcome 仅 complete/incomplete，缺少已请求的 SI 等原因保留在 gaps。列表、详情同时提供 current/stale、原因及上述三种计数。版本事件在事实发布事务内标记相关结果，不触发模型。多篇结果仅在声明 uses_description 时因描述变化失效；读取旧结果不会自动重算。

提交冻结输入、规范、方法和模型配置。同一 key/同一请求返回原运行；同 key 改请求会冲突。默认文档随后变化不会改变已入队任务；模型绑定无法重建时明确失败，不悄悄换模型。新范围应使用新 key。

复用只接受输入、规范、方法、执行配置一致且完整、可读的结果。100 篇变为包含它们的 120 篇，复用 100、处理 20；120 篇中只重叠 80 篇，则复用 80、处理 40。结果集合只包含本次选定的成员，旧集合不被改写。综合绑定整个输入集合，变化后整体生成新结果。partial 可以显式另起任务，整篇重做；失败目标走原任务 retry。首版没有对完整成功结果的同身份强制重算。

任务的 `collections` 给出不可变集合 ID 和 reused/computed/failed/partial 计数。`results` 保存逐目标结果引用，失败与未完成目标在集合内保留缺口。模型调用 provenance/usage 保存在结果中；computed 是新产物目标数，不等于模型调用次数。并发争用允许多次模型调用，发布时选择已提交的完整产物。

## 提取范围和证据

字段名使用 ASCII 字母开头的字母、数字和下划线。省略类型时固定为可空字符串；可声明 `string`、`boolean`、`number`。数值值为 `{value,raw,unit}`，保留原数字串及原单位；unit 可为 null，不按规范默认单位偷换原文。schema、数值格式、证据位置和 hash 均校验，但这些不能证明科学解释、条件归属和提取完整性正确。

`raw` 支持十进制、e 记法，以及原文中的 TeX/Unicode 科学计数法（例如 `7.25 \times 10^{-3}`、`7.25 × 10⁻³`）；其数量级必须与 `value` 一致，`raw` 和 `unit` 必须能在引用文本中找到。标量字段不把区间、上下界或“±”表达式当作一个精确数值。需要保留误差、近似说明或区间时，应在规范中添加相应描述字段；不能把一个区间的端点悄悄当成测量值。方法身份包含数值规则与提示词，规则变化后新任务重新计算，已有产物保留。

`reading` 仅接受 `scope`（默认 `full`）和 `query`（默认 null）；分块大小由算子管理，不接受 `max_chunk_bytes`。`reading.scope: search` 必须给非空 query，只处理关键词命中的片段，并明确标记 partial；零命中不等于全文未报告。默认整篇一次调用；按 UTF-8 每字节 1 token 保守估算。门槛为 200K 与模型上下文扣除提示词、输出预留后的较小者，上下文缺省 1M。提示词至少预留 8192 tokens，并覆盖规范/schema 实际大小；输出默认预留并请求最多 16384 tokens，受模型能力上限约束。超限后先按一级标题、再下级标题、最后段落划分，相邻章节可合并；表格与图注/脚注、续表、图片图注及公式不拆。单整体超限记 unit-too-large 缺口。每批带文章标题与章节路径。分批失败保留已完成部分；全部批次失败记为任务失败。

首版只处理当前可读文本及 Markdown 表格文本。证据定位到文档片段，不能承诺表格单元格、图片数据或 PDF 精确坐标。SI 只有显式选中且已有可用表示时才可能参与；不会自动下载或解析。每个非空字段带来源引用，空字段附缺失理由。`empty` 只用于完整处理所选范围且没有记录；不确定、失败与无记录分别表达。

## 查询、组合与导出

CLI 统一为 `processors <action> --request <JSON 文件>`；MCP 为 `processor_query`，参数 `{action,request}`。不传文件的 `list`、`results`、`collections` 使用空请求。

| action                          | request                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `list`                          | `{}`                                                                                              |
| `results`                       | 可选 `limit`（1–200）、`after`、`literature_id`                                                   |
| `collections`                   | 可选 `run_id`、`limit`、`offset`                                                                  |
| `collection`                    | `{collection_id}`，返回精确成员、输入、规范与缺口                                                 |
| `read`                          | `{result_id}`，返回不可变内容、schema、执行身份及覆盖                                             |
| `search` / `search-collections` | `{query,limit?,offset?}`，分别检索正文/记录与集合名称/规范                                        |
| `query`                         | 下列固定查询格式；SQL 不对外开放                                                                  |
| `evidence`                      | 完整 citation（例如下列字段引用）                                                                 |
| `export`                        | `{result_id,format:"json" / "csv" / "markdown"}`                                                  |
| `transfer`                      | `{result_id,content_sha256,format:"result" / "json" / "csv" / "markdown",max_bytes,continuation}` |

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

`collection_id:null` 时使用 `result_ids`。支持 `eq/ne/gt/ge/lt/le`，字段可为顶层名称或 schema 声明的嵌套 JSON Pointer；字段拼错会返回可用字段。`eq/ne` 的 `value:null` 表示路径为空／非空测试，同时覆盖 JSON null、路径缺失及可空父对象；零、false 和空字符串仍是非空值。非空比较仍校验字段类型，未知字段仍拒绝。筛选、排序和分页由服务端执行。FTS 是词法检索，不是语义或自动翻译；不同语言或同义词需要调用方调整查询。索引陈旧时显式报错，通过 `processors rebuild` 或 MCP `rebuild_processor_index` 重建，不调用模型。

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

## 逐值文字核对

结果发布前统一核对证据，`value_checks` 以 `record_id` 与 JSON Pointer 指向值（报告对应 claim，pointer 为空）。六种状态为 found（可找到）、not-found（找不到）、value-null（值为空）、no-citation（无引用）、citation-unavailable（引用不可用）、derived（综合值）。数字按规范化数字串比较，数值的原单位也必须出现；无数字的文本必须非空且在引用片段中出现，不会因数字列表为空而自动通过。核对不证明科学解释正确，也不改写或丢弃候选值。

引用片段一律文字比对，每个 sources 项保留 basis（text-layer/image-only/manual）；结果引用保留 result_id/content_sha256/record_id/pointer，链接来源结果而不继承其核对状态。视觉核对模型、预算与缓存调用已删除。`provenance.value_check_usage` 为零，不产生额外模型调用。分块和核对规则计入方法身份，旧方法结果显示过时且不会自动重算。
