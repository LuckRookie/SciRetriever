# 05 · 知识加工技术设计

类型：规格
负责：建档、校订稿与算子输入（加工与结果合同）
状态：现行

[设计总览](../design.md) · [八模块技术导航](../technical.md)

本模块对应设计中的 **⑤ 知识加工**，使用已有材料与证据，形成压缩知识或交付调用方规范下的提取候选。

内部划分为 Analysis 分析/综合和 Extraction 提取交付。Analysis 拥有局部分析、整合和知识产物验收；Extraction 校验调用方规范、候选结构、证据与提交，领域算法和科学接纳归下游。两者独立使用④的读取能力，缺材料时不调用③补库。

Agents 统一由 DSH 提供模型与持续会话能力。summary 是普通单篇算子，读取校订稿与已保存图片；多篇算子使用冻结快照和逐篇 map/reduce。两阶段内容服务及旧 KnowledgeArtifact 生产接口已退役。

> 第 1–7 节写当前实现，依据 [ADR 0037 第二版](../decisions/0037-literature-archive-and-proofread-text.md)；下述源码能力已接入，真实库切换和全库模型重建需独立授权。第 8 节是 [ADR 0044](../decisions/0044-knowledge-processing-platform.md) 与 [ADR 0060](../decisions/0060-two-level-full-text.md) 第 4 节的规格，尚未实现；它取代第 2、6、7 节中的哪些条款，见第 8 节开头的表。

本篇目录：

