# 05 · 知识加工技术设计

[设计总览](../design.md) · [八模块技术导航](../technical.md)

本模块对应设计中的 **⑤ 知识加工**，使用已有材料与证据，形成压缩知识或交付调用方规范下的提取候选。

内部划分为 Analysis 分析/综合和 Extraction 提取交付。Analysis 拥有局部分析、整合和知识产物验收；Extraction 校验调用方规范、候选结构、证据与提交，领域算法和科学接纳归下游。两者独立使用④的读取能力，缺材料时不调用③补库。

Agents 的共享单次模型合同集中在本篇；Browser 复用同一模型访问基础，不复制 adapter 或 limiter。[ADR 0031](../decisions/0031-dsh-backed-agent-capabilities.md)的受控 DSH 执行基础已通过私有适配接入，见 §5.1。当前旧两阶段内容路径、三种用途的单篇知识产物、单篇长文分段整合与通用提取交付已实现；集合综合已有版本化合同和合成库上的只读准备、依赖读取及发布基础，模型执行与产品入口仍属于后续切片。

本篇目录：

- [1. 模块边界与连接](#1-模块边界与连接)
- [2. 分析与综合](#2-分析与综合)
- [3. 兼容内容格式与发布](#3-兼容内容格式与发布)
- [4. 调用方规范与提取交付](#4-调用方规范与提取交付)
- [5. 共享支撑：无状态模型运行时](#5-共享支撑无状态模型运行时)

## 1. 模块边界与连接

任务②明确启动分析或接收候选；读取文档证据④；产物经存储⑦保存或按提取合同直接交付。

本篇按职责归并已有详细合同；示例中的现有类型与目标类型保持各自状态。文档归属不改变源码目录、事实所有权或当前公开 API。

## 2. 分析与综合

### 2.1 当前目标：有证据的知识压缩

依据 [ADR 0026](../decisions/0026-agent-knowledge-and-human-collaboration.md)，Analysis 的目标扩展为单篇概览/详细分析、问题相关分析和指定集合的综合。它消费 [文档与证据：可读表示与有界读取](04-document-evidence.md#3-可读表示与有界读取)，产物绑定输入版本、用途、生成方法、证据与覆盖，保留条件/局限/分歧；长文通过 DSH 分页读取完整原文并按需回查。

不同用途/粒度可共存，默认视图不等于唯一结果。元数据修正仍交 Literature 验收，分析不适用不直接删除材料；模型运行时不获得业务写入权。当前 TS 已交付单篇 `KnowledgeArtifact` v1、长文独立请求 v2、Catalog v6/v7 的单篇历史发布和只读读取，以及 v7 集合综合的有界执行、发布、来源读取和工作台入口；知识产物索引尚未实现。

以下章节保留旧两阶段单篇内容的精确合同与兼容实现背景，不再将“只有两个用例”“只有一个最终结果”“固定七标题”或 NoUsableContent 清理作为全部新目标。新科学证据与文献 ReferenceSupport 分开建模。验证需区分结构合法、引用可解析、语义支持与重要信息保留。

[ADR 0027](../decisions/0027-extraction-capabilities-and-caller-defined-records.md)新增独立 [知识加工：调用方规范与提取交付](#4-调用方规范与提取交付)责任。通用解释/压缩继续归 Analysis，调用方定义的记录和外部提取算法不扩张为 Analysis 的固定领域 schema，也不要求先有总结。

子能力、知识产物与发布建议见[统一产品接口：共享合同、结构解析与版本兼容](01-product-interface.md#6-共享合同结构解析与版本兼容)。Analysis 以已有材料/表示和明确问题为输入，缺原始材料返回缺口，应用层不能为该独立分析请求启动发现或下载；已有材料的表示准备仅按显式加工步骤执行。它不调用 Acquisition，也不以 Browser 状态判断能否分析。

### 2.2 实现结构与公开边界

旧内容路径由两个 Analysis 源文件组成，单篇和集合知识另有独立实现：

```text
apps/server/src/analysis/
  service.ts   # AnalysisService、输入读取、两阶段调用与结果
  ts-rules.ts  # 元数据保护、草稿解析、sections 与规范 Markdown 渲染
  knowledge.ts # 单篇用途、完整文档读取、证据检查、知识发布
  knowledge-session.ts # 单篇/长文共用 DSH 正文与图片阅读会话
  knowledge-port.ts # Analysis 消费的知识存储 Port
  synthesis-prepare.ts # 显式集合选择与固定来源缺口
  synthesis.ts # 文档阅读会话、集合回查会话与发布
apps/server/src/entry/content-analysis.ts  # 用例协调与旧内容发布
apps/server/src/agents/                   # 模型协议与单次执行
packages/contracts/src/content.ts        # 内容合同、规范化与 hash
packages/contracts/src/knowledge.ts      # 知识请求、内容、产物和回执合同
packages/contracts/src/synthesis-manifest.ts # 集合输入清单
packages/contracts/src/synthesis.ts      # 集合请求、内容、覆盖与回执合同
```

`AnalysisService.analyzeContent(literatureId, signal?)` 的当前返回类型是：

```ts
type AnalysisResult =
  | {
      outcome: "proposal";
      proposal: LiteratureContentProposal;
      markdownBytes: Uint8Array;
    }
  | { outcome: "no_usable_content"; input: AnalysisInputIdentity };
```

输入读取和最终发布分离。服务通过注入的 facts/artifact 读取能力固定输入，返回候选提案；Entry 协调 Literature 复检和提交。Analysis 不取得 SQL、任意文件路径或 Acquisition 调用权。

目标 Analysis 内部需要输入规划、片段分析、整合、证据检查和发布五类职责。这些可以先在现有模块内实现；不要求新增五个服务。共享单次模型层只处理一次请求；受控 DSH 执行基础也不拥有 Analysis 的分块或综合策略。

### 2.3 兼容内容分析与新知识分析

本篇“兼容内容格式与发布”一章详细规定现有两阶段 `LiteratureContent` 路径。它提供文献内容判断、最终元数据提案和规范 Markdown，保留旧 CLI、Library 和 completion 的精确兼容含义。

[ReferenceLookup](#38-referencelookup)的 `ReferenceLookup` 是引用扩展的概念合同；当前 `AnalysisService` 没有独立公开 lookup 方法，不可据此调用不存在的 API。lookup 的失败不应撤销已经接纳的正文或书目事实。

[多用途知识产物设计](#24-多用途知识产物设计)定义新 Analysis 的单篇、多用途和集合综合设计。它发布独立 `KnowledgeArtifact`，不把领域提取或任意用途结果塞进旧 `LiteratureContent`。新知识分析不要求更新书目 metadata，不继承旧内容完成态作为成功标准。

### 2.4 多用途知识产物设计

本节同时记载已实现的单篇首版、长文处理与后续综合目标。新 Analysis 与旧内容路径共享 Agents 和受控读取能力，分别拥有产物合同，不能让旧两次调用及七标题约束限制全部知识加工。

#### 2.4.1 分析请求与方法身份

```ts
interface KnowledgeAnalysisRequest {
  readonly schema_version: 1;
  readonly input: InputManifest;
  readonly purpose: "overview" | "detailed" | "question";
  readonly question: string | null;
  readonly default_update: null | { readonly expected_revision: number | null };
  /** @deprecated 读取兼容；固定输入加工不执行业务预算。 */
  readonly budget?: {
    readonly max_input_bytes: number;
    readonly max_output_tokens: number;
  };
}
```

manifest v1 恰好一项，绑定已验证的原 PDF 与精确文档表示，无缺口。问题型请求的非空问题按 NFC/去首尾空白规范化，最多 4096 UTF-8 字节。`default_update:null` 只发布历史产物；对象内的 `expected_revision:null` 表示首次设置默认，正整数表示 CAS。

按 ADR 0026 的 2026-10-12 修订，固定输入解析、总结、长文分析和综合不设置业务 token、累计调用数、累计输入字节或总时长预算。v1、长文请求 v2、综合请求 v3 均允许省略 `budget`；旧字段仍可读取，但不执行，也不影响方法复用身份。请求/响应的物理序列化边界、真实模型上下文、连接失败、取消与文件完整性仍由所属边界处理，不以这些检查证明语义正确。

方法身份包含 prompt/schema 版本、片段与整合策略、实际模型绑定和影响结果的参数。当前单篇和长文共用 `dsh-document-analysis` v1、综合方法为 v3；旧产物保持可读。复用键同时包含 manifest、purpose、question、method 与参数 hash，同一比较域并发首次发布者获胜，后来者读取实际已存内容与 provenance。

长文执行记录派发次数、序列化 ModelRequest 字节（含历史与图像 base64）及 Provider 报告的 usage；失败或缺少 usage 不伪称成本为零。计量用于解释成本，不作为停止条件。`KnowledgeAnalysisFailure.accounting` 是进程内明细，当前维护 HTTP 错误只返回安全 reason/retryable。

#### 2.4.2 输入读取与真实长文处理

旧 `service.ts` 的 LiteratureContent 阶段保留业务合同，原子请求也经 DSH 原生模型服务。知识分析的 v1/v2 请求均进入 `knowledge-session.ts`，不再执行旧单次全文或固定分块/层级归并算法。

1. 读取并验证固定文档、源材料、结构与资源身份。DSH 初始输入为任务、目录和资源清单，正文由工具读取。
2. `read_document` 按 UTF-8 安全边界返回至多 24,000 字节；`search_document` 定位片段，`read_segments` 回读选中片段及相邻内容。完整正文读取是提交前置条件，搜索预览不计覆盖。
3. `view_image` 只读取文档绑定的 PNG/JPEG/WebP，核验实际字节、长度与 hash。没有图像能力、资源不支持或超出单个 16 MiB/会话 16 图与 64 MiB 协议边界时明确报告缺口，不冒充已经看图。重复看图同样计入上下文图片容量。
4. DSH 原生循环掌握工具调用与后续阅读；`submit_result` 验证 schema、文本/图片覆盖和 segment ID，并构造绑定完整原片段 SHA-256 的 EvidenceRef。业务验收拒绝回到同一会话修正，取消或坏资源不能发布。
5. Provider 协议层拒绝畸形工具响应时结束并报告失败，不绕过安全解析。历史由 DSH 管理与压缩，保留每次推理/压缩实际派发和 usage；不以固定调用次数代替有限材料处理。

返回的结构化知识保留条件、量值、局限和分歧；中文阅读性由任务提示指导，原始材料不会被模型覆盖。覆盖只说明材料被工具返回，不保证科学准确性。

#### 2.4.3 产物结构与科学信息

`KnowledgeArtifact` v1 的公共版本与引用字段由 `packages/contracts/src/knowledge.ts` 冻结：产物含 ID、比较 hash、用途/问题、InputManifest、方法、内容引用及内容、完整覆盖和实际模型 provenance。`KnowledgeContent` 有标题和非空结构化断言列表；每条断言含类别、原文报告或推论、正文、限定条件、可空的数值/单位/比较基准及非空 EvidenceRef 列表。下表同时列出后续科学质量目标，不把结构合法等同于语义充分：

| 内容       | 应表达的信息                                               |
| ---------- | ---------------------------------------------------------- |
| 主题与目的 | 产物回答的问题、粒度、目标输入范围                         |
| 主要断言   | 概括或解释、对应证据、适用条件，明确区分原文报告与综合推论 |
| 方法与材料 | 作者使用的方法、样本/数据来源、重要假设                    |
| 结果       | 数值、单位、比较基准和不确定性，无法保留的部分明确指向原文 |
| 局限与分歧 | 作者声明、分析发现的限制、互相矛盾证据；不假装已解决冲突   |
| 覆盖与缺口 | 处理/未处理的输入和片段、读取失败、能力不足                |
| 生成来源   | 精确 manifest、方法版本、参数 hash、模型与安全 usage 来源  |

内容可以有 Markdown 展示产物，但引用和覆盖必须能由程序读取。EvidenceRef 证明可回到具体材料位置，不证明该位置足以支持结论。结构检查、引用复核、语义评估和科研有效性是不同层次。

Analysis 可以提出书目修正候选；Literature 单独验收。不允许知识发布事务顺带覆盖来源 observation，或把领域实验记录插入 LiteratureMetadata。

#### 2.4.4 单篇与跨篇综合

单篇分析固定一个具体文献版本，可以产生多个用途的结果。默认展示关系可指向一份概览，但其它合法产物仍可按 ID 读取。

集合综合接受原始文档、既有知识产物或二者的明确组合。读取既有总结时记录其 manifest 和压缩层级；需要原文复核却缺少原文时报告缺口，不补造证据。不能把摘要中未出现某数值解释成论文未报告。

例如输入 A、B、C 三篇，B 因表格不可读而失败：`require-all` 不发布“已覆盖三篇”的正式综合；`allow-partial` 可发布仅覆盖 A、C 的结果，正文与机器可读覆盖均指出 B 未处理。相反结论保留为分歧，不能按多数表决覆盖较少来源。

跨论文引用某项实验条件时，证据分别绑定各篇版本；不能使用一个 Literature ID 代表同主题所有文章。领域单位转换、科学记录合并与最终数据集仍交给调用方或下游提取策略。

当前合同以 `SynthesisInputManifest` v2 固定 1–128 个有序文档/知识输入及其 hash、层级和 `verified/source-only/missing` 状态；`KnowledgeSynthesisRequest` v3 固定非空问题与覆盖政策，历史 `budget` 可省略且不执行。准备服务固定清单，执行前重新核对；`require-all` 缺项或 `allow-partial` 零可用返回 blocked。精确重复来源复用局部候选，逐项保留证据关系；无相关断言的输入照实计覆盖与 usage，全集不适用返回 `synthesis-not-applicable`。

最终由 DSH 综合会话整合候选，可用 `read_candidate` 和 `read_evidence` 回读固定原文；knowledge-only 输入明确标记来源层级。模型负责共识、分歧、条件与数值的语义表达，可以改写、压缩及让一个来源支持多条结论；程序只要求来源 ID 真实且输出结构可读。单条分歧或同一论文内的共识不因数量规则被拒绝。坏引用、坏结构、取消、模型失败或实际协议大小超限仍不发布。发布时按引用链计算实际独立 Literature 数，不从模型的关系标签推断论文数。

`SqliteSynthesisStorage` 对合成库 v7 的已发布综合按 ID 验证内容、SQL 依赖与递归证据闭包，并支持经证实原 PDF 文件缺失时的 `source-only` 投影。此状态还要求派生 Markdown、结构和资源文件完整；派生文件缺失、路径异常、权限错误或 hash 损坏均拒绝。`source-only` 不改变旧单篇严格 reader 的成功条件，也不代表原文已经复核。来源计数沿每条候选实际引用的断言链去重，表达实际支持来源数，不等于已处理文献篇数；同一 Literature 的重复版本或其摘要不能充作独立支持。模型归并输入显式列出经证据验证的独立 Literature ID、原文/知识来源、压缩层级与 source-only 状态。原文字节完整性、模型输出遵循结构约束、断言确由证据支持、科研结论质量是逐层不同的判断；当前结构与引用验证不等于后两层科研语义验收。正式 Application、HTTP 和 Web 入口见[产品接口](01-product-interface.md)。

准备过程在首次异步读取前固定调用方选择，批内共用只读会话与缓存；重复材料和精确版本闭包复用验证。固定输入加工默认不设累计验证字节预算；读取/检索调用方显式给出的读取边界仍按对应合同执行。原 PDF 缺失的 `source-only` 不表示派生证据损坏，也不表示已经重新核验原文。递归依赖、hash、版本、不可变文件和真正的独立来源计数仍由存储 reader 检查。

#### 2.4.5 发布、默认视图与失败

发布先固定完整字节和依赖，再由 Analysis 发布 Port 通过 Storage 执行 create-if-absent 和短事务登记。事务中验证输入仍存在、hash 正确且未失效；不要求明确选择的历史版本仍是 current。设置默认视图时另检查期望的当前关系，避免迟到结果顶替新结果。

当前 v6 单篇 writer 先不可变保存规范内容 JSON，再在同一 Catalog worker 的事务中复核并登记产物、材料和文档精确依赖；不同字节不会覆盖已接纳对象。默认指针以 Literature ID、用途及问题 hash 分域，在另一事务按 `expected_revision` CAS。回执始终含已提交产物与原 provenance；默认更新另以 `default_update_outcome` 区分未请求、更新成功、CAS 冲突、排队取消和失败，并以 `default_updated`、实际 `default_revision` 及安全的 `default_update_failure` 一致表达结果。已发送 SQLite 的写入按真实事务结果结算，后续取消或失败不撤销已提交产物。模型错误保留稳定的 Agent reason、retryable 和异常 cause；畸形的 `not_applicable` 响应不能被当成有效不适用。QueryApplication 拥有只读 `knowledgeRead.byId/list/default` 生命周期，关闭时先等待这些读取，再关闭 DocumentRead、FileStore 和数据库；按 ID 读取会复核内容字节、manifest、依赖和片段证据闭包。旧 `LiteratureContent` reader 和元数据 owner 不变。当前不做知识文本索引或自动选择默认产物。

| 结果                                   | 含义与处理                                                 |
| -------------------------------------- | ---------------------------------------------------------- |
| completed                              | 产物、内容和依赖均已提交，可按精确 ID 读取                 |
| partial                                | 调用方允许的部分处理；产物显式记录缺口，不能投影成全集完成 |
| not-applicable                         | 输入存在但不适用于指定问题/方法；不删除材料                |
| missing-input / unsupported-capability | 返回具体缺口，不自动获取或调用别的模型补齐                 |
| invalid-evidence / input-invalidated   | 不发布新产物，保留此前已提交事实                           |
| cancelled / model-failed               | 返回实际完成边界，未发布草稿不当作最终知识                 |
| publication-failed                     | 保留旧默认结果；文件孤儿按维护对账处理，不伪称成功         |

这些是新领域结果的语义分类，精确 wire code 应在版本化 adapter 中定义，不能改写既有 `agent-*` 和 `analysis-*` 错误码。知识产物的历史读取和回收遵循 Storage/Document 的依赖保护；一次分析失败不改变材料可用性。

#### 2.4.6 验证设计

除[兼容内容路径的验收](#310-兼容内容路径的验收)兼容用例外，新分析需用可复核的合成文档证明：长文确实发生局部调用与整合；末尾章节不会静默消失；同材料不同问题不误复用；表格单位、否定句、实验条件和相反结论能被追溯；重解析后旧 EvidenceRef 仍定位原版本。

集合测试应同时检查 `require-all` 与 `allow-partial`，以及取消/发布失败后既有事实保留。质量评估需要代表性的人工标注断言与证据，不能以 Markdown 标题齐全或模型自行打分代替知识压缩质量。

## 3. 兼容内容格式与发布

### 3.1 内容分析输入与输出

内容分析公开输入只包含：

- 当前具体 `Literature` 的中性引用；
- 当前主 PDF ID 与 SHA-256；
- 对齐该 PDF 且通过 Parsing 检查的 `ParserResult`；
- 当前统一初始 `LiteratureMetadata` 及其 revision/hash；
- Analysis prompt/schema 版本和取消信号。

PDF 绝对路径、SQL row、MinerU 私有输出、HTTP response 和 provider SDK model 不进入公开 API。

Analysis 通过 `ParserResult.markdown` 的 artifact hash 从 Storage 读取完整 UTF-8 Markdown，并核对实际字节与 ParserResult hash。`ParserResult.resources` 当前用于保证中间文档引用完整；文本 LLM 不要求接收图片，Analysis 也不能因为资源存在就隐式启用多模态调用。

第一阶段输出是封闭的二选一结果：

```text
NoUsableContent
  outcome: Literal["no_usable_content"]

FinalMetadataProposal
  outcome: Literal["usable"]
  metadata: LiteratureMetadata

MetadataAnalysisResult = NoUsableContent | FinalMetadataProposal
```

`NoUsableContent` 没有评分、置信度或详细原因；`FinalMetadataProposal` 直接复用 `LiteratureMetadata`，不建立平行元数据类型。LLM provenance 由程序补充，不要求模型输出。

完整内容分析对外仍是封闭二选一：

```text
ContentAnalysisResult =
    NoUsableContent
  | LiteratureContentProposal
```

`NoUsableContent` 必须由第一阶段模型明确表达并通过结构校验。`LiteratureContentProposal` 至少携带待 Literature 验收的最终 `LiteratureMetadata`、解析后的有序 `LiteratureSection[]`、允许为空的有序参考文献文本、输入 PDF/ParserResult/metadata hash，以及形成最终单一 Analysis provenance 所需的 provider/model、prompt 版本和有效参数信息。它是两阶段全部成功后形成的临时交换结果，不作为独立产品事实长期保存，也不形成新的 `LiteratureContentLineage`。其中的最终元数据不是 `MetadataObservation`；只有 Literature 整体接纳后才替换单一当前 `LiteratureMetadata`。

### 3.2 两阶段逻辑分析

普通长度文献固定使用两次有序核心 LLM 请求：

1. **元数据确定请求**
   - 输入当前统一初始 `LiteratureMetadata` 和经过验证的完整 `ParserResult`；
   - 先判断是否具有实际文献内容；
   - 内容有效时输出结构化最终 `LiteratureMetadata`，其中包括最终关键词和原文摘要；
   - 已有非空元数据由程序保留，模型提案用于补齐缺失字段；模型对已知值的改写不会使总结失败，也不会覆盖已接纳事实；
   - Analysis 验证 schema、标识符格式、输入对应关系和响应完整性；最终业务接纳规则仍由 Literature 验证。
2. **内容总结请求**
   - 只在第一阶段成功后发起；
   - 输入同一 `ParserResult` 和第一阶段已经通过结构验证的完整最终元数据；
   - 输出正文与参考文献的内容 Markdown 草稿；
   - 总结研究背景与目标、研究方法、数据、结论与局限性，在固定结构不足时补充必要正文标题，并按原文顺序识别参考文献文本。

第二阶段必须实际收到第一阶段确定的完整 `LiteratureMetadata`，不能只收到 metadata hash、供应商初始元数据或再次自行推断的摘要。它不得重新生成标题、作者、关键词、摘要或其它元数据。两次请求是一个 Analysis 业务用例的两个内部阶段，对公开 API 仍只返回 `NoUsableContent` 或一份完整 `LiteratureContentProposal`。

每个阶段只构造一个独立 `AgentCall`，不在 Provider adapter 内隐藏分段、汇总或额外模型调用。
Bootstrap 只要求选定可用的 Analysis Model，不要求填写阶段或总量预算。两次调用均不设置业务输出 token 上限或整项 deadline；已有 `AnalysisLimits` 只保留调用兼容。长文分块属于显式知识分析 v2，由 Analysis 拥有，不进入 Agents adapter。真实网络/协议失败仍保留 PDF，不发布第一阶段部分结果。

#### 3.2.1 第一阶段的作者处理

作者属于第一阶段最终 `LiteratureMetadata`，不由第二阶段正文草稿再次生成。第一阶段可以根据 PDF 明确内容：

- 识别作者署名顺序并清理断行与多余空格；
- 区分个人作者、机构作者和协作组；
- 提取 PDF 明示的 ORCID；
- 根据 PDF 明确的上标、编号或其它对应关系，把作者与署名单位连接起来；
- 在作者能够无歧义对齐时，保留输入统一初始 metadata 已有的 ORCID 和 ROR。

第一阶段不能根据姓名猜 ORCID、根据单位名称猜 ROR、把展示名按空格机械拆分为姓和名、翻译姓名、猜测缺失单位、模糊合并作者，或在对应关系不明时把全部单位分配给全部作者。无法可靠形成 `given_name`、`family_name`、ORCID、单位或 ROR 时保持字段缺失；`display_name` 和实际署名顺序仍须保留。Analysis 只形成这篇具体 Literature 的最终作者列表，不建立跨文献 Author 身份。

### 3.3 实际内容判断

- 判断对象是当前 `ParserResult` 是否包含属于目标 Literature、足以说明该文献实际研究、论证、综述、讨论或报告了什么的内容；
- 只有封面、目录、标题与元数据、摘要、访问提示、错误页、下载说明，或者内容明确属于另一篇文献时，可以判定为不可用；
- 页数不能单独决定有效性；完整的一页短文、通信、评论、更正或技术说明仍可通过；
- 明确具有内容时，第一阶段必须同时返回一份结构完整的最终 `LiteratureMetadata`；
- PDF 可能具有正文但 ParserResult 乱码、截断、只剩资源引用或不足以判断时，属于 Parsing/Analysis 失败，必须保留 PDF；
- 缺字段、拒答、未知结构、Markdown 解析失败、artifact/hash 校验失败或输入不对齐都属于 Analysis 失败，不是“没有实际内容”。

归档 Python 路线曾由 `EntryContentAnalysis` 注入 `NoUsableContentCleanup`，属于历史行为，不是活动 TypeScript API。当前 `ContentAnalysisService` 没有 cleanup 注入参数或删除权限；明确无内容只返回本次分析结果，不发起清理。独立分析中“不适用于问题”“解析质量不足”“没有提取到记录”均保留原资产；确属无效材料也必须由 Acquisition/Literature 的独立验收与依赖处理决定处置。第二阶段失败不能推翻第一阶段判断或触发清理。

### 3.4 内容 Markdown 草稿合同

第二阶段草稿只包含正文与参考文献，固定一级标题及顺序为：

```markdown
# 研究背景与目标

# 研究方法

# 数据

# 结论与局限性

# 参考文献
```

以上标题是生成提示和最终旧格式的规范化目标。读取模型草稿时接受普通 Markdown、缺失或重排的标题、附加章节及更深层标题；程序整理为四个旧 section role，缺失 role 填“未提供”，附加正文保留，更深标题作为正文文本。参考文献接受列表或普通文本，不要求模型精确复制排版。

空结果、NUL、只有标题没有正文及输入 hash 不符属于明确错误。标题、摘要、数值、公式和参考文献应忠于原文，但程序不以数字子串、原文逐字匹配或固定措辞宣称科学正确或据此拒绝发布。

### 3.5 结构化最终元数据与固定渲染块

第一阶段直接返回 `LiteratureMetadata` 结构化数据，不返回 Markdown，也不让 Analysis 从自由文本反向解析元数据。最终规范 Markdown 的 `# 元数据` 项目名称与顺序固定为：

```markdown
- Title:
- Authors:
- DOI:
- Other Identifiers:
- Publication Date:
- Year:
- Document Type:
- Language:
- Venue:
- Publisher:
- Volume:
- Issue:
- Pages:
- Keywords:
```

程序 renderer 不得增删、改名或重排项目。可选字段在结构化 metadata 中使用 `None`，关键词缺失使用空 tuple；最终 Markdown 一律渲染精确字符串“未提供”，不能使用空字符串、`unknown`、`N/A`、`null`、`None` 或其它自然语言。字段映射遵守：

- DOI 映射到 `LiteratureMetadata.identifiers` 中 namespace 为 `doi` 的标识符；
- Other Identifiers 只包含非 DOI 稳定标识符；
- Authors 和 Keywords 使用第一阶段结构化结果中经过验证的顺序；
- Authors 或 Keywords 整体缺失时相应固定项显示“未提供”；
- Abstract 不进入元数据块，而由 renderer 从 `LiteratureMetadata.abstract` 写入独立的 `# 摘要`；值为 `None` 时显示“未提供”；
- URL、开放获取、许可证、引用计数、供应商、状态和 provenance 一律拒绝进入元数据块。

第一阶段返回完整 metadata，不返回字段级 patch。摘要、页码或其它值只有在统一初始 metadata 已有可靠值，或 PDF 中能够找到明确依据时才能进入最终提案；不得根据常识补写。所有已有非空字段保留，模型只补空；模型提案中的其它改写不会中断总结。metadata provider 和 bibliographic import 的身份继续由 `MetadataObservation.provenance` 表达，不能混入 `publisher`。Literature 验收时以该完整提案建立新的 metadata revision，并保留全部来源 observation。

Authors 项由程序从最终 `LiteratureMetadata.authors` 确定性渲染，不使用自由文本占位。例如：

```markdown
- Authors:
  1. Ada Lovelace
     - Kind: person
     - Given Name: Ada
     - Family Name: Lovelace
     - ORCID: 0000-0002-1825-0097
     - Affiliations:
       1. Analytical Engine Institute
          - ROR: 03yrm5c26
```

每位作者始终渲染 `display_name` 和 `kind`；`given_name`、`family_name`、ORCID、Affiliations 及单位 ROR 只在结构化值存在时渲染。作者与单位顺序保持不变。第二阶段不接收独立 Authors 草稿，也不能覆盖第一阶段已经确定的结构化作者。

最终 metadata 仍必须满足 Literature 的最低接纳规则：非空标题或 DOI 至少存在一个。`document_type` 保持开放字符串，`pages` 原样表达传统页码范围或来源使用的电子文章定位号。

供应商声明关键词仍留在 `MetadataObservation.declared_keywords`。Analysis 形成的最终关键词只进入 `LiteratureMetadata.keywords`，使用扁平列表表达文献的核心领域、问题、方法、对象、材料、理论或贡献，不要求维度齐全。测试、benchmark、对照、背景或次要案例中的术语不能机械成为关键词；不建立其它平行分类、关键词或标签结果。

### 3.6 LiteratureSection 与参考文献

正文统一解析为一个有序 `LiteratureSection[]`，精确结构为：

```text
LiteratureSubsection
  title: str
  markdown: str

LiteratureSection
  role: LiteratureSectionRole
  title: str | None
  markdown: str
  subsections: tuple[LiteratureSubsection, ...]

LiteratureSectionRole =
    "background-and-objectives"
  | "methods"
  | "data"
  | "conclusions-and-limitations"
  | "additional"
```

四个固定角色各出现一次并保持相对顺序，`title = None`，展示标题由 renderer 决定。`additional` 可以出现零到多次，必须携带非空自定义 title。所有固定和额外 H1 处于同一序列，当前规范化将固定角色按顺序放置，再保留附加章节的相对顺序；不能使用 `other: dict`、动态未声明字段或脱离主序列的 `additional_sections` 袋子。

程序用 H1/H2 组织旧格式，更深标题保留为正文。每个 H1 在首个 H2 前的直属内容保存在 `LiteratureSection.markdown`，每个 H2 的内容保存在 `LiteratureSubsection.markdown`；段落、列表、表格、公式和代码块不再细拆。固定 section 有实际内容时必须具有非空 H1 直属 Markdown 或至少一个有内容的 H2；只有 H2 有内容时 H1 的 `markdown` 可以为空字符串。整体没有相关信息时使用 `markdown = "未提供"` 和空 subsections。额外 section 没有内容时不创建。旧 LiteratureContent 合同不建立 block/bbox/source-locator 图；新 KnowledgeArtifact 使用独立 EvidenceRef，不能从旧 summary 反推坐标。正文与最终文档通过单一 Analysis provenance 的输入 hash 回溯到 PDF、ParserResult 和最终 metadata。参考文献单独保存；附加正文标题不形成权威元数据。

参考文献独立保存为：

```text
LiteratureContent.references: tuple[str, ...]
```

第二阶段草稿的固定语法为：

```markdown
# 参考文献

1. 第一条参考文献原文
2. 第二条参考文献原文
```

一项有序列表元素对应 PDF 中一条非空参考文献原文。程序去掉编号后保持引用顺序；标题、作者或 DOI 缺失时仍保存已有文本，不建立残缺的第二文献元数据，也不补写 PDF 未表达的信息。没有可识别参考文献时保存空 tuple，规范 Markdown 显示“未提供”；该字符串不能解析成参考文献。文档导出直接读取这些原文，不依赖引用目标是否已经解析。

### 3.7 两阶段验收与规范 Markdown 发布

Analysis 按顺序执行：

1. 验证第一阶段的明确无内容决定或结构化最终 metadata 二选一；
2. 内容有效时，验证最终 metadata，并把它与同一 ParserResult 一起交给第二阶段；
3. 读取第二阶段 Markdown，规范化旧 section 结构，保留附加正文与参考文献；
4. 解析有序 sections 和 references；
5. 验证标识符、输入 PDF/ParserResult/初始 metadata hash，并形成最终单一 Analysis provenance 所需信息；
6. 形成包含最终 metadata 的封闭 `LiteratureContentProposal` 交给 Literature。

Literature 负责确认提案属于当前具体 Literature、当前主 PDF 和当前 metadata revision，验收最终 `LiteratureMetadata`，并接纳 `LiteratureContent`。接纳在同一事务中递增当前 metadata revision 并替换当前 metadata/content/Markdown；旧统一元数据不形成历史，全部来源 `MetadataObservation` 不受影响。随后程序从已验收 metadata、sections 和 references 确定性渲染具有七个固定 H1 的规范 Markdown：`# 元数据` 从最终 metadata 渲染，`# 摘要` 从 `metadata.abstract` 渲染，正文与参考文献从第二阶段已解析内容渲染。不会再请求 LLM 复制元数据或组装另一份 Markdown。

最终精确合同为：

```text
ArtifactRef
  sha256: Sha256
  media_type: str
  byte_size: int

LiteratureContent
  literature_content_sha256: Sha256
  metadata_revision: int
  metadata_sha256: Sha256
  sections: tuple[LiteratureSection, ...]
  references: tuple[str, ...]
  markdown: ArtifactRef
  provenance: Provenance
```

规范 Markdown artifact 的 `media_type = "text/markdown"`，字节固定为 UTF-8。`literature_content_sha256` 只覆盖 `metadata_sha256`、`sections` 和 `references` 的规范序列化，不包含 metadata revision、provenance、模型、时间、路径、Markdown hash 或数据库 ID；`markdown.sha256` 只覆盖最终 Markdown 字节。

`provenance` 只有一项，`source_kind = "analysis"`，`source_name` 是 provider/model 标识，`input_sha256` 覆盖 PDF hash、ParserResult hash 和最终 metadata hash，`parameters_sha256` 覆盖 prompt 版本与有效模型参数，`observed_at` 是总结完成时间。Parser provenance 留在 ParserResult，不复制到 LiteratureContent；不保存两个请求的独立 provenance、完整 prompt/request/response、task ID、endpoint、GPU 或机器路径。

第一阶段 metadata 提案和第二阶段内容草稿都不单独持久化。规范 Markdown 使用 create-if-absent 发布；每个 Literature 只保留一个当前 LiteratureContent。后续 metadata 或内容变化时先完整生成、验证并由 Literature 接纳新结果，再原子替换当前关系；失败保留旧结果。旧兼容存储不提供结构化内容历史；这不授权回收新知识产物已经依赖的版本，新依赖建立后按 Storage 的保护规则保留。最终 metadata、keywords、sections、references、artifact 关系、旧 content support 清理和 `CONTENT_READY` 依据作为一个逻辑更新整体提交。

替换当前 content 时删除指向旧 `literature_content_sha256` 的 `ContentReferenceTextSupport`；某条 Reference 因而没有其它 support 时一并删除。新 references 后续按普通 lookup/Reference 流程处理，`ProviderRelationSupport` 和 `MetadataReferenceTextSupport` 不受影响。当前内容丢失、损坏或输入不再对齐时，可以从权威元数据和当前 PDF 重新生成。

### 3.8 ReferenceLookup

引用扩展操作只接收一组有稳定顺序的参考文献原文及其来源上下文。Analysis 可形成：

```text
ReferenceLookup
  reference_index: int
  identifiers: Identifier[]
  title: str | None
  authors: str[]
  publication_year: int | None
```

`reference_index` 只定位本次输入列表中的原文。LLM 只提取原文明示的搜索线索；至少存在一个可校验稳定标识符或非空标题时才返回可执行 lookup。代码验证并规范化 DOI、PMID、arXiv ID 等明确格式。Lookup 由 Entry 立即用于本地精确查询或 Metadata 搜索，不持久化、不写入 `LiteratureContent`，也不能直接创建目标 Literature、Reference 或 ReferenceSupport。

### 3.9 Agents、Network 与失败

Analysis 把元数据确定、内容总结和 ReferenceLookup 三种私有请求语义分别转换为带 Analysis role、messages、strict response schema、input hash 的 `AgentCall`，不要求业务 `max_output_tokens`；前两种仍属于同一个文献内容分析用例的有序内部阶段。Analysis 直接调用 `DshAgentRuntime.execute`，先验收第一阶段，再决定是否构造第二阶段。Runtime 负责 role-to-model binding、凭据附着、capability、连接/停滞 timeout 与协议大小边界、quota、协议响应和安全 provider/model/usage 身份；Analysis 负责把这些安全身份与 prompt/参数 hash 组成一项业务 provenance。单次调用和两个阶段的临时信息只用于当前业务调用，不形成两项持久化 provenance。

Analysis 不拥有 `AnalysisLLMPort`、provider adapter、model 选择、Session、重复配置或旧兼容导入。Agents 请求成功只说明协议边界完成；Analysis 仍解析 duplicate-free finite JSON、验证 LiteratureMetadata/Markdown/ReferenceLookup schema、复检输入 hash 和 stale 状态。所有外部访问由 Agents adapter 经过 Network 的 URL、TLS、redirect、共享 quota、单次响应上限和脱敏政策；Analysis 和 Browser 使用同一 provider/account scope 时不能各自建立 limiter。

Bootstrap 解析 `[analyze].model` 的完整 `provider/model` 引用，从 `[models]` 取得 reasoning，
从 `[providers]` 取得 API 与 Base URL，并在同一 Agents runtime 中为 Analysis role 冻结满足
structured-text capability 的 binding。OpenAI Responses、OpenAI Chat Completions 或 Anthropic
Messages adapter 按 Model Provider 的 `api` 选择；strict structured output、text-only、no-tool、
context/output 与单次调用限制由 Analysis/Bootstrap 派生，不由用户在 Model 上重复声明。API key
来自 `credentials.toml.[providers.<provider>]` 并与规范 origin 精确绑定。Analysis 不提供
task-level model、reasoning 或 capability override。远程 Provider 必须使用 hostname-based HTTPS
与 API key；HTTP loopback Provider 可以无认证。
Agents adapter 不从 UTF-8 bytes 推断 token；context 只根据 Provider 返回的实际 usage 在 Runtime
结果边界验证。跨 origin redirect 不携带认证。

`config test analyze` 复用这里的生产 adapter，但只发送固定的极小 strict-schema probe，不发送
用户 Literature 或 PDF 内容、不构造 Storage、不持久化结果。它可能消耗少量额度，因而
人类 CLI 在执行前确认；详情通过中性 `CoreConfigurationProbeResult` 返回。

Timeout、认证失败、限流、拒答、截断、未知结构、Markdown 不合格、artifact/hash 校验失败或输入 stale 时：

- 返回稳定、脱敏的 Analysis 失败；
- 保留当前 PDF 和以前已经接纳的有效内容；
- 不形成 `NoUsableContent`；
- 不长期保存第一阶段 metadata 提案或第二阶段待验收草稿；
- 后续运行可以重新分析。

失败 owner 保持分层：metadata/content 任一 Agent 调用返回 `agent-cancelled` 时，内容分析统一形成
`analysis-content-cancelled`，Entry 将最终 disposition 记为 interrupted；authentication、permission、
quota/rate、timeout/transport、model、refusal、truncation 及 `agent-internal` 等稳定 `agent-*`
保留原 code、reason、action 与 retryable，不再包装成泛化 `analysis-*-llm`。只有 Analysis 自己的
input、schema/structure、metadata/content validation、stale、render、artifact read/publication 才形成
具体 `analysis-*`；未知本地实现异常稳定成为 non-retryable `analysis-internal`。

正常 INFO transcript 由 Analysis 依次记录 metadata stage、content stage 和 Markdown publication
的 started/finished，由 Agents Runtime 记录每次真实模型调用的 role/provider/wire model、usage、
elapsed 或稳定失败。第一阶段成功而第二阶段、stale 检查或 publication 失败时，不发布或接纳任何
第一阶段部分结果。协议、capability 和安全大小等 adapter 细节只进入 Debug。

Secret、完整请求 header、底层 SDK 对象、prompt 原文和未脱敏异常不得进入 Model、provenance、持久化结果或用户输出。

### 3.10 兼容内容路径的验收

直接测试至少覆盖：

- 普通有效文献严格按顺序执行两个核心 fake LLM 请求，第二次收到第一次确定的完整 `LiteratureMetadata`；
- 第一阶段只接受精确 `NoUsableContent` 或 `FinalMetadataProposal`；明确无内容时不执行第二阶段，且与任一阶段调用/结构失败严格区分，生产对象图不注入旧兼容清理；独立分析的两个分支都不产生材料删除命令；
- 只有封面、目录、标题/元数据/摘要、访问或错误提示以及明确错文献可判无内容；一页完整短文可以有效，ParserResult 乱码、截断、只有资源引用或无法判断必须保留 PDF；
- 第二阶段普通 Markdown 规范化为旧 section 合同；
- 缺失、重复或重排标题及 H3 可接纳；空正文、NUL 或明显类型错误拒绝；
- 第一阶段结构化结果精确形成 `LiteratureMetadata`，摘要只来自 `LiteratureMetadata.abstract`；
- 第一阶段保留已有非空元数据并补缺，模型改写已有值不阻断；
- 第一阶段能够保留作者顺序、机构作者、明确 ORCID 及作者—单位映射；缺失值保持缺失，不猜测 ORCID/ROR、不机械拆名、不模糊合并或把全部单位分给全部作者；
- Authors 块只由程序从最终结构化 `Author[]` 确定性渲染，可选字段仅在存在时输出，第二阶段不能产生或覆盖作者元数据；
- 最终关键词与供应商 `declared_keywords` 分离，且不存在平行分类或标签结果；
- 四个固定 `LiteratureSection` role 恰好各一次，章节和 H2 使用 Markdown 字符串，额外章节保留相对顺序和有序 H2；固定内容缺失使用“未提供”，无内容额外章节不创建；
- 参考文献有序列表按 PDF 顺序保存非空文本，缺标题或 DOI 时不编造；没有参考文献时为空 tuple 且渲染“未提供”，缺失标记不成为一条引用；
- 允许数值、单位与公式的正常改写，保留字段类型和实际版本/hash 绑定检查；
- Literature 验收后由程序确定性渲染七个固定 H1 的 metadata、摘要、正文和参考文献，LLM 不被再次调用；
- `literature_content_sha256` 只覆盖 metadata hash、sections 和 references，Markdown hash 只覆盖 UTF-8 字节；单一 Analysis provenance 对齐 PDF、ParserResult、最终 metadata、模型和 prompt/参数 hash；
- 每个 Literature 只有一个当前 LiteratureContent，新结果失败保留旧结果，成功替换时清理旧 content support 及因此无 support 的 Reference；
- stale 输入或 Storage 失败不留下部分最终 metadata/content；
- `ReferenceLookup` 只提取原文明示线索，不持久化或直接建关系；
- 超出 Analysis/Bootstrap 派生单次调用边界的文献稳定失败并保留 PDF，不截断输入、隐藏分段或发布部分结果；
- 两阶段分别构造独立 `AgentCall`，第一阶段未通过业务验收时不执行第二次 Runtime 调用；ReferenceLookup 空输入不调用模型；
- metadata/content 任一模型阶段取消都形成 `analysis-content-cancelled` 并由 Entry 报告 interrupted，
  不调用后续阶段或发布内容；
- 稳定 Provider/Runtime `agent-*` failure 保留 code/retryable，Analysis 本地未知异常形成
  non-retryable `analysis-internal`，两者不互相冒充；
- INFO 中 metadata、content、Markdown publication 与 role-level Agent call 各有单一 owner，
  第二阶段或发布失败时没有部分结果；
- Analysis 不直接导入 Agents provider adapter/vendor SDK，Agents 不拥有文献 request kind、prompt/schema 或结果验收；
- vendor 类型、secret、prompt 和未脱敏错误不进入公开 API、Model 或持久化结果。

测试使用 fake LLM 和构造的 ParserResult，不调用真实模型或用户语料。

### 3.11 内容产物字段与约束

第一阶段内容判断结果的精确结构为：

```text
NoUsableContent
  outcome: Literal["no_usable_content"]

FinalMetadataProposal
  outcome: Literal["usable"]
  metadata: LiteratureMetadata

MetadataAnalysisResult = NoUsableContent | FinalMetadataProposal
```

`NoUsableContent` 不接受评分、置信度或详细原因；`FinalMetadataProposal` 直接复用 `LiteratureMetadata`。只有 Analysis 可以解释该联合的业务含义，Model 只验证判别值与字段结构。

`LiteratureContent.references: tuple[str, ...]` 保存按 PDF 顺序识别的非空参考文献文本，允许空 tuple，不嵌入临时 `ReferenceLookup` 或权威 `Reference`，也不携带完整性字段或逐条 source locator。“未提供”只是空 tuple 的最终 Markdown 渲染值，不能进入 references。`ReferenceLookup` 只在一次引用目标检索中交换，不持久化或进入 `LiteratureContent`。正文、参考文献和最终文档的来源由单一 Analysis provenance 的输入 hash 在文档级表达；Parser provenance 留在 ParserResult。

`LiteratureContent` 的最小结构为：

```text
LiteratureContent
  literature_content_sha256: Sha256
  metadata_revision: int
  metadata_sha256: Sha256
  sections: tuple[LiteratureSection, ...]
  references: tuple[str, ...]
  markdown: ArtifactRef
  provenance: Provenance

ArtifactRef
  sha256: Sha256
  media_type: str
  byte_size: int

LiteratureSection
  role: LiteratureSectionRole
  title: str | None
  markdown: str
  subsections: tuple[LiteratureSubsection, ...]

LiteratureSubsection
  title: str
  markdown: str

LiteratureSectionRole =
    "background-and-objectives"
  | "methods"
  | "data"
  | "conclusions-and-limitations"
  | "additional"
```

四个固定 role 各出现一次且保持相对顺序，`title` 为空并由 renderer 使用系统标题；`additional` 可出现零到多次，`title` 必须非空。全部 H1 共用同一个 `sections` 序列，H2 保存在所属 section 的有序 `subsections` 中。`markdown` 保存对应 H1 或 H2 下的 Markdown 字符串，段落、列表、表格、公式和代码块不拆成更多 Model。固定 section 有内容时必须具有非空 H1 `markdown` 或至少一个有内容的 subsection，只有 H2 内容时 H1 `markdown` 可以为空；整体没有相关信息时使用精确字符串“未提供”和空 subsections。额外 section 没有实际内容时不创建。`# 元数据`、`# 摘要` 和 `# 参考文献` 不进入 sections：前两者从第一阶段形成并最终验收的 `LiteratureMetadata` 渲染，后者来自第二阶段解析出的 `references`。

`ArtifactRef.media_type` 对规范 Markdown 固定为 `text/markdown`，字节固定为 UTF-8。`literature_content_sha256` 只覆盖 `metadata_sha256`、`sections` 和 `references` 的规范序列化，不包含 `metadata_revision`、provenance、模型、生成时间、文件路径、`markdown.sha256` 或数据库 ID；`markdown.sha256` 只覆盖最终 Markdown 字节。`provenance` 的 `source_kind` 固定为 `analysis`，`source_name` 是 provider/model 标识，输入 hash 覆盖当前 PDF、ParserResult 和最终 metadata，参数 hash 覆盖 prompt 版本与有效模型参数。LiteratureContent 不接受 `LiteratureContentLineage`、两次调用的 provenance tuple 或 Parser provenance 副本。

`LiteratureContent` 只表示已经接纳的最终当前内容。Analysis 的临时提案携带作为 stale 复检依据的输入 metadata revision/hash，但不预先分配权威 revision，也不发布 `LiteratureContent`；Literature 在最终 metadata、sections、references 和规范 Markdown 整体接纳的同一事务中递增当前 metadata revision，并把该 revision/hash 写入最终 `LiteratureContent`。因此这两个字段始终指向实际用于渲染同一份 Markdown 的已接纳当前元数据，而不是 Analysis 的输入 revision、历史元数据或未持久化提案。Model 不增加 current flag 或历史字段；每个 Literature 一个当前 metadata/content 视图及其原子替换由 Literature/Storage 约束。

### 3.12 Analysis 两阶段执行

显式 `analysisRuntime` 从配置组装 `app.analysis`；只要求有效的 analysis 模型。
`analyzeContent(literatureId, signal?)` 读取正式 Parser Markdown，调用 TypeScript AnalysisService，保留已有 metadata、规范化普通 Markdown 并使用 canonical Markdown renderer。DshAgentRuntime 直接执行中性模型 adapter 和不可变 Markdown 发布，不启动子进程。
`app.contentAnalysis.analyzeCurrent(id, signal?)` 已连接 Analysis Proposal 与 Literature owner 接纳，成功返回
正式内容；明确无可用内容返回独立结果与闭合 `AnalysisInputIdentity`，保留 PDF 与 ParserResult；普通失败也保留原事实。关闭入口取消并
等待当前调用。旧清理服务可显式调用，但生产 Analysis 不调用，见
[Entry 接纳证据](../../../migration/evidence/runtime/content-analysis-entry.md)。

`app.literatureCleanup.cleanup(noUsableResult, signal?)` 已提供基于完整当前事实 token 的 catalog 清理。
Literature 验证输入、内容与 FTS 并决定引用支持清理，Storage 在同一事务再次核对闭合后移除对应关系和
无引用对象登记。结果 `catalog_cleaned` 不等于物理文件已回收；调用方可将返回描述符交给 `app.artifactReclaimer.reclaim`，
它在共同准入内重新检查正式/execution 引用并隔离验证后删除。
`app.noUsableContent.cleanup` 将 Acquisition 的准确 Candidate/receipt 清理决定与 Literature 决定交给同一
Storage 事务，再忘记 Browser 缓存并回收文件。生产 `contentAnalysis` 不自动调用该清理服务；旧显式路径成功返回 `no_usable_content_cleaned`，回收失败报告已提交与待重试描述符。SQL 提交前先持久化仅含技术
描述符的回收清单，Application 启动时通过 `artifactRecovery.recover()` 重新核对引用并恢复，完成后删除清单；
见[重启恢复](../../../migration/evidence/runtime/artifact-recovery.md)。其它历史孤立文件扫描与后续候选重试仍待接入，
详见 [NoUsableContent Entry](../../../migration/evidence/runtime/no-usable-content-entry.md) 及 [NoUsableContent 清理证据](../../../migration/evidence/runtime/no-usable-content-cleanup.md)。

三种模型 adapter 使用各自的 JSON-schema、工具、图片和鉴权字段；Chat 接受 nullable usage 分片，
Responses 以完成事件为准并允许可选 DONE 标记。Analysis 参数 hash 标识版本化的 TS 调用参数 manifest，
不宣称与 Python vendor wire 参数 hash 相同。验证与限制见
[Analysis 执行证据](../../../migration/evidence/runtime/analysis-execution.md)。

`app.completion.complete({ literature_id, transfer_ids }, signal?)` 已提供有界候选补全 Entry，要求明确组装
execution、Parsing 和 Analysis。它优先处理当前主 PDF/内容，缺少步骤才调用下游；遇 `NoUsableContent` 停止本次内容尝试，保留已提交 PDF/ParserResult，不清理、不以该 hash 触发重新获取。提供列表用完只返回 `supplied_candidates_exhausted`，
不形成全自动路径耗尽或跨版本回退。普通运行失败保留已提交输入并终止。同一 Literature 并行调用拒绝，
关闭取消并等待；详见[候选补全旅程](../../../migration/evidence/runtime/literature-completion.md)。

Workbench HTTP 可注入 `library: { queries, artifacts }`，经已有 Cookie/client/CSRF 校验后提供 search、detail、
references 与 current PDF/Markdown attachment 下载。下载只接受 Literature ID 与已定义 kind，不接受路径；
复用 verified reader 并在最终复核后结束 chunked 响应。实时前端文献库已消费该接口，支持分页、详情选择和下载，
尚不改变 Browser 会话目标。详见[Web 文献库证据](../../../migration/evidence/runtime/workbench-library.md)。

独立阅读 Web 使用 `startQueryOnlyWorkbench({ home, port? })`，由 `createQueryApplication` 直接组装查询-only
SQLite/FileStore；缺省静态资源从安装包 server 模块旁的 `dist/web/` 读取。`loadQueryWorkbenchAssets()` 提供显式资源
加载入口，源码测试可以注入静态 map。页面由 `query.html` 与薄 `query.ts` adapter 组成，只调用带 v1 envelope 的
`/api/v1/query/*`，复用 `library.ts` 的 search/detail/references/artifact 展示，不绑定混合工作台的 Browser、Jobs、
Configuration 导航。启动 readiness 可区分未初始化与不可用；零命中、缺 PDF/内容、查询错误各有独立反馈。

Query Application 只读打开已有 v1/v2 schema，不创建 Catalog、升级 schema、建 home、运行恢复/对账或提交 Job。
SQLite WAL/SHM 可以作为协调文件出现，读取不会改变文献事实、Jobs、ticket 或 publication receipt。旧 4174 混合
实时工作台仍构造完整 Application，继续提供 Browser/Jobs/配置操作；不能把它描述成 query-only 启动路径。该 Web 入口
只交付已有 Library 阅读；Agent 通过公开 `createQueryApplication` 消费同一只读 TypeScript API。新的文档/知识引用、上下文组装和提取协议仍待对应后续切片交付。

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

[ADR 0026](../decisions/0026-agent-knowledge-and-human-collaboration.md)扩展 Analysis 的用途与粒度，但不改变单次模型入口的无状态责任。下文两阶段消费指现有单篇兼容路径；新分段分析和综合的业务编排、证据与验收仍归 Analysis。

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

Analysis 为每个阶段构造一个独立 `AgentCall`，直接调用 `DshAgentRuntime.execute`。两阶段 controller、prompt/schema、输入 hash、NoUsableContent、Markdown/Metadata/ReferenceLookup validation 和最终业务 provenance 全部留在 Analysis。

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
- 现有 Analysis 两阶段消费的兼容验证，以及新增分析用例的有界调用、取消和结果验收；
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

旧单篇/长文调用保留其发布 owner、方法和证据；新的综合适配接受记录引用并保留字段来源及上游覆盖，旧综合接口保持兼容。新结果内容使用不可变文件，catalog 记录精确依赖和可重建记录/全文投影；长期证据保护独立于外部回执。具体落地与离线证据由关联[实施计划](../../archive/2026-10-18-knowledge-processing-platform/README.md)记录。

### 6.1 已实现的执行与持久化

`application/jobs/processors.ts` 在提交阶段冻结 ProcessorBatchRequest，保存到既有 ProcessingTaskRequest v2（最多 10000 个目标，完整快照最多 4 MiB）。v1 的 100 目标/1 MiB 限制保持。用户请求 hash 与冻结后的执行快照分开保存；重复 key 先比较原请求身份，不因当前默认文档或模型改变而重建原运行。队列逐目标执行，进程并发与共享模型限速沿用原底座；首版没有分布式执行，也没有任务内部并行分片调度。

有效结果先发布并登记依赖，再建立查询投影。索引失败保留有效结果，retry 复用已发布内容并补建索引。任务结束、暂停或取消后保存当时的集合清单；再重试产生新清单。清单 ID 基于运行和成员内容确定，同一清单重发不改变字节。新结果 ID 是独立 UUID，完整比较身份唯一约束只覆盖 internal/complete，partial 不占用这个键。并发争用保留实际赢家的来源，不保证远端模型恰好调用一次。

Catalog v10 的 `processor_results` 与 `processor_collections` 保存不可变文件引用；正文在 `knowledge/results/`、`knowledge/collections/`。依赖表保护文档、材料、旧知识及上游结果；外部 material-only 候选同样保留资产 hash。`processor_record_projection`、`processor_projection_state` 与两种 FTS 从已校验结果重建，不是内容真相源。原 Knowledge 文件没有被复制为另一份权威正文。初始化、迁移使用现有显式 schema 工具，旧 catalog 仍能使用原版本能力。

外部长期接纳是独立 `ProcessorExternalRetention`：要求完整 ExtractionSubmission，先走原交付校验，再保存完整 candidate/relations/spec/manifest/receipt 及独立长期引用。其通用记录 payload 包装为 `{record: 原 payload}`，字段指针相应加 `/record`。请求 key 的持久判同包含完整原请求 hash；回执到期后仍能返回已托管结果，不能以新内容改写同 key。

`entry/processor-operations.ts` 是 CLI/MCP 共用的只读查询/证据/导出边界；QueryApplication 不实例化模型。数字保存原串与原单位，不默默做领域换算。标签和提取按文本片段分批，保留 missing、partial 和能力限制。精确请求格式见[统一加工指南](../../guides/knowledge-processors.md)。没有加入自动修订传播、Unit 依赖、表格坐标、文档修复、全局实体库或新 Web 页面。
