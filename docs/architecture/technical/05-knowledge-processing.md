# 05 · 知识加工技术设计

[设计总览](../design.md) · [八模块技术导航](../technical.md)

本模块对应设计中的 **⑤ 知识加工**，使用已有材料与证据，形成压缩知识或交付调用方规范下的提取候选。

内部划分为 Analysis 分析/综合和 Extraction 提取交付。Analysis 拥有局部分析、整合和知识产物验收；Extraction 校验调用方规范、候选结构、证据与提交，领域算法和科学接纳归下游。两者独立使用④的读取能力，缺材料时不调用③补库。

Agents 统一由 DSH 提供模型与持续会话能力。summary 是普通单篇算子，读取校订稿与已保存图片；多篇算子使用冻结快照和逐篇 map/reduce。两阶段内容服务及旧 KnowledgeArtifact 生产接口已退役。

> 当前实现依据 [ADR 0037 第二版](../decisions/0037-literature-archive-and-proofread-text.md)。下述源码能力已接入；真实库切换和全库模型重建需独立授权。

本篇目录：

- [1. 模块边界与连接](#1-模块边界与连接)
- [2. 分析与综合](#2-分析与综合)
- [3. 结果格式与发布](#3-结果格式与发布)
- [4. 调用方规范与提取交付](#4-调用方规范与提取交付)
- [5. 共享支撑：单次模型与受控执行基础](#5-共享支撑单次模型与受控执行基础)
- [7. ADR 0037 目标形态：标签与算子输入](#7-adr-0037-目标形态标签与算子输入)

## 1. 模块边界与连接

任务②明确启动分析或接收候选；读取文档证据④；产物经存储⑦保存或按提取合同直接交付。

本篇按职责归并已有详细合同；示例中的现有类型与目标类型保持各自状态。文档归属不改变源码目录、事实所有权或当前公开 API。

## 2. 分析与综合

### 2.1 有证据的知识压缩

算子只读 READY 文献的校订稿，按部分和章节角色声明范围。元数据与标签属描述版本；正文和结构属内容版本。单篇复用键包括读取部分的内容版本、算子/规范/方法/模型身份，不包括描述版本。结果为不可变 ProcessorResult，不更新原文或元数据。

### 2.2 实现结构与公开边界

`analysis/processor*.ts` 与 `analysis/snapshots.ts` 管理算子定义、输入、执行与快照；`application/jobs/processors.ts` 负责持久任务，`storage/processor-results.ts` 负责结果发布与查询；`knowledge-session.ts` 连接 summary 的持续 DSH 阅读。`agents/dsh/` 统一执行、工具反馈和用量；`entry/processor-operations.ts` 提供 CLI/MCP/HTTP 的查询边界。模型没有 SQL、任意文件或业务写入权。

### 2.3 单篇总结

summary@2 手动发起，完整读取冻结校订文本，检查所有资源可用性，按需读取图片、检索和回查片段；`submit_result` 校验 schema、覆盖和引用，错误反馈到同一会话。超长文本按 UTF-8 续读，不截去尾部或否定条件。坏图片、取消、无效用量与伪造引用明确失败；预算或缺口如实记录，不冒充完整结果。

### 2.4 多篇综合

快照冻结 READY 成员及内容/描述版本，记录被排除的未就绪成员。map 算子逐篇读取，reduce 只基于已生成的单篇结果汇总；每项引用保留源文献与原始片段。版本事件只标过时，不自动重算。extracted、not-reported、part-absent、incomplete 分开表达；补充材料失败为 part-unavailable，不阻断正文。

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

首版采用 Draft 2020-12 的封闭子集；支持词汇表、本地 `$ref`、组合/递归和资源限制详见 §4.12。禁止远程 `$ref`，schema 校验不能隐式联网。未知关键字不能无声忽略后宣称“全部约束已验证”。

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

scope、并发、回执保留、响应丢失、过期与取消的首版决定见 §4.12。接纳与回执、依赖保护在同一事务；回执不保存历史 payload，独立读取不能承诺重建原载荷。

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

### 4.11 候选交付的剩余合同与收敛时点

候选 payload 托管、最小去重/回执记录和外部证据依赖是三种不同责任。首版无历史 payload 查询，不等于禁止必要的轻量持久记录，也不自动承诺永久幂等或无限证据保留。

- **Extraction 接纳实现前**明确去重 scope（调用方/规范/操作与 key 的组合）、比较域（包含规范、输入、证据和 payload 的规范化内容）、并发串行化、回执寿命、响应丢失重试、重启、取消/迟到、过期后行为。是否保存最小回执记录及其存储协议在此决定；过期/未知不能伪称曾接纳或全新成功。
- **Storage 回收 writer 接通前**明确对外交付引用如何进入依赖判定：登记轻量保护记录，或提供可辨认的有效性与失效政策。未确定外部引用保护时，不启用可能删除这些引用目标的回收；不能只按内部 current/产物引用判定无引用。
- **Extraction 发布接纳回执前**复用上述依赖合同，让调用方知道原始/文档证据是否受保护、何时可能失效、如何复核。Storage/Document 提供能力，Extraction 登记/交付相应引用；无需建立第二个候选 payload 仓库。
- 验证两条正式旅程：并发/响应丢失/重启或过期后的重复提交；候选交付 → 重解析/回收尝试 → 原版本证据复核。合法失效应有可检查原因，不能静默重定位或返回不存在。

下节固定首版提交合同；本节早期未决项由该合同收敛。T02 已通过独立维护对象图接通候选 writer；只读查询和原始材料读取的既有边界不变。

### 4.12 首版规范、输入绑定与提交语义

M08-T01 固定以下首版协议，T02 已接通显式 operation、候选接纳与回执事务。只读准备结果仍不表示已经受理一次提取任务。

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

这些是单次调用或 Provider transport 的客观边界，不是业务作业预算。单次 `DshAgentRuntime` 不累计多个调用的 token、输入、图片、response、result、wall-clock 或 turn，也不保存历史结果。Analysis 继续为每个有限阶段建立独立 `AgentCall`；DSH 从会话投影生成每个完整 `ModelRequest`。普通推理和压缩分别取得新的 request identity 和调用方准入生命周期，Network 获取许可后、实际发送前复核取消/预算并派发计数，完成时结清活跃区间。排队取消不计派发，发送后失败计一次；整个 turn 不复用只允许 dispatch 一次的旧生命周期。

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

Configuration 保存 Model Provider/Model 两个直接注册表：

- Provider 拥有 name、API、Base URL 与 exact-origin credential scope；
- Model 以 `provider/model` 为唯一 reference，并拥有 reasoning、image 与 stream；
- `[analyze].model` 与 `[browser].model` 直接引用完整 Model reference；
- `[providers.<provider>]` credential 与 Provider 的规范 origin 精确绑定。

交互配置由 `Models` 管理 Provider、Model 和模型 key；`Analyze`、`Download` 只选择 Model 并管理
各自业务参数。Analyze 的 structured-output/text-only 合同由模块派生；Download 只选择
`image = true` 的 Model，其 image/tool/当前生产 Observation 的 `image/jpeg`/正数 image limits 由模块派生。任一任务切换 Model 都不
修改 Model 或另一个任务；没有 Profile、Preset、Entry 或 task-level reasoning/stream override。

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

Analysis 的新长文/综合任务可连续调用 Runtime 多次，调用由固定输入计划决定，不设置累计 token/次数/时间预算。每次调用携带本阶段精确输入和约束；Runtime 不在前次输出后自行决定下一步，也不把生成的 tool call 自动执行。外部科研 Agent 不通过这个内部 Runtime 获得数据库或 Browser 控制，它消费独立 [统一产品接口：公开操作、协议与资源交付](01-product-interface.md#2-公开操作协议与资源交付)。

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

## 6. ADR 0034：统一处理器与结果（实施合同）

中性合同位于 `packages/contracts/src/processors.ts`，运行接口与注册表位于 `analysis/processor.ts`。Processor 具有 id/version、文献或集合范围、输入种类、规范 schema、方法定义和执行函数。规范在准备时正规化；处理器方法定义、输出 schema 与真实模型绑定参与身份，不能只凭函数名或文献 ID 复用。

冻结输入支持精确文档、上游 Result、既有 Knowledge 和显式缺口。文献级输入的标识与其在批次中的位置无关；记录子集必须固定记录 ID。ProcessorInvocation 保存完整输入、规范和非秘密执行配置；运行恢复时绑定不一致会报告错误，不自动换模型/版本。

ProcessorResult 保存稳定 ID、比较身份、内容、字段证据、覆盖和实际来源。内容支持 records、text 或旧知识的稳定引用。结果 ID 不等于比较键，partial 尝试和后续完整结果可以并存；只有校验通过且完整的内部结果可自动复用。外部生产者信息是声明，不能当作平台实际观测。字段证据引用原文、已保存结果的记录/路径或旧知识要点；读取应检查 hash、范围及递归引用，不把任意 JSON 冒充旧知识格式。

`ok/empty` 是可发布结果，失败进入现有 Jobs；coverage 独立说明 complete/partial/none、实际读取片段与缺口。empty 仅用于完整处理且零记录，检索未命中不等于处理完整。结果集合保存精确成员引用与缺口，运行进度和已发布清单分离，更新发布新清单。

单篇/长文总结统一通过 summary@2 发布；综合使用固定快照与 map/reduce，保留字段来源及上游覆盖。新结果内容使用不可变文件，catalog 记录精确依赖和可重建记录/全文投影；长期证据保护独立于外部回执。具体落地与离线证据由关联[实施计划](../../archive/2026-10-18-knowledge-processing-platform/README.md)记录。

### 6.1 已实现的执行与持久化

`application/jobs/processors.ts` 在提交阶段冻结 ProcessorBatchRequest，保存到既有 ProcessingTaskRequest v2（最多 10000 个目标，完整快照最多 4 MiB）。v1 的 100 目标/1 MiB 限制保持。用户请求 hash 与冻结后的执行快照分开保存；重复 key 先比较原请求身份，不因当前默认文档或模型改变而重建原运行。队列逐目标执行，进程并发与共享模型限速沿用原底座；首版没有分布式执行，也没有任务内部并行分片调度。

有效结果先发布并登记依赖，再建立查询投影。索引失败保留有效结果，retry 复用已发布内容并补建索引。任务结束、暂停或取消后保存当时的集合清单；再重试产生新清单。清单 ID 基于运行和成员内容确定，同一清单重发不改变字节。新结果 ID 是独立 UUID，完整比较身份唯一约束只覆盖 internal/complete，partial 不占用这个键。并发争用保留实际赢家的来源，不保证远端模型恰好调用一次。

当前唯一 schema 的 `processor_results` 与 `processor_collections` 保存不可变文件引用；正文在 `knowledge/results/`、`knowledge/collections/`。依赖表保护文档、材料与上游结果；外部 material-only 候选同样保留资产 hash。`processor_record_projection`、`processor_projection_state` 与两种 FTS 从已校验结果重建，不是内容真相源。普通启动只接纳当前 schema；旧 catalog 只能经明确授权的一次性副本转换，不支持迁移阶梯。

外部长期接纳是独立 `ProcessorExternalRetention`：要求完整 ExtractionSubmission，先走原交付校验，再保存完整 candidate/relations/spec/manifest/receipt 及独立长期引用。其通用记录 payload 包装为 `{record: 原 payload}`，字段指针相应加 `/record`。请求 key 的持久判同包含完整原请求 hash；回执到期后仍能返回已托管结果，不能以新内容改写同 key。

`entry/processor-operations.ts` 是 CLI/MCP 共用的只读查询/证据/导出边界；QueryApplication 不实例化模型。数字保存原串与原单位，不默默做领域换算。标签和提取按文本片段分批，保留 missing、partial 和能力限制。精确请求格式见[统一加工指南](../../guides/knowledge-processors.md)。版本事件传播过时状态而不自动重算；Web 通过同一业务合同展示结果和证据。

## 7. ADR 0037 目标形态：标签与算子输入

本节描述已接入的标签与算子输入；实际部署转换见计划 12。

### 7.1 标签词表

- 标签为领域级主题关键词，不设维度，每篇文献 1 到上限（初值 6）个，按重要性排序，第一个是主标签。
- 主要化合物必须在题名或摘要中作为研究对象出现。
- 打标流程：先写主题，再检索词表、优先吸附，确实不合适时才新建，并逐个说明理由。
- 词表变更与版本：
  - 新建、合并、设上级（最多两层）、归类、修正定义，每次变更都产生新的词表版本并写入日志，可以撤销；
  - 每批建档后自动整理；
  - 回溯只能手动执行，先显示候选数。
- 筛选可以按主标签或任一标签，上级标签包含下级；未回溯的标签会提示结果可能不完整。
- 现有 `labels` 处理器是逐篇问答，界面改称“问答标注”，与标签词表无关。

### 7.2 算子输入与复用

单篇算子：
- 输入只能是就绪文献的档案文档，按声明的部分和章节角色读取校订稿片段；
- 单篇算子之间不互相依赖；
- 片段的核对依据随片段提供；提取出的每个值由平台做一次用时核对，所有片段一律做文字比对，不调用视觉模型，结果为六种：可找到、找不到、值为空、无引用、引用片段不可用、综合值（ADR 0037 第三版；实现为 value-check.ts 的确定性文字比对，不再配置视觉核对角色）；
- 复用键 = 被读取部分的内容版本 + 算子版本 + 规范 + 方法 + 模型配置，描述版本不参与；
- 结果按值量化：字段要么有值，要么为空（null）；读取是否完整单独记录，补充材料不可用等作为缺口保留（如 `part-unavailable`）。原 `not-reported`、`part-absent` 两种状态取消（ADR 0037 第三版，实现见计划 13.23）。
- 分块：默认整篇一次调用，超过门槛（200K 与上下文窗口减预留中的较小者）才按 Markdown 结构分块，规则见 ADR 0037 第 10 节（实现见计划 13.24）。

### 7.3 快照与多篇算子

- 快照不可变，冻结每个成员各部分的内容版本和描述版本，只选取 `READY` 的文献，可以比较差异。
- 多篇算子执行两步：
  1. 用 `map` 单篇算子逐篇读取，结果可复用；
  2. 只基于单篇结果汇总，输出带引用的报告或表格。
- 版本事件会把相关结果标为过时，不会自动重算，这一点修订了 §6 的“整体综合”。