- [1. 模块边界与连接](#1-模块边界与连接)
- [2. 分析与综合](#2-分析与综合)
- [3. 结果格式与发布](#3-结果格式与发布)
- [4. 调用方规范与提取交付](#4-调用方规范与提取交付)
- [5. 共享支撑：单次模型与受控执行基础](#5-共享支撑单次模型与受控执行基础)
- [6. 统一处理器与结果](#6-统一处理器与结果)
- [7. 标签与算子输入](#7-标签与算子输入)
- [8. 知识加工平台与研究任务（尚未实现）](#8-知识加工平台与研究任务尚未实现)

## 1. 模块边界与连接

任务②明确启动分析或接收候选；读取文档证据④；产物经存储⑦保存或按提取合同直接交付。

本篇按职责归并已有详细合同；示例中的现有类型与目标类型保持各自状态。文档归属不改变源码目录、事实所有权或当前公开 API。

## 2. 分析与综合

### 2.1 有证据的知识压缩

当前实现中，算子只读 READY 文献的校订稿，按部分和章节角色声明范围（按材料准入、可读初稿的目标见 8.4、8.10）。元数据与标签属描述版本；正文和结构属内容版本。单篇复用键包括读取部分的内容版本、算子/规范/方法/模型身份，不包括描述版本。结果为不可变 ProcessorResult，不更新原文或元数据。

### 2.2 实现结构与公开边界

`analysis/processor*.ts` 与 `analysis/snapshots.ts` 管理算子定义、输入、执行与快照；`application/jobs/processors.ts` 负责持久任务，`storage/processor-results.ts` 负责结果发布与查询；`knowledge-session.ts` 连接 summary 的持续 DSH 阅读。`agents/dsh/` 统一执行、工具反馈和用量；`entry/processor-operations.ts` 提供 CLI/MCP/HTTP 的查询边界。模型没有 SQL、任意文件或业务写入权。

### 2.3 单篇总结

summary@2 手动发起，完整读取冻结校订文本，检查所有资源可用性，按需读取图片、检索和回查片段；`submit_result` 校验 schema、覆盖和引用。本次固定正文中不存在的片段 ID 保留为无法解析的引用声明，保留全部结论，不因该缺口拒绝整次提交并要求重写；对应引用及条目的核对状态为 `citation-unavailable`。声明保留固定文档版本、representation hash 和原片段 ID，`content_sha256:null`，不编造片段 hash 或页面定位。该例外仅用于内部 summary 的单个可用正文、全章节输入；接纳、发布与回读均验证文档完整性、输入绑定及片段确实不存在。存在的片段缺 hash、跨输入文档或版本、hash/绑定篡改、非法结构仍整份拒绝，不改变外部候选与通用 EvidenceRef 读取规则。结果读取、导出及综合继续保留原声明与条目，既有结果字节不改写。其它校验错误反馈到同一会话。超长文本按 UTF-8 续读，不截去尾部或否定条件。坏图片、取消、无效用量明确失败；预算或缺口如实记录，不冒充完整结果。

### 2.4 多篇综合

当前实现中，快照冻结 READY 成员及内容/描述版本，记录被排除的未就绪成员（收入全部选中成员的目标见 8.10）。map 算子逐篇读取，reduce 只基于已生成的单篇结果汇总；每项引用保留源文献与原始片段。版本事件只标过时，不自动重算。extracted、not-reported、part-absent、incomplete 分开表达；补充材料失败为 part-unavailable，不阻断正文。

## 3. 结果格式与发布

结果由平台验收后发布不可变文件并登记固定输入依赖，随后建立可重建查询投影。并发复用返回真实赢家的字节和来源；取消不撤销已提交结果。索引失败与结果生成失败分开报告，重试可复用已提交结果修复索引。

单份完整结果的确定性 JSON 编码限 8 MiB、深度 32、单数组 10,000 项；逐值核对字段计入同一字节预算。完整结果不套用外部 Extraction 的 20,480 节点上限，Extraction 自身限制保持不变。HTTP/CLI/MCP 仍使用各自有界响应与续读，不因文件上限增加单次响应体。

每个提取值由平台按引用的校订文本核对，标为 found/not-found/value-null/no-citation/citation-unavailable/derived。所有来源统一文字比对，来源 basis 单独呈现，不证明科学结论正确；找不到的候选值照常交付，缺失不能写成否定。内容、条件、数字原串及单位不由确定性后处理重写。Web 默认展示阅读栏目和短证据编号，技术 ID/hash 收进详情。

旧两阶段元数据加总结、LiteratureContent、旧知识 artifact 与依赖它们的综合不保留生产兼容接口。外部提取的 schema/领域含义仍由调用方拥有。

## 4. 调用方规范与提取交付

### 4.1 模块边界与子能力

| 子能力   | 本模块负责                             | 其它 owner                               |
| -------- | -------------------------------------- | ---------------------------------------- |
| 规范接纳 | 结构、方言、大小、版本/hash、能力要求  | 调用方解释字段与记录含义                 |
| 输入绑定 | 校验 manifest 与允许材料、反馈缺口     | Entry 固定范围，材料/文档 owner 验证引用 |
| 能力组合 | 暴露材料、片段、局部搜索和证据读取入口 | Document/Evidence、Q 执行读取            |
| 候选校验 | schema、输入、字段/关系证据与覆盖      | 调用方判断科学正确性                     |
| 批次交付 | 原子接纳/拒绝、回执、重复提交结果      | 下游拥有最终数据集                       |

提取策略可以是普通程序、科研 Agent、规则系统或领域模型。外部策略不需要在 SciRetriever 进程内运行，也不必配置内部 Analysis 模型。将来若提供默认模型策略，它也调用相同读取/交付合同，不能绕过检查获得特权。

Analysis 提供解释、压缩和综合；Extraction 提供 schema 约束候选。提取不等待总结，平台也不能用总结里没出现某字段推断原文未报告。

### 4.2 ExtractionSpec

#### 4.2.1 规范结构

```ts
interface ExtractionSpec {
  readonly schema_version: 1;
  readonly spec_id: string;
  readonly spec_version: string;
  readonly spec_sha256: Sha256;
  readonly record_meaning: string;
  readonly output_schema: JsonSchema;
  readonly field_instructions: readonly FieldInstruction[];
  readonly evidence_policy: EvidencePolicy;
  readonly inclusion_rules: readonly string[];
  readonly missing_value_rules: readonly string[];
  readonly required_capabilities: readonly string[];
}
```

`record_meaning` 描述一条候选代表什么，平台不将它解析成固定 Sample/Experiment 表。`field_instructions` 说明字段、单位、条件、枚举含义与允许缺失；字段结构由 output_schema 决定。领域规则作为调用方方法说明，平台不能宣称通用 schema validator 已执行全部自然语言规则。

规范版本与 hash 分开：调用方的版本标签供识别，平台计算规范化内容 hash 防止同标签不同定义被误复用。hash 的比较域包括 schema、说明、证据/缺失/纳入规则与能力要求，不包含接收时间、机器路径或提交者临时连接。

规范一旦用于批次就不可原地改义；修订产生新的版本/hash。重新校验旧候选也要说明使用的是旧规范还是新规范，不能后台改变旧回执的含义。

#### 4.2.2 JSON Schema 与资源边界

首版采用 Draft 2020-12 的封闭子集；支持词汇表、本地 `$ref`、组合/递归和资源限制详见 [4.11](#411-首版规范输入绑定与提交语义)。禁止远程 `$ref`，schema 校验不能隐式联网。未知关键字不能无声忽略后宣称“全部约束已验证”。

边界需要限制规范字节、深度、数组/记录数量、字符串长度、正则复杂性、引用递归与错误列表大小，精确值由统一合同给出。schema 编译和候选校验都有取消/时间边界，不能运行任意用户代码或安装插件。

候选 JSON 禁止重复键、非有限数值和含糊的数值转换。平台不自动把空字符串补成零、不悄悄转换单位、不补 schema default 使缺失记录通过。需要保留原文数值精度时，由调用方 schema 明确采用字符串或其它表达。

### 4.3 输入清单与材料能力

复用统一 `InputManifest`，不另建含义相同的 MaterialManifest。清单固定有序 Literature/Material/Document 版本与 hash、范围摘要及不可用项；它不是新的 Collection，也不授予外部发现或下载权限。

调用方可以只固定原始 MaterialRef 并用自己的工具处理 PDF，也可以读取已有 DocumentRef 的目录、文本、表格上下文与资源。原材料证据不要求先有 ParserResult；文档证据要求精确表示版本。缺少结构化表格时返回能力缺口，而不是悄悄替外部策略运行一个模型。

明确的解析操作可以准备已有材料；读取 manifest、切片或证据本身不触发解析。若 PDF 缺失，返回缺口，用户另行发起 acquire/ingest 后重新建立输入。

外部策略可以使用 Q 在清单内定位，再展开原文。搜索的零命中和截断不能视为整篇已处理；最终覆盖由提取器声明，并与平台可核实的输入/读取事实分别表达。

### 4.4 CandidateBatch 与字段证据

#### 4.4.1 候选结构

```ts
interface ExtractionSubmission {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly batch_id: string;
  readonly submission_key: string;
  readonly records: readonly CandidateRecord[];
  readonly relations: readonly RelationEvidence[];
  readonly coverage: readonly InputCoverage[];
  readonly producer: ProducerDeclaration;
}
interface CandidateRecord {
  readonly record_id: string;
  readonly payload: JsonValue;
  readonly field_evidence: readonly FieldEvidence[];
}
interface FieldEvidence {
  readonly pointer: string;
  readonly sources: readonly { input_id: string; evidence: EvidenceRef }[];
}
```

record_id 用于这次交付内引用，不是跨论文的样品/实验身份。业务唯一键由调用方 schema 定义；平台不按 LiteratureId、数值相同或标题相似合并候选。一篇文献可以有零条、多条和嵌套记录，一条候选也可以使用多个输入。

payload 是符合 output_schema 的领域数据；外层 envelope 拥有输入、证据、覆盖与方法来源。这允许领域中立平台交付不同形状的记录，同时保留可验证边界。

#### 4.4.2 JSON Pointer 和关系证据

FieldEvidence 的 pointer 按 RFC 6901 指向该记录 payload，包含正确的 `~0/~1` 转义；数组必须定位具体索引。候选内容变更后，证据绑定也随批次内容 hash 改变，不能沿用旧数组位置。

例如 `/measurements/0/value` 绑定数值所在表格单元，`/measurements/0/temperature` 绑定条件说明。两者分别可解析不代表它们属于同一次实验，因此 RelationEvidence 还需表达所关联的字段/记录、关系类型和证据。关系科学含义仍由规范和下游判断。

EvidenceRef 必须落在 manifest 允许的输入闭包内，版本/hash 与定位均可复核。文件级引用不能满足明确要求字段位置的规范。不存在的 pointer、越界输入、unsupported locator 和内容 hash 不符都不能当作空证据接受。

### 4.5 校验流水线与接纳结果

一次有界批次按以下顺序处理：

1. 同步复制并封闭解析完整 envelope，计算包含固定 operation scope 的提交 hash。
2. 先查询有效历史 key/hash；相同内容返回同一回执，异内容冲突，不对历史提交重新验证当前证据。
3. 对新提交验证固定规范与 manifest、全部输入字节、payload schema、JSON Pointer、字段/关系证据、coverage 与生产者声明。批次 payload 在单个有界 Worker 中一次编译后逐条校验。
4. 在同一 Catalog 写入准入和 SQLite 短事务中再次查询历史 key、时间/状态/容量与精确输入，原子插入 receipt 和整个 manifest 中实际存在的原件/文档 pin。COMMIT 是接纳点；已发出的事务即使 HTTP 断连也须结算结果。

首版每批全收或全拒。部分记录有错就拒绝本批并返回稳定 code；调用方修正后用新提交身份再次提交。跨批次不回滚此前成功批次，不能用大任务最后一批失败撤销前面的有效交付。

成功当次返回封闭 `ExtractionAcceptedResult {schema_version:1,receipt,accepted_batch}`：`accepted_batch` 是已同步复制的本次完整 records/payload、字段/关系证据、coverage 与 producer 声明；`receipt` 只含固定 hash、接纳/保护期限、平台检查计数和全部实际 pin。独立 `receipt()` 读取只返回同形 `ExtractionReceiptResult`，不恢复声明或历史 payload。平台检查不出现未经执行的 `scientifically_valid: true`。交付成功不是训练数据集验收，也不代表模型或外部程序的方法声明已被平台证实。

### 4.6 覆盖、零记录与失败

| 状态语义                 | 能说明什么               | 不能说明什么           |
| ------------------------ | ------------------------ | ---------------------- |
| processed-with-records   | 声明范围已处理并产出候选 | 所有领域事实都已抽取   |
| processed-no-records     | 按规范处理后零候选       | 所有论文都未报告该内容 |
| not-processed            | 未处理的输入             | 原文不存在信息         |
| unreadable / unsupported | 材料或能力阻碍           | 科学上的不适用         |
| failed / cancelled       | 工作未完整结束           | 删除输入或此前批次     |

这些是首版逐输入的精确状态。`records: []` 可以合法，但每个输入仍须声明覆盖；`unreadable`、`unsupported`、`failed` 必须给出有界 reason，读取失败不得藏在空数组里。无材料输入不能声明任一种 processed；`processed-with-records` 需要该输入实际参与字段或关系证据。平台只校验它能观察的事实，外部提取器声称“读完全文”仍是 producer-declared，不能虚构平台执行轨迹。

### 4.7 重复提交、取消与回执

批次重复提交身份与 payload hash 不同。比较域至少包括 spec、manifest、records、evidence、coverage 和影响解释的方法声明；同 key 配不同比较域必须冲突，不能覆盖旧结果。

scope、并发、回执保留、响应丢失、过期与取消的首版决定见 [4.11](#411-首版规范输入绑定与提交语义)。接纳与回执、依赖保护在同一事务；回执不保存历史 payload，独立读取不能承诺重建原载荷。

取消本系统请求不等于杀死任意外部提取进程。外部程序收到取消后可能仍提交，服务端按明确 operation/submission 状态判断，不以客户端 UI 已消失作为状态证据。已经接纳的批次保留；取消前提交但响应丢失时应能按回执合同辨认。

### 4.8 数据所有权与对外证据保护

领域 payload 不进入 LiteratureMetadata、来源 observation 或权威 Reference。首版通过响应或调用方明确选择的交付目的返回候选；外部网络目的若将来支持，须另行定义，不接受任意 URL 就自动发送数据。

候选历史托管是另一个能力，需先定义访问、容量、保留、删除、恢复和 schema 迁移。当前不能让“可读取结果”暗示存在永久 Candidate 仓库。

对外交付的 EvidenceRef 仍需依赖保护或明确的有效性/失效政策。保护记录可以不包含领域 payload，但要能阻止回收误删已承诺可复核的输入。该政策须在 Storage 回收 writer 接通前明确，并由接纳回执告诉调用方；不默认为无限保存，也不默认为任务结束即可回收。

### 4.9 外部生产者与内部运行时

ProducerDeclaration 可包含工具/算法标识、版本、模型与参数 hash、安全 usage 摘要及来源类别。平台观测到的接收时间、校验版本和引用复核结果由平台填写；外部声明的方法不能写成 platform-observed provenance。

Extractor 不获得配置 secret、SQL 写入、Browser/Page 对象或任意脚本执行能力。读取原始 PDF 受控交付字节；将字节交给哪个外部算法由调用方负责。若需要 Browser 协助获取材料，应另行启动用户授权的维护流程。

### 4.10 合同案例与验证

扁平案例：规范规定一条记录为一次测量，字段为 material、value、unit、temperature。两条测量来自同一论文，各自绑定表格行和脚注，产生两个 record_id。

嵌套案例：规范规定一条记录为一套实验，payload 内有 conditions 和多条 measurements。平台仍只验证 schema、pointer 与证据，不要求拆成它自己的 Sample 表。

跨文案例：记录对比两篇文章中的同一材料，manifest 固定两个具体版本；每个字段分别引用其来源，关系证据描述为什么组合。是否确为同种材料和是否可比较，由下游接纳。

验证需穿过实际材料读取与候选接纳边界，在无内部模型配置下完成上述流程。负例包括不支持 schema、远程 ref、缺失字段、错误 pointer、跨范围证据、同 key 异内容、响应丢失、过期/重启、取消后迟到，以及交付后重解析/回收仍能复核原证据。用这些不同记录形状证明通用性，不能只以一个固定领域 JSON 成功为证。

<a id="412-首版规范输入绑定与提交语义"></a>

### 4.11 首版规范、输入绑定与提交语义

显式 operation 固定规范与输入，候选接纳与回执使用同一事务。只读准备结果仍不表示已经受理一次提取任务。

`ExtractionSpec` 采用 Draft 2020-12 URI，但只接受封闭关键词集合：`$schema`、根层 `$defs`、`$ref`、`type`、`properties`、`required`、`additionalProperties`、`items`、`prefixItems`、`minItems/maxItems`、`minLength/maxLength`、`minimum/maximum/exclusiveMinimum/exclusiveMaximum`、`enum`、`const`、`allOf/anyOf/oneOf`、`title/description`。根 schema 需声明支持的 `type` 或本地 `$ref`，根值可为 object、array 或其它 JSON 类型；`type` 联合数组由 Ajv 明确允许并按声明验证，不改变载荷类型。`$ref` 仅允许 `#/$defs/<简单名称>` 且目标存在，可递归指回同一定义。不接受远程、动态或锚定引用、`$id`、正则、format、default、条件词、未知关键词和布尔 schema。不能靠关闭 Ajv strict 校验使非法 schema 通过。编译及候选校验运行于可终止 worker，单次 3 秒超时；进程内最多同时 2 个 worker、16 个可取消排队请求，超额报 `schema-busy`。Ajv 使用 `inlineRefs:false` 避免本地引用重复内联；每个 Worker 另设 V8 old/young heap 64/16 MiB、code range 16 MiB、stack 2 MiB 上限，资源退出报 `schema-resource-limit`。这些是 V8 隔离堆/栈限制，不声称限制进程总 RSS 或外部原生内存。取消与关闭中断并等待 worker 终止。完整规范（含 hash）≤64 KiB、schema 节点≤128、语法嵌套≤8、组合嵌套≤3、每组合≤8 分支、定义≤128。候选 JSON 深度≤32、数组≤256、节点≤8192、批次≤1 MiB；记录与证据数量在 T02 envelope 边界另行检查。

规范、manifest 与候选提交意图使用 Extraction 专用规范 JSON：对象键按 Unicode scalar code point 序列逐个比较并升序排列，公共前缀短者先；整数形键按字符序（例如 `"10"` 先于 `"2"`），BMP 与星体字符按实际码点序，不使用 UTF-16 单元序、数值序或插入顺序。序列化器逐字段输出，避免 JSON.stringify 对整数形键重排；**字符串值及键的码点原样保留**（仅执行 JSON 必需的引号/控制字符转义），数组顺序保留；HTTP 与 Web 输入/响应 JSON 在解析时拒绝重复键，所有入口在复制或序列化完整大对象前按累计字节、节点、字符串和深度预算检查，并拒绝稀疏数组、NFC 后碰撞的键、孤立 surrogate、非有限数、不安全整数和非 JSON 值。数字按有限 binary64 解释，不从字符串自动转换、不填 schema default、不转换单位；需要精确十进制时调用方应在 schema 使用字符串。`spec_sha256` 对除 hash 自身外的完整规范内容计算，包含记录含义、领域说明、纳入/缺失规则、证据政策和能力要求。相同 `(caller_id,spec_id,spec_version)` 在首次 operation 接纳时固定唯一 hash；准备检查不注册或改变规范。`caller_id` 是本机调用方声明的逻辑命名空间，不是已认证的远程租户身份。

共享 `InputManifest` 的 `schema_version=1`、`scope=explicit-inputs-v1`、`metadata_included=false`，完整 JSON ≤256 KiB，按调用方显式顺序固定最多 128 个 `input_id`；每项包含 Literature ID、已接纳原 PDF 的 `DocumentMaterialRef` 或 `material-missing`、可选精确 DocumentVersion 的 `DocumentReadingRef`、真实能力和缺口。相同 Literature 可以用不同 `input_id` 选择多个原件/文档版本；不能按 Literature ID 折叠。manifest hash 覆盖全部有序项和能力/缺口，但不包含 hash 自身。书目元数据不在首版证据输入闭包内，不能把题录投影当 PDF 正文。准备 API 只用 Document/Literature read port 实证已接纳文件字节及文档闭包；没有 PDF 时不造资产，没有 parser 时不解析。原 PDF 文件证据可在 v1/v2 读取；有文档才声明 `document-segment-v1`、text、outline、resources；当前不声明 table cell、figure caption、page 或 bbox。平台不支持的 capability 拒绝规范，某个已支持能力在具体输入缺失则返回该项 gap。需要 segment 的政策不能靠 file 引用满足。

公开 TS `QueryApplication.extractionPreparation.prepare({spec,inputs})` 与 HTTP `POST /api/v1/query/extraction-prepare` 返回 `spec`、`manifest`、每项缺少的 required capability 和 `persistence: requires-catalog-v5`；HTTP 使用独立 256 KiB 的严格 JSON body。共享请求/结果 parser 检查 hash、输入顺序及资产/显式版本绑定、能力/缺口自洽；`file` 政策隐含 `material-file-v1`，`segment` 政策隐含 `document-segment-v1`，即使调用方未重复列入 required capabilities，准备结果也不能漏报缺口。人类查询页对输入和响应使用同样严格解析，并拒绝伪造或错绑结果。此调用只读，不创建 operation、不查询外站、不触发获取、解析、模型或索引重建；明确缺失返回 `input-missing`，已接纳字节或文档损坏返回 `input-integrity`，能力不支持返回 `input-unsupported`，调用取消返回 `preparation-cancelled`。关闭拒绝新调用，取消并等待在途准备及 schema worker 实际退出后才释放读取依赖；检索 Q 可另行帮助定位，但其零命中和截断不能被推断为全文已处理。

T02 接纳的精确作用域为 `(caller_id,spec_id,spec_version,spec_sha256,operation_id,submission_key)`，其中服务器生成不可复用的 operation ID，operation 创建时固定 spec 与 manifest。`submission_sha256` 对版本、scope、spec/manifest hash、batch ID、records/payload、字段及关系证据、coverage、producer 方法和 usage 声明的完整规范 JSON 计算，不包含收信时间、连接和平台复核摘要。相同作用域/key/hash 在回执有效期内返回同一历史回执，即使 operation 后来 closed/cancelled/expired；当前源或 default 的后续变化不能使旧提交重新接纳。相同 key 不同 hash 冲突；新 key 仅在 operation open 且未过接纳窗时接纳。已有批次不受后批失败或取消撤销。`record_id` 只在批次内唯一；字段 pointer 按 RFC 6901，空串指根，数组只接受实际存在的规范索引；关系两端必须指向本批真实记录/字段，证据必须落在本 manifest。跨输入判定只读取关系两端**所指字段**的来源集合，不能用同一记录其它无关字段的来源充当端点证据。零记录仍按每个输入显式声明 processed-no-records、not-processed、unreadable、unsupported、failed 或 cancelled；只读或 Q 的零命中不能转成 processed。结构和引用检查为平台观测，处理覆盖、方法与 usage 属生产者声明，科学接纳始终归下游。

首版 operation 接纳窗 24 小时；接纳后回执及其输入引用保护 30 天。每个 operation 至多 64 批，全库至多 1,000 个有效 operation / 10,000 个未过期回执；计数前检查已过期项，满额拒绝新写，不驱逐有效回执。提交事务重新读取平台时间和 operation 状态，复检精确输入、唯一 key，并在同一个 SQLite 事务插入 receipt 与整个 manifest 的原件/文档依赖；COMMIT 为唯一接纳线性化点。取消与提交通过同一 worker/写入准入顺序决定，已发出 SQL 的提交必须结算后响应，HTTP 连接断开不撤销已提交事实。过期清理是显式有限维护；清理后仅可返回 `unknown-or-expired`，不能声称从未接纳或允许原 operation ID 复活。回执只保存 hash、检查摘要、期限与依赖；不保存完整历史候选 payload。重复请求带来本次同内容 payload 时可以回显，单独查询旧回执不能恢复 payload。

发布、读取和回收须由 Storage 通过精确版本 pin/依赖复检和短事务写入避免竞态；ArtifactStore 的 create-if-absent 与冲突保留策略继续适用。确需迁移旧 catalog 或产物格式时先定义输入 fingerprint、reader 支持、备份/恢复和失败恢复，不能在读取时静默改写用户数据。

T02 的精确创建请求为 `{caller_id,spec,manifest}`。`ExtractionDeliveryService.create` 在首次 await 前复制输入，复核规范/manifest hash 与已接纳材料，Storage 事务固定 `(caller_id,spec_id,spec_version)` 的唯一规范 hash、生成 UUID operation ID、写入 24 小时 `accept_until`。同标签换 hash 报 `spec-conflict`；`caller_id` 仅是本机声明，不提供远程租户隔离。提交请求是 `{schema_version:1,operation_id,submission_key,batch_id,records,relations,coverage,producer}`，均为封闭字段：

```ts
records: [{ record_id, payload, field_evidence: [{
  pointer, sources: [{ input_id, evidence: EvidenceRef }]
}] }]
relations: [{ relation_type, from: { record_id, pointer },
  to: { record_id, pointer }, evidence: [{ input_id, evidence: EvidenceRef }] }]
coverage: [{ input_id, status, reason }]
producer: { method_id, method_version: string | null,
  usage: Record<string, nonnegativeSafeInteger> }
```

单批规范 JSON ≤1 MiB、最多 64 条 records、128 条具名 relations、256 个证据来源；每条记录最多 128 个不重复 field pointer，每个字段或关系最多 8 个来源。`record_id` 仅批次内唯一；关系端点必须定位本批记录中实际存在且已给字段证据的 payload pointer。空 pointer 指记录根；数组 pointer 只接受实际存在的规范十进制索引。`required_pointers=record-root` 要求每条记录的根证据；`all-scalar-leaves` 要求全部标量叶（空容器以根补足），并不将容器结构自动当作科学事实。文件证据与 manifest 的完整 MaterialRef 匹配；文档证据必须有非空内容 hash，且版本/表示 hash 与固定 manifest 一致。新接纳时重新读取全部实际 manifest 输入及每个独特证据；不存在的材料不建立 pin。`field_granularity=segment` 不接受文件级证据。`cross_input_relation=required` 且有记录时，至少一条具名关系需由不同输入分别支持两端记录，其关系证据也同时包含这两个输入；同输入关系不能冒充跨输入支持；一条记录内其它字段即使引用了另一输入，也不能支持该关系所指端点。

`coverage` 按 manifest 顺序逐输入恰好一项，状态为 `processed-with-records`、`processed-no-records`、`not-processed`、`unreadable`、`unsupported`、`failed`、`cancelled`。前三者中两种 processed 只允许真实材料与所需能力齐备；`processed-with-records` 必须有该输入的字段或关系证据，其它状态不能声称同输入已有候选。`unreadable`、`unsupported`、`failed` 必须有非空、≤512 UTF-8 字节的 producer reason；其它状态可带或不带 reason。method ID/version 和最多 16 个非负安全整数 usage 项均为生产者声明，只参与比较 hash，不进入平台检查摘要。成功提交当次 `accepted_batch` 回显完整复制过的本批候选及这些声明；单独读取历史回执只给 hash、计数、期限与实际 pin，不恢复声明或 payload。

写入实现位于同一个 SQLite worker，CatalogWriteAdmission 排列 create/submit/close/cancel/cleanup；`submit` 事务先判有效历史 key/hash，再复检新写入的状态、时间、容量与精确输入，插入 receipt 和整个 manifest 中实际存在的 material/document pin 后 COMMIT。Worker 一旦收到写命令，即使调用方或 HTTP 断连也等待真实结果，不把已提交事实报为取消。`create`/`operation` 输出封闭 `ExtractionOperationResult`；`submit` 输出封闭 `ExtractionAcceptedResult`，其 `receipt` 与独立读取的 `ExtractionReceiptResult` 同形，均显式带 `schema_version=1`。公开投影拒绝未知字段、无效 ID/hash/日期/计数/pin，SQL 的 `checks_json`、`spec_json`、`manifest_json` 不外泄；当次批次必须与请求一致，回执 hash 按固定 operation scope 复算。提交比较 hash 允许 1 MiB request 之外最多 4 KiB 固定 scope 开销，HTTP 协议封套也单独允许 4 KiB；回执最多 128 KiB，成功 AcceptedResult（含本次 batch）最多 2 MiB + 128 KiB。固定外层封套的节点和深度开销单独计入，spec、manifest 和 batch 仍分别按原限制验证，避免合法内层在后续交付阶段被拒。结构/schema/证据拒绝使用稳定 code 与最多首个有界 `CandidateIssue {code,record_id,pointer,input_id,relation_index,keyword,truncated}`，不回显完整 payload 或底层异常；无多项列表时 `truncated=true` 表示还有未报告问题的可能。材料缺失/损坏/能力不支持、取消与写入准入映射为可操作错误：真实取消为 `delivery-cancelled`，准入冲突为 `delivery-write-conflict`，准入安全异常、关闭和期限失效分别为 `delivery-write-security`、`delivery-write-closed`、`delivery-write-expired`，并保留底层 cause；未知 SQLite 故障只作 `storage-unavailable`，不把原生错误码当业务协议。`receipt` 与 `operation` 查询只读；显式 `cleanupExpired(limit)` 每次最多清理 1–1000 行，仅在 `receipt_expires_at` 和 `protection_expires_at` 都已过时删 receipt/pin，再删接纳窗已过且无 receipt 的 operation，永不驱逐有效行。首版两个期限同为接纳后 30 天，分别检查可避免保护延长时提前释放 pin。v5 继续禁止物理资产/文档回收；现有 pin 行可在回执中及 SQLite 外键表中检查。容量与期限遵守上文固定值，历史 payload、用户配置、领域最终接纳和外站写入均不在此服务内。

外部普通提取程序可由只读 `QueryApplication.documentRead.withMaterialBytes` 或 `/api/v1/query/material-bytes` 按 manifest 将固定原件的稳定 Literature ID、Asset ID 与预期 SHA-256 换成原 PDF 字节流；路径、FileStore 和内部 SQL 不进入调用方协议。该读取使用 Document 所有的关系核对与 FileStore 前后整件校验，HTTP 仅在末次校验通过后正常结束；固定原件大小最多 256 MiB。随后调用方自行解释字节，按 `extractionPreparation` 固定规范与 manifest，从 `material-evidence` 或固定文档版本读取可核验证据，再经维护 `create/submit` 取得当次完整候选和回执。合成外部程序测试用两个不同 Literature 的原 PDF 字节生成一文多条嵌套记录、跨文关系与另一种数组形状；零记录、未处理、读取失败、错范围、冲突、取消和文件证据冒充片段均保留不同结果。这验证协议可供不同调用方 schema/算法消费，不验证科学提取质量。真实回执 pin 的旧 DocumentVersion 在显式重解析新版本与回收尝试后仍可用原 EvidenceRef 复核；当前 v5 的物理回收 writer 继续禁用，旧版本保留与已提交 pin 共同构成此结果，不表示已实施物理 GC。

<a id="5-共享支撑无状态模型运行时"></a>

## 5. 共享支撑：单次模型与受控执行基础

本节说明唯一 DSH 执行基础及项目的配置/协议适配。单次入口只执行一次模型调用；分析流程归本模块，浏览器动作与控制归⑧，外部科研 Agent 不通过它取得任意内部工具权限。

### 5.1 知识与人类协作扩展下的模型边界

共享模型入口仍负责协议、配置、用量和失败；DSH 拥有持续会话循环，各业务 owner 拥有工具范围、输入与结果验收。

按 [ADR 0031](../decisions/0031-dsh-backed-agent-capabilities.md)，`agents/dsh/` 以公开 Cordis/DSH 服务组合进程内会话、模型—工具循环、投影和压缩。业务模块通过 `capability.ts` 定义的中性会话接口提供目标、受控工具和每次请求的准入生命周期。单次模型任务与持续会话均进入原生 DSH LlmRuntime。Analysis、综合、身份核验、名称治理和配置 probe 保持原 AgentCall/AgentResult 合同，Browser 使用同一底座的 createSession；所有消费者也可通过中性会话接口提供受控工具。默认保留全部图片，Browser 显式指定最新截图策略；文本任务不默认要求视觉能力。依赖及取舍见[接入提案](../../archive/2026-10-13-dsh-agent-backend/proposal.md)、[实施计划](../../archive/2026-10-13-dsh-agent-backend/README.md)与 [DSH 兼容说明](../../notes/deepseek-harness.md)。

外部科研 Agent 通过 [统一产品接口：公开操作、协议与资源交付](01-product-interface.md#2-公开操作协议与资源交付)消费知识，人类指导由[统一产品接口：人类工作台与知识阅读](01-product-interface.md#4-人类工作台与知识阅读)绑定当前文章并在安全决策点交给 controller；均不转化为 Agents 的持久 memory、控制权或事实写入能力。离线运行验证与真实模型/站点效果分别记录，不能以 DSH 循环成功代替 PDF 交付验收。

### 5.2 当前实现结构

```text
apps/server/src/agents/
  protocol.ts   # 中性 AgentCall/Result、严格 schema 与输入校验
  dsh/runtime.ts # 唯一 DshAgentRuntime 公开门面
  model-protocol.ts # 内部完整消息、工具 ID/结果、私有续接状态
  capability.ts # 中性能力会话、工具与逐请求生命周期
  dsh/          # 唯一运行实现、原生单次模型派发、会话、图片和压缩适配
  common.ts     # endpoint/credential/请求边界、有界协议处理
  openai.ts     # Responses 与 Chat Completions
  anthropic.ts  # Messages adapter
  probe.ts      # 用户显式的模型目录/最小调用
```

单次消费方通过 `DshAgentRuntime` 与 `protocol.ts` 的中性类型协作；受控能力通过 `capability.ts` 创建、追加、运行、压缩和关闭会话。`common.ts` 和 vendor wire 数据属于 adapter 内部；Browser/Analysis 不能导入供应商响应结构。目录读取仅为显式配置服务，不形成模型目录缓存或业务状态。

### 5.3 公共执行合同

```ts
interface AgentRuntimeSurface {
  readiness(role: AgentRole): {
    readonly configured: boolean;
    readonly missing: readonly AgentCapability[];
  };
  execute(call: AgentCall, signal?: AbortSignal): Promise<AgentResult>;
  close(): void;
}
```

`execute` 保持已导出的单次语义。内部 `executeModel(ModelRequest, signal?, lifecycle?)` 使用同一 role binding、取消域和结果 usage 校验；生产 adapter 共享一套 wire 实现，旧 `execute` 只在返回时投影为严格 JSON 对象或单一工具调用，仍拒绝多工具及文本/工具混合结果。

这里摘录调用形态；role binding 的具体构造参数见 `runtime.ts`。`AgentResult` 是 `kind: "structured"` 或 `kind: "tool"` 的判别联合，包含安全的 provider/model/usage；它不是文献业务产物。

`AgentCall` 包含：

- `role`；
- immutable ordered messages/text parts；
- required capability 集合；
- consumer-owned input hash；-严格 response schema 或 tool declarations，二者互斥；-可选本次 `max_output_tokens`（Browser 必填）。

`AgentCall` 不包含 Provider、Base URL、model、credential、AccessScope、session、history、turn、job deadline 或 Analysis/Browser 业务枚举。`signal` 是 `execute` 的执行参数，不成为可复用 Call 状态。

`DshAgentRuntime` 保存 Analysis/Browser role bindings，并为每个 role 保存对应 Provider adapter；
两个 binding 解析到同一 Model Provider 时复用同一 adapter，解析到不同 Provider 时分别使用两个
adapter。每个 binding 包含 role、model、模块派生的 capabilities、Model reasoning effort、Model
stream 与适用单次 limits。消费者不能在 `AgentCall` 中临时覆盖 model、effort 或 stream。Runtime
在 I/O 前完成：

1. role binding 存在性；
2. required capability 与声明 capability 匹配；
3. 图像媒体类型、数量和字节；
4. 本次 output token 上限；
5. prompt/input/schema/request 等可客观计算的字节上限；
6. cancel 状态。

验证通过后 Runtime 生成只在 Agents 内部使用的 Provider wire call，绑定 model、reasoning
effort、stream、HTTP limits 和取消信号，并调用 adapter 一次。Runtime 不把 UTF-8 byte count
换算成 token，也不在没有可信 tokenizer 的情况下猜测输入 token；Provider 返回实际 usage 后，
Runtime 才在结果边界验证 `input_tokens + output_tokens` 没有超过 binding 与 Model capability 的
context window。

### 5.4 中性交换值

```text
AgentRole
  analysis | browser

AgentCapability
  structured_text | image_input | tool_decision

AgentTextPart
  media_type: text/plain | application/json
  text: bounded UTF-8

AgentImagePart
  media_type: image/png | image/jpeg | image/webp
  data: bounded bytes
  width / height

AgentToolDeclaration
  name
  description
  closed strict JSON schema

AgentStructuredResult
  canonical strict JSON object
  AgentProvenance

AgentToolCall
  one declared tool name
  canonical strict JSON arguments
  AgentProvenance
```

交换值必须拒绝 duplicate JSON key、NaN/Infinity、未知 schema keyword、未关闭 object schema、无界递归、超大文本/图像/结果和未声明 tool。repr 与日志不包含正文、图片或 tool arguments。

内部 `ModelRequest/ModelResponse` 另外表达 assistant 文本、多个带稳定 ID 的工具调用，以及带 `success/error/rejected/cancelled` 状态的对应工具结果。调用 ID 必须唯一，每一批结果必须完整匹配原调用才允许下一次请求；缺失 ID、悬空结果及非法参数在边界拒绝。工具结果可含图片；Chat 的文本工具结果之后使用明确关联调用 ID 的 user 图片消息，Responses 和 Anthropic 使用原生图片结果结构。普通文本和压缩结果不必伪装为 JSON。

需要续接的供应商状态保存在内部 `ModelContinuation`：Responses 保留完整有序 output（含 reasoning encrypted content），Anthropic 保留完整有序 content（含 thinking/redacted 签名块），兼容 Chat 保留 reasoning content。这样文本、推理块与多个工具调用交错时也按原顺序重放。续接数据与中性 assistant parts/tool calls 一起绑定内容 hash；任何一侧修改后拒绝重放旧数据。DSH 通过原生 ReplayEnvelope 保存并恢复，wire 另复核 provider/model/protocol；这些私有数据不进入 Browser 提示词、普通日志或业务事实。

这些值只服务当前调用或能力会话，不进入文献持久化合同，也不提供跨进程对话恢复。

### 5.5 Capability、role binding 与 readiness

model capability 至少表达：

```text
context_window_tokens
max_output_tokens
structured_output
image_input
tool_decision
supported_image_media_types
max_image_count
max_image_bytes
```

Analysis role 默认需要 `structured_text`；Browser role 默认需要 `image_input + tool_decision`。调用可以声明该次所需 capability，但不能要求 role binding 未声明的能力。

`readiness(role)` 纯本地计算并区分：

- role 是否配置；
- protocol 是否支持；
- model 是否声明；
- required capability 缺口。

它不发网络请求，不持久化 probe 结果。Analyze 与 Browser 可以选择同一或不同 Model；
同一 Provider 只构造一套 credential/adapter/quota scope，不同 Provider 各自使用 exact-origin
credential 与 adapter。用户显式 `config test` 才发送固定最小 probe。

`identity(role)` 同样按 role 解析并返回该 role 实际绑定的 Provider、wire Model、reasoning 与
stream；Analysis 与 Browser 绑定不同 Provider 时，日志和 provenance 不能回退读取另一个 role
的 adapter 身份。

Model effort 的中性值为
`default / none / minimal / low / medium / high / xhigh / max`。`default` 在三种
adapter 中都完全省略对应参数；其它七值原样进入 OpenAI Responses 的 `reasoning.effort`、
OpenAI Chat Completions 的 `reasoning_effort` 或 Anthropic Messages 的
`output_config.effort`，并进入 provider parameters hash，不做降级或近似映射。交互配置始终提供
八个中性值；真实模型是否支持由显式 probe 证明。Runtime 不按 model 名称判断支持度，adapter 也
不能在服务拒绝后静默重试为 default。

Model stream 是严格 Boolean，默认 `true`。Configuration → Bootstrap role binding → Provider wire
call 只传播所选 Model 的值；Analysis/Browser 没有覆盖入口。stream 也进入 provider parameters
hash，确保同一输入的流式与非流式调用具有不同 provenance 参数身份。

### 5.6 单次客观技术边界

Agents 保留以下单次限制：

- prompt/input/schema/request/response/result 字节；
- model 实际 context window；Browser 声明的本次 max output；图片媒体、数量和字节；
- HTTP connect/read；Analysis 使用响应停滞超时，持续收到数据时不按总时长截断，等待共享许可只受取消信号约束；Browser 保持原 total timeout；
- redirect 禁止与非幂等 POST 不自动重试；
- 三种协议的原始 SSE 字节与重建结果分别受 response/result limit 约束；
- Network AccessScope quota/rate limit；
- cancel signal。

OpenAI Analysis 请求省略 `max_output_tokens` / `max_completion_tokens`，由模型协议决定输出；Anthropic 协议必须携带 `max_tokens`，缺省使用 adapter 的 16384，不作为累计业务预算。

这些是单次调用或 Provider transport 的客观边界，不是业务作业预算。单次 `DshAgentRuntime` 不累计多个调用的 token、输入、图片、response、result、wall-clock 或 turn，也不保存历史结果。累计的业务预算不在 Runtime 里：知识加工及其辅助模型操作的软预算由 Analysis 经 8.6 的账本执行（尚未实现）；解析与建档不设业务预算，Browser 的文章探索预算归 Browser owner。Analysis 继续为每个有限阶段建立独立 `AgentCall`；DSH 从会话投影生成每个完整 `ModelRequest`。普通推理和压缩分别取得新的 request identity 和调用方准入生命周期，Network 获取许可后、实际发送前复核取消/预算并派发计数，完成时结清活跃区间。排队取消不计派发，发送后失败计一次；整个 turn 不复用只允许 dispatch 一次的旧生命周期。

### 5.7 Provider Port 与 adapter

内部 Provider Port 接收 Runtime 已绑定 model 的完整请求，返回 assistant 文本、工具调用、usage 和必要续接状态；旧单次接口随后执行严格投影。Adapter 负责：

- 中性 parts/schema/tools 到当前协议请求的转换；
- secret 只附着到配置绑定的规范 origin；
- 通过 Network HTTP、AccessCoordinator、URL/DNS/TLS、timeout 和有界读取执行 POST；严格解析完整响应并验证工具参数；
- 三种协议都按 Model stream 明确选择请求与解析路径：`true` 发送 SSE 请求，`false` 发送并只解析
  JSON；任一路径失败后不切换模式或补发第二个 POST；
- OpenAI Responses 从有界 SSE 的 completed output item 或 `output_text.done` 重建结果，要求唯一
  terminal response，并验证 model、usage、incomplete/refusal/error；
  `response.completed.output` 为空时不能丢失已经完成的输出 item；
- OpenAI Chat Completions 重建 assistant content 和有序 function tool calls，要求唯一 finish reason、
  terminal usage chunk 与 `[DONE]`；Anthropic Messages 按 message/content-block/delta/stop 顺序重建
  文本、多个 tool use 及签名 thinking，并合并起始 input usage 与终止 output usage；
- 认证、quota、timeout、refusal、truncation、model mismatch、协议错误、取消和未知响应的稳定化；
- adapter 抛出的未声明实现异常由 Runtime 统一转换为 non-retryable `agent-internal`；已经归一的
  `AgentFailure` 原样传播，`KeyboardInterrupt`、`SystemExit` 等进程控制异常不作为业务失败吞掉；
- provider/model/input/parameter hash 与安全 usage。

Adapter 不选择 role model，不理解 Literature、Analysis stage、Publisher、Browser Observation 或动作含义，不执行 tool，也不创建隐藏 SDK transport。协议无法满足 capability 时必须在请求前明确失败，不能降级成自由文本。

### 5.8 Analysis 消费

校订、标签、元数据和算子通过共享 DSH 发起会话或结构化任务。业务验证留在所属模块；旧两阶段 controller 和 NoUsableContent 已删除。

第一阶段结果验收后才构造第二阶段 Call。ReferenceLookup 空输入不调用 Runtime。Provider 返回成功后检查结果结构、真实来源 ID、版本/hash 与序列化边界；不进行语义逐字对齐。

既有单次模型迁移已移除旧 `AgentSession`、`open_session`、model 参数透传、Analysis 私有 Provider adapter 和新旧双路径；ADR 0031 的新增受控执行基础不恢复这些旧 Analysis wrapper。

### 5.9 Browser 消费

生产 `createBrowserCapability()` 为每个文章 session 创建独立 DSH scope，固定 session/Literature 身份、目标、所选 Browser 模型及唯一 `browser_action` 工具。`article-flow.ts` 提供最新稳定观察、当前截图和指导，把真实工具结果以及人工控制/下载事件写回同一会话；下载暂停让出 worker，失败恢复继续原历史和原预算。

模型可以返回普通文本或多个调用；Browser 仍只接受当前稳定观察至多一个页面动作，多余、无效或失效调用得到明确拒绝/取消结果。工具完整批次结算后让出本轮，重新观察才能获得下一动作资格。每次真实模型请求，包括压缩，都从该文章的准入回调取得独立生命周期。人工接管、取消、控制 epoch 或页面变化使旧动作失效，DSH 不决定页面权限或文件成功。

DSH 的模型输入投影保留完整文本/工具关系并只发送最新图片，原事件和图片留在会话内存直到关闭。TokenMeter/BasicCompactionEngine 可以压缩模型可见上下文；不加载默认 CLI、Web、home/settings、凭据发现、shell、SDK 子进程或自动重试插件。压缩不删除原始事件，也不声称立即释放整份历史的内存。

删除 `createBrowserDecision()` 单次兼容入口；文章流程使用有状态 capability。Challenge、登录、MFA、拒绝、未授权和未找到继续作为 Observation 的页面描述，由封闭动作与程序预算/取消处理，不自动形成文献权限事实。
Agents 不取得 Browser runtime、Page、Context、Profile、Cookie、selector、CDP、任意 URL/JavaScript、capture 或 PDF 发布能力。

### 5.10 Configuration 与 Bootstrap

模型注册字段、默认值、任务选择和交互配置统一见[配置手册](../../guides/configuration.md)。Configuration 提供经过验证的选择，Bootstrap 负责组装消费模块所需的运行时与协议适配器。

固定的单次 HTTP timeout 以及 prompt/input/schema/request/response/result 字节上限由 Agents
实现定义，并由 Bootstrap 装配，不与固定输入加工的业务预算组合；它们不是普通 Model 配置字段。

配置不新增 session turns、session deadline、累计 token/image 或 repeated-action budget；Browser 的文章探索预算仍由 Browser owner 执行。

Bootstrap 先把当前 scope 需要的 Analyze/Download 选择解析为 Model 与 Provider，再按唯一 Provider
name 构造一或两个 adapter、一个 `DshAgentRuntime` 和最多两个 role bindings。Analysis 获得
同一 DshAgentRuntime（无旧类名别名）；Browser 通过该对象创建文章会话，不再另组装独立 capability runtime。首次使用时惰性组装 DSH，单次调用经原生 LlmRuntime、会话经 AgentLoop；仅构造对象不请求模型、不加载 DSH 用户配置。close() 返回 Promise，取消并等待模型请求和会话释放，调用方须等待后再完成资源关闭。

配置向导的 model discovery 是另一条显式、短生命周期读取路径，不进入生产 `DshAgentRuntime`：

1. Entry 在 `Models → Add` 选定 Provider 后取得其规范 origin 精确绑定 credential；新远程 Provider
   在同一流程隐藏输入 key，已有 key 直接复用，loopback 不需要 key；
2. Bootstrap 构造一套共享 Network `HttpClient`，`AgentModelCatalogClient` 对严格解析后的
   `/models` 执行一次 GET，禁止 redirect、retry 和分页跟随，响应最多 1 MiB、结果最多 100 项；
3. OpenAI-compatible 结果只形成 model ID；Anthropic-compatible 可形成可选的 display/context/
   output/image/effort hints；duplicate、错误形状、错误状态和超限响应稳定失败；
4. typed catalog 返回 Entry 后 Network 立即关闭，catalog 不进入 Configuration、Runtime、日志、
   Catalog 或其它持久状态。失败或空结果才让向导进入 Manual，不放宽 URL、credential 或 Model 校验。

`config status` 和普通业务对象图不调用该入口。model discovery 不包含 prompt、Literature、PDF、
页面或模型生成请求，也不能替代 `config test analyze` / `config test browser model` 的真实
capability probe。

### 5.11 失败、日志与数据边界

稳定失败至少区分 configuration、credentials、capability、input/context/output/request/response/result limit、timeout、authentication/authorization、quota/access、request rejected、endpoint/not found、remote service、refusal、truncated、protocol/model mismatch、tool、structured response、cancelled 和 internal failure。Provider HTTP 失败可以在当次配置 Probe 中附带三位 status，并只从有界 JSON 的已知 `error.code/type/param` 映射 `model-not-found`、reasoning/structured-output/image/tool unsupported 等闭合类别；不得保存任意 message 或未知字段。Network 失败只投影闭合 access code。

INFO 由 Runtime 记录一次 role-level call start/finish，包含实际 role、provider/wire model、stream、
reasoning、结果类别、usage、延迟或稳定失败；同一事实不由 adapter 重复汇总。Debug 可以增加
protocol、capability、输入/图像/schema/tool 的安全大小与 adapter 阶段，但不记录 prompt、schema
内容、模型原文/reasoning、图片字节、页面正文、元素文本、tool arguments、credential、header、Cookie、
完整 URL 或 Profile。历史 `AgentDebugImageRecorder` 不是当前 TS 导出；当前默认不保存模型输入图片。若需要诊断产物，须另行明确内容范围、临时位置和清理责任，不能由普通 Debug 默默保存用户页面。这里对日志隐藏完整 URL；用户明确执行的配置
Probe 结果可以显示配置模型已经验证且无 query/credential 的实际 API endpoint。

Agent Call/Result、Browser turn 和失败不是 Literature 状态，不进入 Catalog、ArtifactStore、Report、Profile 或日志持久事实。Analysis 只保存其业务 provenance。

### 5.12 验收

直接测试至少覆盖：

- Provider/Model 解析、同 Provider adapter 复用、不同 Provider adapter 选择，以及 Analyze/Browser
  readiness 独立判断；
- structured result 与 tool call 的严格成功路径；
- 三种 Provider protocol fake 的请求、响应和失败映射；
- 三种协议默认携带 `stream = true`/`Accept: text/event-stream`，Model 显式关闭时携带
  `stream = false`/`Accept: application/json`；覆盖各自文本/tool 重建、usage、重复或缺失终止、
  错误 event、SSE 超限、参数 hash 分离和 POST 不自动切换模式重发；
- 八种 Model reasoning 从 Configuration 经 Bootstrap/Runtime 进入三种 wire 字段，default 省略，
  七种显式 effort 原样发送且参数 hash 随值改变；
- 显式模型目录的 GET/header/origin、可选字段、100 项/1 MiB 上限、duplicate/错误状态/错误形状、
  secret-free 失败和 Network 关闭；
- capability 缺口和错 role 在 adapter 调用计数为零时失败；
- duplicate JSON、非有限数、未知字段、超大输入/图片/响应和未声明 tool 拒绝；
- output/request/response/result、可计算 byte/count 与 HTTP timeout 的单次限制；Provider 实际
  usage 返回后验证 context，且 input/image bytes 不被当作 token；
- 双 Provider role 的 `identity(role)`、日志与实际 adapter/model 一致，未知 adapter exception
  稳定成为 non-retryable `agent-internal`；
- 取消、quota、跨 origin secret 拒绝和 POST 不重试；
- 显式 Debug 才保存 Provider-bound image parts 与受限 manifest；普通 Runtime 不创建图片目录，写盘
  失败只形成 warning，不改变 Agent 调用结果，且日志不泄露绝对路径；
- Analyze/Download 无 task-level model/reasoning/stream/capability override，用户 Model 不保存模块
  context/output/structured/tool/image limit，且无 Session、history、turn、
  累计预算或公共 Provider/model 选择面；
- 校订稿算子的有界读取、取消、证据、结果和用量验收；
- Browser tool decision fake 消费；
- 架构测试阻止业务模块导入 Provider adapter 或 vendor transport。

当前 TS Harness、安装包与离线验收不访问真实 LLM、凭据、用户语料、Browser Profile 或 Publisher。历史 wheel 内容检查只作为迁移证据；当前 package/build 必须核对 `apps/server/src/agents/` 的活动导出，不以已删除的 Python `requests.py`、`sessions.py` 等文件名作为 TS 交付标准。

### 5.13 长寿命运行时与知识消费者

adapter 的普通 endpoint/model/reasoning/stream 绑定保持 Application 启动快照；`credentialProvider` 在每次新请求的发送边界向 Configuration owner 取得当前授权。Runtime 不保存可脱离 owner 长期复用的第二份 key；凭据撤销导致下一次动作本地失败，已派发请求不承诺强行追回。

Analysis 的新长文/综合任务可连续调用 Runtime 多次，调用由固定输入计划决定。当前实现不设置累计 token、次数或时长预算；8.6 的软预算实现后，知识加工及其辅助模型操作按执行单元经账本准入，解析与建档仍不设业务预算。每次调用携带本阶段精确输入和约束；Runtime 不在前次输出后自行决定下一步，也不把生成的 tool call 自动执行。外部科研 Agent 不通过这个内部 Runtime 获得数据库或 Browser 控制，它消费独立 [统一产品接口：公开操作、协议与资源交付](01-product-interface.md#2-公开操作协议与资源交付)。

自定义 ExtractionSpec 使用的 JSON Schema 方言可能比 Agent response schema 更丰富。两种 schema 不能混用：外部候选校验无需经过 Agents 的受限协议 schema；内部默认提取策略若将 schema 映射为模型请求，必须显式报告能力缺口，不能静默删字段或放松校验。

### 5.14 配置、Agents 与业务协作

Configuration 只保存 Provider/Model/任务直接选择和固定 home 文件；Provider 持有 API/Base URL/exact-origin
credential scope，Model 持有 reasoning/image/stream，模块 capability/limits 由消费方派生。Model/Core secret 通过
绑定 bundle、用途和精确 HTTPS origin 的 opaque grant 进入 adapter；文献 Provider secret 通过独立用途 grant
进入对应 adapter。secret 不进入 Model、DTO、Report、日志或数据库。

模型 transport 按配置端点限定地址类、端口与精确 URL，使用共享 NetworkBudget。HTTP loopback 只允许
127.0.0.1/::1 或解析到这两个地址的 localhost，且不得携带或保有该 provider 的凭据；HTTPS 继续使用
public admission 与 exact-origin grant。关闭 DshAgentRuntime 取消进行中的网络请求。实际三种协议及
Analysis 组合验证见[模型 loopback 证据](../../../migration/evidence/runtime/model-loopback.md)。

单次模型入口保持无状态。三种协议的 JSON/SSE 经过有界完整 body 读取后重建中性结果，再交给 DSH 事件接口；不是逐 token 网络转发。stream 失败不改模式重发，普通推理和压缩均不隐式重试。模型不获得 Browser 或事实写入权限。Metadata/Acquisition adapter 只转换供应商协议并发布
observation；Literature、Analysis 和 Entry 分别拥有 identity/current facts、内容分析和用户协议。

## 6. 统一处理器与结果

中性合同位于 `packages/contracts/src/processors.ts`，运行接口与注册表位于 `analysis/processor.ts`。Processor 具有 id/version、文献或集合范围、输入种类、规范 schema、方法定义和执行函数。规范在准备时正规化；处理器方法定义、输出 schema 与真实模型绑定参与身份，不能只凭函数名或文献 ID 复用。

冻结输入按[算子输入与复用](#72-算子输入与复用)和[快照与多篇算子](#73-快照与多篇算子)确定。文献级输入的标识与其在批次中的位置无关；记录子集必须固定记录 ID。ProcessorInvocation 保存完整输入、规范和非秘密执行配置；运行恢复时绑定不一致会报告错误，不自动换模型/版本。

ProcessorResult 保存稳定 ID、比较身份、内容、字段证据、覆盖和实际来源。内容支持 records 与 report。结果 ID 不等于比较键，partial 尝试和后续完整结果可以并存；只有校验通过且完整的内部结果可自动复用。外部生产者信息是声明，不能当作平台实际观测。字段证据引用固定原文、快照或已保存结果的记录/路径；读取检查 hash、范围及递归引用。

`ok/empty` 是可发布结果，失败进入现有 Jobs；coverage 独立说明 complete/partial/none、实际读取片段与缺口。empty 仅用于完整处理且零记录，检索未命中不等于处理完整。结果集合保存精确成员引用与缺口，运行进度和已发布清单分离，更新发布新清单。

单篇/长文总结统一通过 summary@2 发布；综合使用固定快照与 map/reduce，保留字段来源及上游覆盖。新结果内容使用不可变文件，catalog 记录精确依赖和可重建记录/全文投影；长期证据保护独立于外部回执。具体落地与离线证据由关联[实施计划](../../archive/2026-10-18-knowledge-processing-platform/README.md)记录。

### 6.1 已实现的执行与持久化

`application/jobs/processors.ts` 在提交阶段冻结 ProcessorBatchRequest，保存到既有 ProcessingTaskRequest v2（最多 10000 个目标，完整快照最多 4 MiB）。v1 的 100 目标/1 MiB 限制保持。用户请求 hash 与冻结后的执行快照分开保存；重复 key 先比较原请求身份，不因当前默认文档或模型改变而重建原运行。队列逐目标执行，进程并发与共享模型限速沿用原底座；首版没有分布式执行，也没有任务内部并行分片调度。

有效结果先发布并登记依赖，再建立查询投影。索引失败保留有效结果，retry 复用已发布内容并补建索引。任务结束、暂停或取消后保存当时的集合清单；再重试产生新清单。清单 ID 基于运行和成员内容确定，同一清单重发不改变字节。新结果 ID 是独立 UUID，完整比较身份唯一约束只覆盖 internal/complete，partial 不占用这个键。并发争用保留实际赢家的来源，不保证远端模型恰好调用一次。

当前唯一 schema 的 `processor_results` 与 `processor_collections` 保存不可变文件引用；正文在 `knowledge/results/`、`knowledge/collections/`。依赖表保护文档、材料与上游结果；外部 material-only 候选同样保留资产 hash。`processor_record_projection`、`processor_projection_state` 与两种 FTS 从已校验结果重建，不是内容真相源。普通启动只接纳当前 schema；旧 catalog 只能经明确授权的一次性副本转换，不支持迁移阶梯。

外部长期接纳是独立 `ProcessorExternalRetention`：要求完整 ExtractionSubmission，先走原交付校验，再保存完整 candidate/relations/spec/manifest/receipt 及独立长期引用。其通用记录 payload 包装为 `{record: 原 payload}`，字段指针相应加 `/record`。请求 key 的持久判同包含完整原请求 hash；回执到期后仍能返回已托管结果，不能以新内容改写同 key。

`entry/processor-operations.ts` 是 CLI/MCP 共用的只读查询/证据/导出边界；QueryApplication 不实例化模型。数字保存原串与原单位，不默默做领域换算。标签和提取按文本片段分批，保留 missing、partial 和能力限制。精确请求格式见[统一加工指南](../../guides/knowledge-processors.md)。版本事件传播过时状态而不自动重算；Web 通过同一业务合同展示结果和证据。

## 7. 标签与算子输入

本节规定标签、单篇校订稿输入与固定快照的责任。7.2、7.3 写当前实现；[ADR 0044](../decisions/0044-knowledge-processing-platform.md) 与 [ADR 0060](../decisions/0060-two-level-full-text.md) 改变的部分（按材料准入、读取初稿、快照收入全部选中成员、公共阅读会话）是第 8 节的目标。

### 7.1 标签词表

- 标签为领域级主题关键词，不设维度，每篇文献 1 到上限（初值 6）个，按重要性排序，第一个是主标签。
- 标签可以描述领域、方法或工作类型，以及主要研究对象。化合物是研究对象的一种。
- 研究对象的名称必须在题名或摘要中作为研究对象出现。名称用正式名或通用名；代号写入同义词；不得使用文中编号作为名称。
- 不做标签的内容：数值、实验条件、所用的材料与试剂、次要的研究对象，以及出版形式和文章性质。
- 学科专属的规则只能作为例子，或作为只在特定内容出现时才触发的防护，不能成为所有文献都必须满足的条件（ADR 0060 第 6 节）。
- 当前实现：标签种类为 `topic` 与 `compound`，研究对象只支持化合物一种；名称与题名摘要的核对只对 `compound` 执行。通用的研究对象尚未实现。
- 打标流程：先写主题，再检索词表、优先吸附，确实不合适时才新建，并逐个说明理由。
- 词表变更与版本：
  - 新建、合并、设上级（最多两层）、归类、修正定义，每次变更都产生新的词表版本并写入日志，可以撤销；
  - 每批建档后自动整理；
  - 回溯只能手动执行，先显示候选数。
- 筛选可以按主标签或任一标签，上级标签包含下级；未回溯的标签会提示结果可能不完整。
- 词表 `list/search` 的分页结果为 `{items,total,next_offset}`；每项保留 `Tag` 的平铺字段并追加 `uses`，由 `parseTagListItem` 校验。`uses` 与详情 `show.uses` 同义，只计直接赋予该标签的不同文献，不累加子标签；无赋值为 0，合并后的重复赋值按同一篇计一次。列表默认仅列 active 标签，原有显式 merged 查询保留；排序与分页不因计数改变。同一只读事务内先限定当前页，再通过 `literature_tag_lookup` 一次聚合计数，HTTP、CLI、MCP 共享此投影；`Tag` 持久化合同、详情形状和模型输入不增加计数字段。
- 现有 `labels` 处理器是逐篇问答，界面改称“问答标注”，与标签词表无关。

### 7.2 算子输入与复用

当前实现的单篇算子：

- 输入只能是就绪文献的档案文档，按声明的部分和章节角色读取校订稿片段；
- 单篇算子之间不互相依赖；
- 片段的核对依据随片段提供；提取出的每个值由平台做一次用时核对，所有片段一律做文字比对，不调用视觉模型，结果为六种：可找到、找不到、值为空、无引用、引用片段不可用、综合值（ADR 0037 第三版；实现为 value-check.ts 的确定性文字比对，不再配置视觉核对角色）；
- 复用键 = 被读取部分的内容版本 + 算子版本 + 规范 + 方法 + 模型配置，描述版本不参与；
- 结果按值量化：字段要么有值，要么为空（null）；读取是否完整单独记录，补充材料不可用等作为缺口保留（如 `part-unavailable`）。原 `not-reported`、`part-absent` 两种状态取消。
- 分块：默认整篇一次调用，超过门槛（200K 与上下文窗口减预留中的较小者）才按 Markdown 结构分块，规则见 ADR 0037 第 10 节。

### 7.3 快照与多篇算子

当前实现：

- 快照不可变，冻结每个成员各部分的内容版本和描述版本，只选取 `READY` 的文献，可以比较差异。
- 多篇算子执行两步：
  1. 用 `map` 单篇算子逐篇读取，结果可复用；
  2. 只基于单篇结果汇总，输出带引用的报告或表格。
- 版本事件会把相关结果标为过时，不会自动重算。
- 按查询定义的快照超过 10000 个成员时拒绝创建（`snapshot-member-limit`）。

<a id="8-草案知识加工平台与研究任务计划-16待-adr"></a>

## 8. 知识加工平台与研究任务（尚未实现）

本节是 [ADR 0044](../decisions/0044-knowledge-processing-platform.md) 的规格，文本输入按 [ADR 0060](../decisions/0060-two-level-full-text.md) 第 4 节。本节各条都尚未实现；当前行为见第 2、3、6、7 节。实施与验收见[计划 16](../../plans/2026-10-24-operator-plugins/README.md)。

本节实现后取代的现行合同（ADR 0044 与 ADR 0060 的“部分取代”逐句列出对应的旧条款）：

| 条目                                                                                      | 取代的合同                                                                                                                                                                                                                     | 当前实现      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| 8.2 中 `report`、`answer`、`records` 以外的产出类型；8.3 的分组、成对、派生形态；8.8、8.9 | [ADR 0034](../decisions/0034-unified-processors-and-results.md)“单篇与集合两级、不建立通用算子形状”；[ADR 0037](../decisions/0037-literature-archive-and-proofread-text.md) 第 10 节“输出为带引用的 Markdown 报告或结构化表格” | 2.4、6        |
| 8.3、8.7 中汇总的输入可以是任意冻结的集合清单（跨运行或跨快照的结果）                     | ADR 0034“多篇算子以冻结快照为输入，先逐篇再汇总”                                                                                                                                                                               | 2.4、7.3      |
| 8.4 中算子读取的元数据或标签进入复用键；`requires` 中的 `tags`、`metadata:<字段>`         | ADR 0037 第 9 节“描述版本变化不使单篇结果失效”                                                                                                                                                                                 | 2.1、7.2      |
| 8.4、8.10 中算子读取初稿或校订稿，文本等级进入内容版本与复用键                            | ADR 0037 第 10 节与 ADR 0034“单篇算子只读取就绪文献的校订稿”                                                                                                                                                                   | 2.1、7.2      |
| 8.5 中 `qa`、`records` 等单篇算子改在公共阅读会话中分页读取                               | ADR 0037 第 10 节“分块”：默认整篇一次调用，超门槛再分块。总结已经使用阅读会话，不在此列                                                                                                                                        | 7.2           |
| 8.1、8.2 中以冻结元数据或人工决定为证据根的条目                                           | ADR 0037 第 10 节“用时核对”：提取出的每个值都引用校订稿片段。原文提取值的文字核对保留，并在初稿上同样执行                                                                                                                      | 3、7.2        |
| 8.6 的预算账本、软上限与授权额度（只针对知识加工及其辅助模型操作）                        | [ADR 0026](../decisions/0026-agent-knowledge-and-human-collaboration.md) 第 3 节 2026-10-12 修订“不设 token、累计调用次数或整篇执行时长的业务预算”；解析与建档不变                                                             | 5.6、5.13     |
| 8.10 门槛与快照                                                                           | ADR 0034、0037 的 `READY` 门槛                                                                                                                                                                                                 | 2.1、2.4、7.3 |
| 8.14 声明式算子                                                                           | ADR 0034“不建立配方”                                                                                                                                                                                                           | 6             |

### 8.1 问题定义与分层

服务端把文献的文本（初稿或校订稿，见 ADR 0060）加工成有类型、可核查的结果。人和 Agent 都能发起加工，并取用同一份结果：

- 人在 Web 上发起，结果按类型呈现为可以直接阅读的页面（8.12）。
- Agent 经命令行和 MCP 发起，按层读取结构化的结果（8.12）。
- 两者经过同一组检查点（8.6）。谁可以花钱由 8.6 的授权规则决定。

**库的所有者**是拥有这个文献库、为模型调用付费的人。Web 是单用户服务（[ADR 0035](../decisions/0035-authenticated-remote-web-access.md)），登录 Web 的人就是所有者。下文简称“所有者”。

需求[炼3](../requirements.md#炼3-调用方定义的提取) 的外部提取交付（`submit_extraction`）与长期托管（`retain_extraction`）保持可用，符合同一规范的外部记录可以作为记录表参与汇总与比较。

| 概念         | 定义                                                                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原料         | 每篇文献的正文文本与元数据。文本分初稿和校订稿两级；校订稿的片段带章节角色（章节、摘要、图、表），初稿的片段没有章节角色，但每个片段带核对依据（ADR 0060 第 3 节）                                                      |
| 业务引用对象 | 论文，以及条目（某份结果里的一条记录、论断、实体提及、组或边）。运行输入可以是冻结的文档部分、元数据或条目集合；跨结果关联须显式绑定每一份结果                                                                          |
| 执行单元     | 调度用的分片：单篇、批次、组、候选对。执行单元不建立长期业务实体                                                                                                                                                        |
| 结果         | 不可变；外框（输入、算子、规范、方法、模型、覆盖、判断、花费）加条目。结果有独立的结果 ID 与内容 hash                                                                                                                   |
| 复用键       | 实际冻结的输入（含文本等级、读取的元数据、上游结果 hash、归一决定与组定义）、算子@版本、规范、方法、模型的 hash。复用键不是结果身份：同一复用键可以有部分尝试与完整结果并存，只有完整结果可复用，任何复用都不覆盖旧结果 |
| 证据         | 每个条目的依据。证据根有三种：文本位置（初稿或校订稿，带文本等级；初稿片段另带核对依据）、冻结元数据及其来源、人工决定（操作者与依据）。派生与汇总条目引用上游条目                                                      |

分层：

| 层   | 内容                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| 底层 | 冻结输入与版本、公共阅读会话、运行流程（选取、试运行、估算、授权、账本）、提交校验、逐值核对、覆盖与判断、复用、发布与过时标记 |
| 算子 | 单篇插件：决定怎样读一篇论文、产出什么。内置 `summary`、`qa`、`records`；声明式算子见 8.14                                     |
| 形态 | 平台预置的执行策略（8.3）：逐篇、汇总、分组、成对、派生，共用同一执行器                                                        |
| 视图 | 平台维护的封闭“产出类型 → 视图”注册表（8.12）                                                                                  |

不提供任意依赖图、配方语言、自动循环、执行外部代码的插件或插件自带界面。五种形态是预置执行策略，不是对研究任务的完备形式化；平台不宣称任何需求都能表达。

### 8.2 产出类型与结果条目

产出类型是封闭的产品合同，新增类型须先证明现有类型不能合理承载，并经 ADR 决定：

| 类型         | 条目                                                                                                                        | 平台校验                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `report`     | 分节的带引用陈述                                                                                                            | 陈述有引用                                                 |
| `answer`     | `{answer, citations, reason}`                                                                                               | 答案类型；非空须有引用；`null` 须有原因                    |
| `records`    | 按规范字段的记录                                                                                                            | 字段类型；值逐值核对                                       |
| `statistics` | 维度 × 度量，记录公式、分母与成员                                                                                           | 口径与成员范围可重算                                       |
| `groups`     | 组与成员归属，分两种变体：`topic`（组有名称与定义，可多归属）；`entity`（组即实体，有类型与作用域，成员是实体提及，单归属） | 两种变体分别校验；组定义冻结                               |
| `relations`  | 边：端点、关系类型、方向、条件、极性（肯定或否定）、证据，以及候选或已确认（引用确认决定）                                  | 端点存在；关系类型属于声明的封闭集合；已确认边引用有效决定 |
| `pages`      | 版本化页面清单：页面、页面间链接；一页可引用多份结果                                                                        | 引用的结果与版本存在                                       |

条目结构（每种结构外面是 8.12 的共用外框）：

| 类型                 | 结构                                                                                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report`             | `sections[]`，每节 `{section_id, heading, statements[]}`；陈述 `{statement_id, text, citations[]}`                                                                                                                                                              |
| `answer`             | `{question, answer_type, answer, reason, citations[]}`                                                                                                                                                                                                          |
| `records`            | `schema` 与 `records[]`，每条 `{record_id, payload, field_evidence[]}`；`field_evidence` 按 JSON Pointer 绑定字段                                                                                                                                               |
| `statistics`         | `dimensions[]`（`{name, source}`，来源是冻结元数据字段、上游记录字段或集合清单的覆盖状态）、`measures[]`（`{name, formula, denominator}`）、`cells[]`（`{dimension_values, measure, value, denominator_count, members}`）；`members` 是成员集合的引用，分页读取 |
| `groups`（`topic`）  | `groups[]`，每组 `{group_id, name, definition}`；`memberships[]`，每项 `{group_id, member, reason, citations[]}`，一个成员可以属于多个组                                                                                                                        |
| `groups`（`entity`） | `groups[]`，每个实体 `{group_id, entity_type, scope, name, aliases[]}`；`memberships[]`，每项 `{group_id, mention, status, decision}`，一个提及只属于一个实体；`status` 为已确认或待确认                                                                        |
| `relations`          | `relation_types[]`（声明的封闭集合）与 `edges[]`，每条 `{edge_id, from, to, relation_type, direction, conditions, polarity, status, decision, citations[]}`；`status` 为候选或已确认                                                                            |
| `pages`              | `{manifest_version, pages[], links[]}`；页面 `{page_id, page_type, title, results[]}`，`results` 引用结果 ID 与版本；链接 `{from, to}`                                                                                                                          |

`citations[]` 的每一项指向一个证据（8.1 的三种证据根之一）。条目只保存引用，不复制原文片段；片段经证据读取取得（8.12）。

细则：

- `answer` 的 `answer_type` 为 `boolean | string | enum | text`；`null` 含义是“声明范围内未得出答案”，不是“论文未报告”。
- `records` 的字段可带展示角色 `subject | condition | result | note`，角色只影响列序与提示，不据此判定可比或等价。
- `statistics`、`groups`、`relations` 可以共享记录式存储，但各自校验，不合并成一个含糊合同。
- 沿用现行 ProcessorResult 的执行、版本、来源与覆盖外壳，不为新结构迁移旧结果。集合条目可以有多个来源文献，按实际文献去重，同一篇的多条结果不计为多份独立证据。
- 引用绑定到具体位置：字段路径、陈述、答案、统计格、组归属或边；不使用扁平引用列表。
- 核对按证据根区分：原文提取值引用文本片段（初稿或校订稿）并做文字核对（7.2），初稿上同样执行（ADR 0060 第 4 节）；以元数据为根的值核对冻结元数据的字段与来源；以人工决定为根的条目核对决定存在、操作者与授权；派生与汇总值按“综合值”链接上游。
- 模型结论记录支持与反证。来源链闭合只说明可追溯，不说明结论成立；数值汇总不要求在原文中逐字出现。

字段类型是封闭集合，算子 schema 与视图都只能使用：文本、布尔、枚举、整数、十进制、量（保留原串与原单位）、日期（带精度）、受控引用（文献、结果、条目）、有界对象与列表、带缺失原因的 `null`。平台不自动换算单位，不推断科学含义。

### 8.3 执行形态

| 形态 | 输入 → 产出                        | 读什么                       | 实现                                 |
| ---- | ---------------------------------- | ---------------------------- | ------------------------------------ |
| 逐篇 | 一篇的冻结部分 → 单篇结果          | 原文                         | 公共阅读会话                         |
| 汇总 | 冻结结果集合（集合清单）→ 一份结果 | 上游条目                     | 容量预检，超限分层                   |
| 分组 | 冻结单元集合 → `groups`            | 上游条目                     | 集合处理：提议组、再逐个归属         |
| 成对 | 冻结候选对集合 → `relations`       | 上游条目，必要时显式回读原文 | 对候选对逐对执行                     |
| 派生 | 冻结结果或元数据 → 结果            | 不调用模型                   | 平台内置的确定性函数，不接受任意程序 |

规则：

- 每段是一次独立运行，输入是上游**已冻结**的结果。“组合”是界面与机器接口预填下一段请求的向导，展开结果写入运行记录；平台不自动连跑。
- 汇总时可以按已有证据回读被引用的片段核实。需要补读未引用的内容时（例如汇总发现证据不足、要定点补读或修正规范），由人或 Agent 按 8.6 的发起与确认规则显式发起新的运行，旧结果不变。
- 派生只做平台内置的确定性计算（统计、筛选、页面清单组装、覆盖合计），不执行调用方提供的代码。对照表不属于派生，是汇总的 `comparison-table` 模式（8.7）。

### 8.4 算子合同

单篇算子的公共声明只有数据，不含执行函数：

| 字段            | 含义                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`、`version` | 身份；任何方法、提示词或 schema 变化都升版本                                                                                                                                                                             |
| `scope`         | 现有取值只有 `document`，即一篇文献的文本。其它知识来源（[ADR 0059](../decisions/0059-general-literature-knowledge-base.md) 第 5 节）进入加工时另定取值                                                                  |
| `requires`      | 封闭条件集合：`main-text`（正文有初稿或校订稿）、`main-proofread`（正文校订完成并为默认文档）、`body-section`（至少一个正文类章节）、`tags`、`metadata:<字段>`；不做规则语言。`main-text` 与 `main-proofread` 二选一     |
| `reads`         | 读取的部分与章节角色；首版部分只有 `main`。章节角色用平台定义的选区（例如“题录与摘要”），平台把选区映射到新旧两套章节角色：ADR 0041 之后的文档为 `title`、`authors`、`abstract`，之前的文档为 `front-matter`、`abstract` |
| `output_kind`   | `report`、`answer`、`records` 之一                                                                                                                                                                                       |
| `spec_schema`   | 校验运行参数，只用 8.2 的字段类型                                                                                                                                                                                        |
| `output_schema` | 校验产出，或由 spec 按固定规则派生                                                                                                                                                                                       |
| `method`        | 提示词、工具集、产出规则等，全部计入方法 hash                                                                                                                                                                            |

内置算子在仓库内另有实现函数；执行器不按算子 id 分支。删除现行 `Processor.map`、`uses_description` 与集合算子。算子读取的元数据或标签冻结并进入复用键。汇总、分组、成对、派生不是插件，由平台按形态与规范执行。

文本等级（ADR 0060 第 4 节）：

- 算子可以读取初稿或校订稿。一篇文献两级都有时读校订稿；只有初稿时读初稿。
- 运行发起时可以限定“只用校订稿”。这时没有校订稿的成员记为缺材料，计入覆盖，不改读初稿。
- `requires` 含 `main-proofread` 的算子只读校订稿，不受运行选项影响。
- 初稿没有章节角色。按章节角色限定读取范围的算子在初稿上读取整篇正文，覆盖说明写“初稿没有章节角色，读取了整篇”；`body-section` 在初稿上无法判定，按同样规则处理，不把成员记为缺材料。
- 摘要筛查（8.6）不读初稿：题名与摘要取自冻结的元数据，元数据没有摘要时只取校订稿的摘要角色片段。它从不在初稿上按章节角色读取，所以上一条（ADR 0060 第 4 节第 2 条）对它不适用。
- 只读冻结元数据的输入：一篇输入只读了冻结的元数据、没有读任何全文片段时（主要是摘要筛查），它的文本等级记为“元数据”。元数据不是全文的一级，全文仍只有初稿和校订稿两级（ADR 0060 第 1 节）；这个取值只说明这篇输入没有读全文。读了任何全文片段的输入，按所读片段的等级记。
- 文本等级是内容版本的一部分，进入复用键。一篇文献从初稿升级为校订稿后，依据初稿的旧结果标为过时，不自动重算。

### 8.5 公共阅读会话

- 现行总结的持续会话成为底层能力，任何单篇算子可用；工具为 `read_document`、`read_segments`、`search_document`、`view_image`、`reading_status`。
- 工具只能访问冻结的部分、章节和资源；邻段与搜索不越过声明范围。覆盖由实际读取记录得出。
- 读到的片段带文本等级；初稿片段另带核对依据（与文字层一致、有差异、没有文字层可以核对）。
- 提交由平台按产出类型统一校验（引用存在于本次输入、类型、范围）；算子只提供 schema，不提供校验代码。引用不存在片段的新提交退回同一会话修正；历史 `citation-unavailable` 结果保持可读。
- 分页读取不解除上下文与输出上限；`records` 有界分批产出。现有切块单次调用实现暂留，不作为用户可选方法。
- `qa` 完整读取声明范围，不因找到答案提前结束。

### 8.6 运行流程、选取与预算

每次付费运行经过同一组检查点：定义 → 选取 → 冻结 → 授权 → 试运行（可选）→ 估算确认 → 执行 → 取用。固定的是检查点，不是逐层强制筛选；层可以跳过、取并集或人工补入。任何检查点都不自动启动下一步的花费；授权必须在第一笔花费之前，摘要筛查与试运行也是付费步骤。

选取（逐篇运行的对象是论文快照；其它形态的对象是冻结的结果或条目集合）：

| 层       | 规则                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 元数据   | 文件夹、标签、状态、文本等级等，无模型费用。只缩小明确选择的范围，不是加工门槛。预览无需持久化，提交付费运行前冻结范围及来源                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 原文检索 | 保存查询、检索范围、检索与分词规则版本、排序与截断规则、最终成员与文档 hash、命中片段；按冻结结果重放，不靠重跑查询。界面写明“未命中不等于不相关”；支持同义词并集与人工补入；未索引材料单独列出，不当作未命中                                                                                                                                                                                                                                                                                                                                                                        |
| 摘要筛查 | `qa` 的一种读取范围（“题录与摘要”选区），不是新算子。它不依赖全文，也从不读初稿：题名和摘要取冻结的元数据，所以只有书目、还没有全文的文献也能筛查；元数据没有摘要时，取校订稿里摘要角色的片段；两处都没有（包括只有初稿的文献）即为缺摘要，成员以“缺摘要”进未定项，不调用模型。只读元数据的成员，文本等级记为“元数据”（8.4），证据根是冻结元数据；读了校订稿摘要片段的成员，文本等级记为校订稿，证据根是文本位置。只有明确违反纳入标准的证据才建议排除，“摘要没提到”为不确定；缺摘要、章节角色可疑、失败都进未定项；显示实际读取的片段或元数据字段；不自动升级为全文；成本以实测为准 |
| 已有结果 | 按一次运行的集合清单筛选成快照（8.10），常用来源是常备产物（见下）；不产生新的模型费用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 全文     | 只处理最终显式选定的范围。可选对排除集与检索未命中池分层抽样复核（系统综述建议启用），复核同样需要授权；抽样不能证明没有遗漏                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

常备产物：

- 与具体问题无关、值得在全库预先计算的结果，例如 `summary` 概览、发表统计、实体提及。
- 人在 Web 上浏览常备产物，并用它筛选、缩小范围；Agent 经机器接口先查已有的常备产物，再决定是否发起付费加工。两者读到的是同一份结果。
- 常备产物同样是显式运行，发起与确认规则与其它运行相同（见下文“发起与确认”）：所有者在 Web 发起；Agent 只能在任务授权的范围与额度内发起，否则只生成待所有者确认的请求。常备产物不常驻，不随新文献或版本变化自动补算，补算是一次新的显式运行。
- 复用规则不变。问题层的运行（`qa`、`records` 与汇总）在选定范围内照常按问题精读，不以常备产物代替。

试运行与估算：

- 样本覆盖长文、图多的论文与不同文章类型，保存样本 ID 与抽样方式；样本命中率不是召回率。
- 估算同时给出花费和用时的区间及依据：计入重复上下文、压缩、输出、回查与各级汇总，区分可复用与需新算的单元。分组的提议可能超出上下文，成对的候选数可能很大，二者都以冻结的候选数或组数为准显示。派生显示为“无模型费用”。
- 花费的单位是模型调用次数、输入 token 和输出 token，三项分别给区间。产品不保存模型单价，估算不换算成金额。
- 用时的单位是墙钟时长（秒，显示时可换算成分钟或小时），从开始执行到最后一个单元结束，不含排在其它任务之后的等待时间。依据是同口径历史单元的用时与当前的并发上限。
- 同口径：花费与用时的历史，只在以下五项都相同的单元之间合用：
  - 算子与版本（`id@version`）；
  - 方法 hash；
  - 有效模型，即配置解析后实际调用的模型，不是角色名；
  - 读取范围（声明的部分与章节角色选区，例如“题录与摘要”与整篇分开）；
  - 执行形态（8.3）。

  读取的文本等级不同的单元（初稿、校订稿、元数据）分开记历史，不合并。

- 区间取同口径历史的中位数到 P90，乘以需新算的单元数；依据写明样本数和口径（同口径历史、确定性计算或未知）。没有同口径历史时，该项显示“未知”并写明原因，不借用其它算子的历史，也不借用其它口径的历史。
- 只有输入、范围、规范、方法、模型都相同的完整结果才复用；摘要范围的回答不能复用为全文回答；同配置的试运行结果在正式运行中复用。

辅助付费步骤开始前已知的内容：

| 步骤                     | 开始前已知                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| 摘要筛查                 | 冻结的成员数；其中缺摘要、直接进未定项而不调用模型的成员数；可复用的成员数；花费与用时区间 |
| 试运行                   | 冻结的样本 ID 与抽样方式；样本数；按样本计算的花费与用时区间                               |
| 规范起草                 | 起草的输入（使用者的描述与所选的样例文献）；花费与用时区间，无历史时为“未知”               |
| 分组提议                 | 冻结的单元数；按上下文容量分成的提议批数；花费与用时区间                                   |
| 合并提议                 | 冻结的实体提及数与按冻结规则生成的候选数；花费与用时区间                                   |
| 可选叙述（对照表的汇总） | 对照表的行数与输入大小；一次汇总单元的花费与用时区间                                       |

这些步骤与正式执行一样，开始前需要确认，确认规则见下文“发起与确认”。

预算与授权：

- 预算是软上限，准入以执行单元为粒度：
  - 派发一个单元前，按估算从余额预留该单元的准入额；余额不足就不再准入新单元。
  - 已准入的单元可以透支：同一单元后续的模型调用（会话的下一轮、压缩、重试）照常进行并按实际用量逐次结算，不截断正在阅读的单篇。
  - 超出预算的上限只有在单元费用上界已被证明时才显示具体数值；否则显示“未知”，不冒充硬上限。
  - 授权撤销或过期只停止准入新单元，在途单元照常完成。
  - 崩溃或回执丢失时，预留保持占用，恢复后按实际用量记录对账，不凭空释放。
- 知识加工的所有模型调用共用同一准入与账本，包括规范起草、分组提议、合并提议等不产生运行结果的辅助调用；建档、获取与 Browser 的预算合同不变；未经确认或授权不发生任何模型调用。
- 预算与额度使用与估算相同的花费单位（见上文“试运行与估算”），各项分别计。
- 已发布结果保留；停止后如实报告完成与未处理的单元。
- 任务授权：所有者为 Agent 授予一项任务的范围、有效期与累计额度，覆盖筛查、试运行、复核与正式执行。Agent 不能自行续额或扩大范围；扣减绑定授权，跨并发运行共享且幂等。授予与撤销是所有者操作，在哪些入口可以执行见下文“所有者操作”。首版不建设长期 Agent 账户配额。

发起与确认：

| 发起者               | 怎样发起                                                                                    | 谁确认估算                                                                                                                                                                       | 花费计入               |
| -------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 所有者在 Web         | 在运行确认页查看花费与用时的估算及依据，设定本次预算，确认后提交                            | 所有者本人                                                                                                                                                                       | 本次设定的预算         |
| 持有任务授权的 Agent | 经 `estimate` 取得估算，再附上授权调用 `run` 或辅助操作                                     | Agent 自己确认，但只在三项同时满足时：步骤在授权的范围内；授权未过期、未撤销；估算花费的区间上端已知，且不超过授权的剩余额度。任一项不满足，请求转为待所有者确认，不发生模型调用 | 授权的累计额度         |
| 没有授权的 Agent     | 调用 `run` 或辅助操作，只生成待所有者确认的请求（含冻结的定义、选取与估算），不发生模型调用 | 所有者在可以执行所有者操作的入口（见下文“所有者操作”）查看并确认，同时设定本次预算；之后与所有者发起的运行相同                                                                   | 所有者确认时设定的预算 |

- 每一个付费步骤（摘要筛查、试运行、复核、规范起草、分组与合并提议、可选叙述、正式执行）都按上表分别确认。确认一个步骤不代表确认下一个。
- 运行记录发起者，以及所依据的确认或授权；结果对人和 Agent 是同一份，任一方发起的结果另一方都能取用。

所有者操作：

- 所有者操作有三项：
  - 为 Agent 授予任务授权，以及撤销授权；
  - 发布声明式算子（8.14）；
  - 确认 Agent 不能自行确认的付费步骤，即确认待所有者确认的请求。
- 可以执行所有者操作的入口：

  | 入口      | 条件                                                                                                                                                                                          |
  | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Web       | 已登录的所有者（Web 是单用户服务，见 8.1）                                                                                                                                                    |
  | 本机 CLI  | 在持有文献库的机器上运行的 `sciretriever` 命令。它以所有者身份运行，不另需开关                                                                                                                |
  | stdio MCP | 只在以 `sciretriever mcp --maintenance --owner` 启动时。`--owner` 默认关闭；不给出时，所有者操作的工具不列出，调用按不可用拒绝。`--owner` 只能与 `--maintenance` 一起给出，否则按无效参数拒绝 |

- HTTP 版 MCP 和凭设备连接令牌访问的任何接口，都不能执行所有者操作，不论令牌勾选了哪些用途（需求[规7](../requirements.md#规7-访问控制)，[ADR 0058](../decisions/0058-import-system-and-agent-access.md) 第 2、8 节）。HTTP 版 MCP 给“操作”用途的是 `--maintenance` 的业务工具，所有者操作不在其中；它在服务进程内也不开启 `--owner`。
- 所有者操作是单独的命令和工具。机器入口上的 `run` 与辅助操作不因该入口能执行所有者操作而自动确认：没有有效的任务授权时，它们仍只生成待所有者确认的请求，再经所有者操作确认并设定本次预算。
- 本机 CLI 与带 `--owner` 的 stdio MCP 以所有者身份执行：能在这台机器上用所有者账户启动它们的进程，就能执行所有者操作。所以 `--owner` 默认关闭，只供所有者本人使用；配给 Agent 的 stdio MCP 不带 `--owner`。
- 持有任务授权的 Agent 在授权内确认自己的付费步骤（上表“持有任务授权的 Agent”一行），这不是所有者操作；凡是能发起 `run` 的入口都可以这样确认，包括 HTTP 版 MCP 的“操作”用途。
- 这就是 ADR 0044 第 6 节“三端在所有者授权下都可执行”的实现方式：Web 的所有者授权是登录，CLI 的是本机的所有者身份，MCP 的是 stdio 版的 `--owner`。三端因此都能执行所有者操作，符合 [ADR 0033](../decisions/0033-machine-interfaces-cover-web-capabilities.md) 第 1 条。

续跑与刷新：

- 未完成的单元可按原冻结输入另起一次经授权的运行。
- 过时结果的重算须显式刷新输入或方法绑定后新建运行；旧快照不跟随当前版本。重试与新运行不重置累计额度。

规模：

- 单个快照最多 10000 个成员，一次任务请求最多 10000 个目标（6.1）；超限的快照在创建时被拒绝。
- 更大的选取拆成多个快照（需求[炼4](../requirements.md#炼4-发起规模与花费) 的万篇规模由此满足）：
  - 创建快照时可以显式请求拆分。平台按文献 ID 的稳定顺序把冻结的选取切成若干份，每份不超过 10000 个成员。
  - 每份快照记下同一个拆分来源：选取来源及其 hash、选取的总成员数、拆分规则、总份数和本份的序号。
  - 拆分只建快照，不启动运行。每份快照上的运行是独立的运行，各自经过检查点，各自报告覆盖。
  - 估算可以对同一次拆分的各份一并给出：每份一行，再加合计。确认仍按每次运行分别进行。
- 跨快照的总覆盖，由一份以这些运行的集合清单为输入的结果给出：
  - 需要汇总内容时用汇总（8.7），汇总可以以多份清单为输入；只需要合计时，用派生的内置函数“覆盖合计”，产出 `statistics`，无模型费用。
  - 结果对每份清单列一行：快照、成员数，完成、部分、无、缺材料、失败、未开始的成员数，以及依据初稿、依据校订稿与只读元数据的文献数（8.11）。最后一行是合计。
  - 合计按文献去重：同一篇出现在多份清单里只计一次；它在各份里的输入版本不同时，单独列为“版本不一”。
  - 输入清单都来自同一次拆分时，结果写明总份数和实际输入的份数；没有输入的份整份列为未覆盖，不把输入的几份说成整个选取。输入清单不来自同一次拆分时，合计只代表这些清单的成员。
- 快照内的执行按页与批次进行；并发复用现有 Jobs 的共享有界准入，不另建调度平台。
- 大批量运行在 Web 与机器接口上使用同一预算账本与同一并发准入。

### 8.7 汇总与命名组合

汇总请求是显式的：

```text
{ input: 冻结的集合清单（一份或多份）, mode, question?, policy, narrative? }
```

- 输入是一份或多份冻结的集合清单（目标成员、结果引用与缺口），复用现行集合清单机制。清单可以来自任何一次已冻结的运行，不限于同一快照的逐篇运行；当前实现的综合只接受同一快照的逐篇结果（2.4）。多份清单时，成员按文献去重，外框按 8.6“规模”逐份列出覆盖并给出合计。
- `mode` 与上游产出类型兼容：`answer → question-report`、`records → comparison-table`、`report → compilation`、`groups → per-group`（对每组成员分别汇总）。执行器只检查兼容性，不从插件 spec 推断问题。
- 对照表由程序确定性生成，每行是一条单篇记录及其文献、核对状态；行号只用于展示，引用绑定结果、记录、字段与 hash。可选叙述是同一汇总请求的可选部分，输入同一集合清单，只引用表中记录；叙述调用模型，须确认；叙述失败不撤销表。
- 对照表结果不复制行：只保存输入集合清单的 ID 与 hash、列定义、排序规则、行数和按行序计算的行引用 hash。行由上游记录按同一规则生成，经可重建的条目投影分页读取，读取与导出时可用行引用 hash 核对。因此行数不受单份结果 8 MiB 与单数组 10,000 项的限制（第 3 节）；导出按页流式生成。
- 汇总前做容量预检；超限时分层汇总，仍超限明确报缺口。各层保留原始证据链、同源去重、反证与少数意见；条件不同的结果不得合并为一个结论。

命名组合是固定模板，展开为一串显式运行请求并写入运行记录；每一段仍单独经过 8.6 的检查点：

| 组合                     | 展开                                                                         |
| ------------------------ | ---------------------------------------------------------------------------- |
| `question-synthesis`     | 逐篇 `qa`（同一问题）→ `question-report`                                     |
| `record-comparison`      | 逐篇 `records`（同一规范）→ `comparison-table` 汇总（可选叙述随同一请求）    |
| `publication-statistics` | 派生：冻结元数据 → `statistics`                                              |
| `topic-wiki`             | 逐篇按页面类型的规范采集 → 主题分组 → `per-group` 汇总 → 派生 `pages`（8.9） |
| `entity-graph`           | 逐篇实体提及（`records`）→ 实体归一（8.8）→ 候选对生成 → 成对 → `relations`  |

`publication-statistics` 的预置维度，全部取自冻结元数据：

| 维度     | 来源字段                        | 计数规则                                                                                   |
| -------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| 发表年份 | `publication_year`              | 每篇计一次                                                                                 |
| 出版形式 | `publication_form`              | 元数据合同的封闭取值，例如期刊文章、会议论文、书或章节、学位论文、专利、报告或标准、数据集 |
| 发表载体 | `venue`                         | 期刊、会议、书系、预印本服务器、报告系列等的名称，按元数据原样计数                         |
| 文章性质 | `article_kind`                  | 元数据合同的封闭取值                                                                       |
| 语言     | `language`                      | 按元数据原样计数                                                                           |
| 作者     | `authors[].display_name`        | 一篇计入它的每位作者；按原样计数，不归一                                                   |
| 机构     | `authors[].affiliations[].name` | 一篇在同一机构只计一次；按原样计数，不归一                                                 |

- 不假定文献都发表在期刊上。载体只是名称，不代表出版形式；载体可以与出版形式交叉统计。没有载体的文献（例如学位论文、专利）照常计入出版形式，载体记为缺失。
- 度量是文献数，分母是快照成员数。成员在某一维度没有值时，计入该维度的“缺失”格，不并入其它取值，也不从分母中去掉。
- 作者与机构是多值维度：各格之和可以大于分母，结果写明这一点；结果还写明“按原样计数，未归一”，同一作者或机构的不同写法分开计数。
- 使用者可以只选其中几个维度，或选两个维度交叉。所选维度与计数规则进入方法 hash。

### 8.8 分组、实体归一与关系

主题分组与实体归一是两种合同：

- **主题分组**：成员是论文或条目，可以多归属。组定义冻结；下游引用组 ID；重新分组是一次新运行。增量时须声明模式：“归入现有组”（组定义不变）或“重新分组”，二者结果不等价。
- **实体归一**：结果是 `groups` 的 `entity` 变体，成员是实体提及，涉及实体类型、作用域、合并与拆分。仅按规范化名称自动合并被拒绝。模型带证据提出合并提议，平台去重并按影响排序；人或经授权的 Agent 确认，可批量确认、撤销与拆分。
- **决定**：确认、撤销、拆分都记为决定（操作者、依据、时间），证据根为人工决定。每批决定产生一个新版本的归一结果，旧版本保留；下游引用绑定具体版本，解析时按所引用的版本，不跟随最新版本。未确认的提及保持独立。归一只作用于该知识集，不改变文献身份。

实体提及由内置的 `records` 规范逐篇采集（`entity-graph` 的第一段）。每条提及是一条记录：

| 字段          | 字段类型 | 含义                                                                               |
| ------------- | -------- | ---------------------------------------------------------------------------------- |
| `name`        | 文本     | 名称原文，逐字保留，不规范化、不翻译                                               |
| `entity_type` | 枚举     | 取自本次运行规范声明的实体类型集合。平台不预设任何学科的实体类型                   |
| `context`     | 文本     | 提及所在的原文短句，供归一时消歧                                                   |
| `aliases`     | 文本列表 | 文中明确写出的同指名称，例如全称与缩写；文中没有写出时为空列表，不根据其它线索推测 |

- 每个字段值都按字段引用文本片段，逐值核对（8.2）。
- 同一篇文献里 `name` 与 `entity_type` 都相同的提及记为一条，`context` 取第一处，各处位置都列入该记录的引用。
- 提及的身份是结果 ID 加记录 ID；`entity` 变体的成员引用这一身份。
- 实体类型集合属于规范，进入复用键。实体的作用域是本次归一的知识集。

关系：

- 候选对由冻结的规则生成（例如共享已确认实体、记录字段相同），规则与候选集合一并冻结，并写明漏召回风险。共享字段只能产生候选，不能证明关系。估算与授权按候选数进行。
- 每条边有关系类型、方向、条件、极性与证据，必要时显式回读原文；相同端点在不同条件下或极性相反的边分别保存，不合并。
- 成对运行产出的是候选边；边的确认与实体确认分开，同样记为决定，可批量确认与撤销，确认后产生新版本的 `relations` 结果。实体确认不能代替边确认。
- 成对运行完成全部候选，只说明候选集已处理，不说明图中没有遗漏。

### 8.9 页面集与维基

- 维基页面（论文、主题、方法、论断、研究空白等）由各自的规范驱动逐篇采集，再按组汇总，不以通用总结代替。页面必须区分“当前文献集中未找到”“作者提出的不足”“模型推断的研究空白”。
- 页面集是版本化清单。一次显式更新生成新清单：未变的页面引用旧版本，新页面引用新结果；发布成功后切换当前入口，旧页面与链接仍解析到原版本；失败时保留旧入口。
- 切换是条件切换：更新基于哪个入口版本计算，就只在当前入口仍是该版本时切换；并发的另一更新已切换时，本次发布失败并保留其结果，供重新计算受影响范围。
- 增量不等于“只处理新论文”。文档、规范、模型、归一决定、组定义、候选规则、页面清单中的索引页与交叉链接的变化都会影响下游；平台先列出受影响范围，经选取与授权后执行。变化事件只标记过时，不触发更新；阅读页面也不触发更新。
- 可重建的检索索引与查询投影不属于页面清单，重建不使任何结果或页面过时。
- 未确认的实体在页面中显示为歧义，不作为已确认实体链接。

### 8.10 门槛与快照

- 快照冻结全部选中成员、各自版本、选取来源（8.6）以及与 `requires` 对应的材料事实（正文有无初稿、有无校订稿、是否有正文章节、标签数、元数据字段是否齐全）。每个成员按 8.4 的规则选定的文本等级随快照冻结。运行时按算子的 `requires` 对照冻结的事实判定，执行时只复核完整性。之后补齐材料不改变旧快照上的运行，需新建快照。
- 单篇运行在提交时按当前事实判定 `requires`，判定结果随输入冻结。不满足的成员记为缺材料并计入覆盖。
- `READY` 只表示库整理完成，不再是算子门槛；`EXCLUDED` 仍是独立的选取政策。能力事实由事实 owner 派生，不新增可变状态。

文献的两个加工状态，都由材料事实派生，不新增可变状态：

| 状态   | 条件                                                                                      | 含义                                             |
| ------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 可加工 | 主 PDF 的正文有默认文本（初稿或校订稿），即满足 `main-text`                               | 只需要正文的算子可以加工它                       |
| 已整理 | `READY`（[ADR 0037](../decisions/0037-literature-archive-and-proofread-text.md) 第 8 节） | 库整理完成。已整理的文献一定可加工，反过来不成立 |

- 两个状态都不满足的文献，仍可以按 8.6 做摘要筛查。
- 机器入口的文献库读取返回这两个状态；Web 的文献状态按同样的含义表达，摆放见[页面规格](../web/page-specs.md)。
- 运行前，按所选算子的 `requires` 与运行选项（例如“只用校订稿”）给出将被加工与将被跳过的成员数，跳过的成员写明缺哪项材料。

按结果筛选成快照：

- 来源是一次运行的集合清单（目标成员、结果引用与缺口）的 ID 与内容 hash，加一条筛选规则；来源与规则写入快照。没有结果的目标成员由清单给出，不会被漏掉。
- 成员继承来源结果所用的输入版本；需要当前版本时由用户显式刷新，刷新写入快照。
- 未得出答案、处理失败、缺材料或未处理的成员不计为“不满足条件”，单独列为未定项，由用户决定。
- 只生成快照，不启动后续运行。

### 8.11 覆盖与判断

覆盖与判断是两条独立的轴：

- **覆盖**描述处理范围：每个单元为完成、部分或无，并记录实际读取与缺口。完整处理后零结果算完成。
- **判断**描述结论状态：例如纳入、排除、未定；回答为空；实体待确认；边为候选。“未定”不是覆盖状态。

规则：

- 下游结果记录实际消费的上游范围与相关上游缺口；不把未引用的成员算作未处理，也不因有引用就宣称读完。
- `require-all` 未满足时只有汇总阶段失败，上游结果全部保留；取消、失败、缺材料分别报告。
- 每份结果记录每篇输入文献的文本等级：初稿、校订稿，或只读冻结元数据时的“元数据”（8.4）。
- 结果外框给出三个数：
  - 依据初稿的文献数；
  - 依据校订稿的文献数；
  - 只读元数据的文献数。

  只读元数据的文献不计入前两个数。下游结果按实际消费的上游条目合计这三个数。

- 以多份集合清单为输入的结果，覆盖与这三个数按 8.6“规模”逐份列出并合计。
- 覆盖说明由声明的读取范围生成，不统一写成正文已读。例如：
  - “正文已完整读取，补充材料未覆盖”；
  - 只读元数据的成员：“题名与摘要取自元数据，正文未读”；
  - 题名取自元数据、摘要读校订稿片段的成员：“题名取自元数据，摘要取自校订稿，正文未读”；
  - 按章节角色限定读取、在初稿上读了整篇的成员：“初稿没有章节角色，读取了整篇”。
- 首版只读正文部分。未选择补充材料不记为 `part-unavailable`；显式请求补充材料在提交前报告暂不支持。

### 8.12 视图、机器读取与导出

每种产出类型同时交付三样东西：人在 Web 上读的页面，Agent 读的结构，以及带出处的导出。

视图：

- 平台维护封闭的“产出类型 → 视图”注册表；每种类型一族视图，新类型的视图随该类型的 ADR 一起交付。算子只声明类型与字段，不提供界面代码；声明式算子因此自动获得页面。
- 注册表决定可用的视图，不自动决定合理的图表；例如统计的图表维度由用户或命名组合选择，记录表的散点图须显式选择两个数值字段。
- 所有结果页共用外框：任务与规范、发起者、选取与快照来源、覆盖、判断汇总、依据初稿与依据校订稿以及只读元数据的文献数（8.11）、花费与复用；共用证据抽屉（引文、文本等级与核对依据、页码、逐值核对状态、跳转到初稿或校订稿原处）与未定项面板。页码只在定位可靠时显示。
- 页面集按各页引用结果的类型复用对应视图，并加上页面间链接。

各类型的取用：

| 类型                 | 人在 Web 上得到                                                            | Agent 得到（结构见 8.2）                                            | 带出处的导出                                          |
| -------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| `report`             | 分节的文章页，陈述后带短证据编号，点开进证据抽屉                           | 外框；按节分页读取陈述与引用 ID                                     | Markdown，引用写成脚注                                |
| `answer`             | 问题、答案与原因；答案为 `null` 时写明“声明范围内未得出答案”及原因         | 外框与完整回答（单条，不分页）                                      | Markdown                                              |
| `records`            | 分页表格，列按展示角色排序，每格显示逐值核对状态；对照表同样分页           | 外框；按记录分页读取，可按字段筛选；对照表经条目投影分页            | CSV（每行带文献与证据列）、JSON                       |
| `statistics`         | 表格，加上由用户选择维度的图表；每格可展开到成员列表                       | 外框；`dimensions`、`measures` 一次读取，`cells` 分页，成员按格分页 | CSV（含公式与分母），附成员清单                       |
| `groups`（`topic`）  | 组列表，以及每组一页：名称、定义、成员与归属理由                           | 外框；组列表分页，按组分页读取成员                                  | CSV、Markdown（每组一节）                             |
| `groups`（`entity`） | 实体列表，以及每个实体一页：类型、作用域、提及、待确认的合并提议与已有决定 | 外框；实体列表分页，按实体分页读取提及，可按确认状态筛选            | CSV                                                   |
| `relations`          | 边列表，可按端点、关系类型、极性、候选或已确认筛选；可选的图               | 外框；按端点、关系类型或状态分页读取边                              | CSV、JSON                                             |
| `pages`              | 维基式页面与页间链接；各页内容按所引结果的类型使用上面的视图               | 外框；页面清单分页，按页读取所引结果                                | Markdown 文件夹（每页一个文件，页间链接写成相对链接） |

Agent 的分层读取（需求[用2](../requirements.md#用2-agent-取用知识)）：

1. **外框。** `get_result` 只返回外框和条目总数，不含条目正文，大小有界。
2. **条目。** 按条目查询分页读取，每页有条数和字节上限，并给出续读位置；条目只带短文本与引用 ID。
3. **证据。** 沿证据跳转读取所引片段，带文献、版本、文本等级、核对依据与可靠的定位。
4. **原文。** 从片段进入文档的有界读取（[04 第 3.4 节](04-document-evidence.md#34-版本绑定的有界读取)）。

每一层都只读已有内容，不触发加工。需要在限额内跨结果取得知识时，使用混合 Context（[06 第 4.10 节](06-retrieval-context.md#410-处理器结果与混合-context)）。

带出处的导出（需求[用3](../requirements.md#用3-人的学习与写作)）：

- 每一处引用都带上文献（作者、年份、题名）、文献 ID、文档版本、文本等级、可靠的定位，以及逐值核对状态（如有）。
- 同时导出被引文献的书目，格式为书目导出已支持的 BibTeX、BibLaTeX、RIS 或 CSL-JSON；正文里的引用键与书目一致。
- 每种类型也可以导出完整的 JSON 结果封套。导出只读已有结果，不调用模型。
- 当前实现：`export` 对任一结果给出 JSON、CSV 或 Markdown；CSV 与 Markdown 按记录逐行写出，引用以 EvidenceRef 的 JSON 写出，没有题录与书目。机器入口的 `read`、`query`、`evidence`、`transfer` 分别读取整份结果、分页读取记录、核对一条引用、分段传输整份结果。

### 8.13 版本、迁移与机器接口

- 新版本：`summary@3`（迁到公共会话）、`qa@1`（取代 `labels`）、`records@3`；问题综合由 8.7 承担，`knowledge-synthesis` 不再新建运行。
- 旧结果由版本化解码器读取、导出与解析引用，不依赖活动注册表；旧结果不命中新方法复用键。
- 旧任务：旧版本的执行路径（总结的 `summarize` 特例、旧集合算子）作为隔离的版本化旧执行入口保留：该版本停止新建（见下一条）之前照常服务新建与排队的运行，之后只排空已排队或恢复中的任务；进程重启后的恢复按原版本执行，不升级方法。旧队列排空后才删除这些入口。
- 停止新建：`qa@1` 覆盖 `labels` 的答案类型与入口后，停止新建 `labels@2` 与 `summary@2` 的运行；`records@3` 上线时停止新建 `records@2` 的运行。
- 机器接口（CLI、MCP、HTTP 共用应用边界）：`list_operators`、`estimate`、`run`（逐篇目标为文献或快照；其它形态目标为冻结结果）、`get_result`、按条目查询、沿证据跳转、导出。
  - `estimate` 返回花费与用时的区间及依据（8.6），不调用模型。
  - 付费的 `run` 与所有调用模型的辅助操作须附有效的任务授权，并满足 8.6“发起与确认”中 Agent 自行确认的条件；否则只生成待所有者确认的请求，不发生模型调用。
  - `get_result`、按条目查询与沿证据跳转按 8.12 的分层读取。
  - 所有者操作（确认待确认的请求、授予与撤销任务授权、发布声明式算子）只在 Web、本机 CLI 与带 `--owner` 的 stdio MCP 上执行，规则见 8.6“所有者操作”；HTTP 版 MCP 不提供这些工具。
- 暂不增加按算子命名的便捷工具，以后只做薄别名。

### 8.14 声明式算子

- 定义是库数据：8.4 的全部字段，内容 hash 计入复用键；由通用执行器经公共会话运行，不执行定义方提供的代码。
- 工具只在白名单内；提示词不能扩大读取范围；`output_kind` 只能是单篇可产出的 `report`、`answer`、`records`。
- 生命周期：草稿只对创建者可运行；经所有者确认后发布（发布是所有者操作，入口见 8.6“所有者操作”；Agent 的任务授权不包含发布），发布版本不可修改；发布只代表可见，不授权全库执行。
- 运行表单由 `spec_schema` 自动生成，只覆盖封闭子集：字符串、数字、布尔、枚举，以及由这些类型组成的列表与固定字段对象。超出子集的 `spec_schema` 在保存定义时拒绝，不降级为手写 JSON。内置算子使用专用表单。

### 8.15 暂缓与拒绝

以下各项不属于本节的目标。重新考虑须满足所列条件，并另立需求或设计。

| 项目                                                   | 决定 | 重新考虑的条件                                                                                |
| ------------------------------------------------------ | ---- | --------------------------------------------------------------------------------------------- |
| 批注作为独立产出类型                                   | 推迟 | 已有证据可以只读旁注的方式在阅读页呈现。人工批注的创建、修改与确认是新的用户事实，须另行设计  |
| 仅按规范化名称自动合并实体                             | 拒绝 | 同名不等于同一实体                                                                            |
| 论文 × 问题矩阵                                        | 推迟 | 问题综合与记录比较闭环完成后。只读拼接已有问答结果，空答案、失败、未处理分别呈现              |
| 时间线                                                 | 推迟 | 须显式指定日期字段及其含义；发表年份不得冒充实验时间或知识演进                                |
| 一次阅读回答多个问题                                   | 推迟 | 先验证节省是否真实、是否漏答；需要稳定的问题 ID、逐问的答案、证据与缺口，整组问题进入方法身份 |
| 全量两两成对                                           | 拒绝 | 成对只处理冻结规则生成的候选对                                                                |
| 通用产出形态扩展协议、插件自带界面、任意编排、自动循环 | 拒绝 | —                                                                                             |
