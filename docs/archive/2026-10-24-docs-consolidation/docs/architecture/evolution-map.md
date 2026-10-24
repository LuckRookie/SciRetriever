# TypeScript 到知识服务的迁移映射（实施前基线）

- 日期：2026-09-28。本文保留实施前的改造判定、兼容设计与问题归属；下文“当前”“待实现”“待审核”均指当时基线，不是 2026-09-30 的待办。
- 这条迁移路线已完成代码与合成/安装验收。当前能力和限制见[TS 基线](typescript-baseline.md)、[用户指南](../guides/README.md)与[Catalog 兼容矩阵](../guides/installation.md#当前-catalog-与-reader-兼容)；目标依据[需求](requirements.md)及 Accepted ADR。
- 本文回答“当时为什么保留、改造、替换或新增”；完整任务与证据见[迁移计划](../archive/2026-09-28-typescript-knowledge-architecture-migration/README.md)。真实用户数据切换与发布尚未执行。

## 1. 三种材料如何组织

当前项目是起点，目标架构是拟达到的能力与责任，实施计划是二者之间的一条迁移路线。旧问题清单提供用户影响和回归场景，不作为平行修复工程继续执行。

2026-09-27 按 [ADR 0028](decisions/0028-query-and-expansion-separation.md)明确查询与维护的启动边界：查询反馈不进入扩库调度，独立知识请求也不自动补 PDF。既有用户主动启动的 completion 仍按已声明的维护语义处理；新只读入口不能把它当作缺口 fallback。本项是设计边界修订，未声称当前只读查询已有自动扩库缺陷。

目标并未撤销已有材料和知识能力；PDF 获取重要程度不等于架构中心，也不意味着已有 PDF 的消费者必须等待自动获取模块完成所有改造。真实依赖由输入与合同决定，计划的串行顺序只是当前执行选择。

本映射中的 Metadata、Parsing、Analysis 等名称表示当前源码或内部职责；它们归入[八个顶层模块](technical.md)。M01–M09 是贯通这些模块的实施工作包，编号不与模块一一对应。

## 2. 已核对的当前事实与改造判定

路径是本次只读核对入口，不是新测试通过证明；既有测试需要在实施切片中继续执行。

| 当前部分与证据                                                                                                                                                                                        | 判定                                  | 目标改造与理由                                                                                                                       | 保护/验收重点                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [Metadata](../../apps/server/src/metadata)、[Literature](../../apps/server/src/literature)及[contracts](../../packages/contracts/src/index.ts)                                                        | 保留，按公开能力补充                  | 保守身份、来源 observation、书目交换继续工作，不另建论文身份体系                                                                     | 多来源冲突、明确版本、来源不丢；领域候选不进固定字段                       |
| [tiered acquisition](../../apps/server/src/acquisition/tiered.ts)、[PDF 协调](../../apps/server/src/entry/pdf-acquisition.ts)、[candidate tests](../../apps/server/test/candidate-acceptance.test.ts) | 保留分层与验收，改造交付/介入衔接     | 获取独立交付材料；Public/API/Browser 与 manual 接纳共用既有安全边界                                                                  | 实际 PDF 字节、文章匹配、提交完成、稳定缺失与暂时失败区分                  |
| [完整 completion](../../apps/server/src/entry/database-completion.ts)、[Jobs](../../apps/server/src/application/jobs/service.ts)                                                                      | M03-T02 待审核                        | CLI/Application 使用完整 operation；Jobs 已接入冻结范围、Meta 版本候选和 `runFrozen()`，保留原 durable wire                           | 同意图同目标、Meta 版本选择、cohort、取消/分区；保留阶段提交及部分提前交付 |
| [Parsing](../../apps/server/src/parsing)、[parser schema](../../apps/server/src/storage/sqlite/schema.ts)                                                                                             | 保留 adapter，新增文档层              | 当前 Markdown/资源/hash 可复用；独立 Document/Evidence 负责结构读取和稳定引用                                                        | parser-neutral、资源闭包、旧引用与重解析后的版本绑定                       |
| [AnalysisService](../../apps/server/src/analysis/service.ts)、[内容接纳](../../apps/server/src/entry/content-analysis.ts)                                                                             | 保留旧格式兼容，扩展/替换内部用例组织 | 当前两次请求均发送完整 Markdown，固定两调用上限不是长文分层分析；新增用途/综合需自己的流程与产物                                     | 真正分段/整合、覆盖、证据、旧格式兼容、模型失败不删材料                    |
| [NoUsableContent 链](../../apps/server/src/entry/content-analysis.ts)、[cleanup](../../apps/server/src/entry/no-usable-content.ts)                                                                    | 替换不符合已接受目标的删除联动        | 将用途不适用与资产失效分开，不能仅凭分析结果清理已接纳材料                                                                           | 保留有效原始资产；错误文件处理归独立 owner 规则，不能直接删有效回归测试    |
| [生产 article flow](../../apps/server/src/browser/article-flow.ts)、[workbench session](../../apps/server/src/workbench/session.ts)                                                                   | 改造共享生产控制                      | 前者有连续 loop，后者有画面/控制与单步 runAgent；组件存在不足以证明同一生产流程观看/指导/交还                                        | 唯一会话/控制者、迟到动作、capture、跨文章隔离、实际生产对象图             |
| [配置 owner](../../apps/server/src/configuration/owner.ts)、[CLI](../../apps/server/src/cli/main.ts)、[config UI](../../apps/server/src/cli/config-ui.ts)                                             | 保留 owner，修正调用与配置生命周期    | M02 已接通保存 limit、每次 probe 重读、请求级凭据复核和 Web Source/Provider/Model 配置；普通运行参数保留启动快照并准确提示重组装需求 | 配置 limit=7、保存后立即 probe、权限撤销与在途区别；不换第二配置体系       |
| [Library query](../../apps/server/src/literature/query.ts)、[FTS schema](../../apps/server/src/storage/sqlite/schema.ts)                                                                              | 保留文献查询，新增 Q 能力             | 文献级搜索/详情已接独立 QueryApplication、CLI 与只读 Web/TS 入口；新正文/知识证据索引与预算组装仍待后续实现                          | 未分析材料可查、无隐式生成、索引覆盖、预算、结果版本                       |
| [Storage](../../apps/server/src/storage)及[execution repository](../../apps/server/src/storage/execution/repository.ts)                                                                               | 保留底座，设计新产物/依赖模型         | Catalog/ArtifactStore 与 execution 机制存在；新文档/知识/候选生命周期需明确 schema                                                   | 不可变发布、引用保留、读/写/回收竞争；执行状态不代替结果有效性             |
| [Agents](../../apps/server/src/agents)、[Network](../../apps/server/src/network)、[bootstrap](../../apps/server/src/bootstrap)                                                                        | 保留并按新用例接线                    | 无状态模型、受控 I/O、唯一对象图可服务多个独立业务 owner                                                                             | SDK 私有协议、凭据和取消不越界；新模块不私建联网/模型通道                  |
| [Web](../../apps/web/src)、[workbench HTTP](../../apps/server/src/workbench/http.ts)                                                                                                                  | 优先复用，扩展服务端能力适配          | 保留配置/live/library 基础；新交互不先换前端框架                                                                                     | 正式获取观察与原始文件读取先接实际服务，知识阅读随对应能力接入             |
| 正式知识 adapter、Document/Evidence、Extraction 完整公共协议                                                                                                                                          | 新增                                  | 当前代码尚无完整目标合同；通过模块公开 API 增量接入                                                                                  | 能力真正可用，不只声明接口；外部提取无需内部模型                           |
| daemon、远程多租户、长期回放、算法插件宿主、Zotero 深度集成                                                                                                                                           | 延后或待定                            | 不由当前架构图默认引入                                                                                                               | 保留现有行为；有明确需求后再改变部署、数据和权限合同                       |

已有阶段提交、取消、局部成功、结果复用、durable Jobs 是可复用事实，不是新架构首创优势。新设计的收益是把这些机制用于独立材料、不同知识产物和外部提取，并统一入口及人类协作；效果与性能尚未实测。

## 3. 旧问题与任务的迁移归属

P 编号保留旧审查的追踪身份；P01/P02 离线复现及当时 Full 数字只作历史证据，本轮只读复核没有重新执行测试。旧计划现为 [Superseded](../archive/2026-09-25-requirements-and-operation-architecture/README.md)，不继续运行一条平行修复路线。

| 原问题/旧块                     | 新计划归属                | 处理与回归                                                            |
| ------------------------------- | ------------------------- | --------------------------------------------------------------------- |
| P01 CLI 硬编码扫描上限；B04     | M02 已完成 / M03 回归     | M02 已交付保存 limit=7 和显式覆盖；M03 保留跨入口回归，不重复安排修复 |
| P02 保存后probe旧快照；B03      | M02 配置                  | 保存→立即probe与新请求生效，失败不假成功                              |
| P03 配置界面缺口；B03/B10       | M02 / M04 人类入口        | 按现有配置owner补齐交互，不重建配置体系                               |
| P04 Jobs仅共用TargetRunner；B04 | M03 操作                  | 对齐完整范围/版本/波次/报告，现有durable记录兼容与新存续承诺分开      |
| P05 Site production probe；B05  | M04 Browser               | 正式组装，无Storage副作用；与文章获取分开                             |
| P06 诊断/等待；B03/B05/B10      | M02 / M04                 | 来源是真实安全结果，日志不替代报告                                    |
| P07 runtime/现场证据；B06       | M09 验收                  | 离线、真实binary+loopback、真实站点及数据切换分列                     |
| P08 文档/知识/上下文；B07–B09   | M05 / M06 / M07           | 产物与证据合同、真正长文处理、只读预算访问                            |
| P09 生产人类协作；B05/B10       | M04，阅读随M05–M07        | 同一生产会话观看/指导/交还，服务端控制竞态                            |
| P10 提取能力；B11               | M08 提取                  | 外部策略、记录规范、真实材料读写交付；不依赖先有摘要                  |
| B01/B02 需求与设计              | M01 合同收敛              | 复用已确认需求，不因文档已有就假定精确schema定稿                      |
| 原NoUsableContent清理联动       | M03保护边界 / M06兼容分析 | 分离分析适用性与原始资产失效；回归验证材料保留                        |

## 4. 兼容与迁移策略建议

1. 保留稳定文献 ID、来源 observation、现有资产 hash/字节、配置身份及已支持书目交换。新能力先以加法公共操作进入统一应用边界。
2. 旧 PDF/content completion、单篇 LiteratureContent 和既有读取不静默变义。现有 `complete content` 的 `CONTENT_READY` 可包含 PDF 获取、Parsing 与旧 Analysis；新 Query、独立 Analysis/Extraction 不得调用它作缺口 fallback。新用途使用明确产物类型，兼容投影只映射可证明等价的内容。
3. 为 Document/Evidence、多用途知识和候选定义独立 schema 与依赖；不能通过放宽旧 ParserResult 或任意 JSON 字段偷偷迁移。M01 已接受的语义与兼容设计列出首版对象/两类证据引用字段及候选即时交付；候选历史托管与精确保留期限仍待决定。
4. 每个能力切片同时交付 owner、合同、正式对象图、Agent/人类适用入口、直接测试和文档；不把所有入口接线堆到最后。
5. 新实现验证后再替换旧内部路径。需要受支持格式破坏或真实数据切换时先有精确策略与授权；本轮文档不执行迁移，不引入永久双写。
6. 失败保留现有有效数据和已确认事实。新增 schema 迁移应在合成库验证完整性/重试/恢复；实际备份和回退方法要随具体 schema 定稿，不能声称尚未设计的迁移可无损回滚。

## 5. 数据迁移必须单独设计

### 5.1 当前支持基线与未来变更不同

当前 `storage/sqlite/schema.ts` 定义catalog v1，`schema-v2.ts`用v2身份与原v1业务statements加execution/runtime结构组成v2。现有synthetic-copy migration gate及[升级指南](../guides/upgrade.md)不提供新Document/Evidence、知识或候选schema。M01 建议：若新事实需要 Catalog 表，下一个单独 manifest 以候选 v3 设计；execution/runtime sub-schema 继续独立版本。M05 尚须用实际 DDL 确认版本清单、fingerprint、受支持输入和迁移路径；此处不是已实现 v3 或新命令。

新迁移不得复用“v1→v2”名称假装知识升级已经实现。若新增业务 Catalog 表，下一独立 manifest 的候选版本是 v3；M05 按实际 DDL 冻结支持的输入 version/fingerprint、reader 兼容和迁移工具合同，再实现并验证。未知 fingerprint、漂移、混合版本或损坏必须明确拒绝，不能猜结构并写库；本计划不虚构新命令。

### 5.2 数据对象与处置

| 对象                                                      | 迁移应保留/新增什么                                                 | 禁止的捷径                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| 文献ID、版本、observations、元数据、书目Reference/support | 保留身份和来源，验证数量/关系/规范化hash；明确旧content相关支持更新 | 新建第二套论文身份，丢来源后仅保留模型总结              |
| 原始Asset及关系、字节与provenance                         | 保留不可变字节/hash/相对引用、主资产关系；查询可独立读取            | 重新下载替代数据迁移，改字节/绝对路径或用分析不适用清理 |
| 当前ParserResult及引用资源                                | 原格式兼容读取；新表示需输入/转换版本/资源绑定                      | 把旧hash直接当新的表示ID或伪造页码/locator              |
| 旧LiteratureContent/Markdown                              | 保留旧reader和输入对齐；可证明等价时才建立明确投影                  | 把旧摘要静默解释成任意问题分析或带逐字段证据的结果      |
| 新文档/知识/候选                                          | 增加有owner的schema、依赖、发布与读取；被引用版本默认保留           | 任意JSON塞进Literature字段，无界保留所有模型尝试        |
| 索引                                                      | 按版本重建，暴露新鲜度/覆盖；可独立失败与恢复                       | 让索引决定原始材料不存在，查询失败自动扩库              |
| execution/任务                                            | 兼容已有受支持记录；不替代文献/产物事实                             | 顺手增加daemon保证、恢复旧Browser/HTTP现场              |
| 配置/凭据/Profile                                         | 保留固定身份和安全边界，新增字段独立兼容分析                        | 自动发现/读取另一用户配置、复制凭据或无授权改Profile    |

CandidateBatch 首版即时校验并向调用方返回载荷与 receipt，平台不承诺历史托管查询。候选持久托管、稍后读取/导出、相应权限/备份/恢复和具体保留期限仍待用户决定，仅阻塞该历史服务范围。即时交付仍须先完成去重 scope/回执寿命与外部证据依赖合同：M08 提交编码前定重试/并发/重启/取消/过期行为，M05 回收前定外部引用保护或明确失效，M08 发布回执复用。其未决不阻塞 M02/M03 或材料读取。文档/知识的有效引用必须保留可读性或明确失效；回收需要引用检查、读取保护和发布复检，不仅检查 current 指针。

### 5.3 合成演练与真实切换

1. 先定义迁移清单和支持边界，使用合成v1/v2输入及冲突/损坏样本验证；只读inspect与dry-run不能初始化新表或隐式写入。
2. 将catalog、资产清单/hash和关系作为一致恢复单元。备份验证必须验证可恢复性，不能仅验证备份文件存在；不要拼接活动WAL或原地覆盖唯一副本。
3. 在系统临时隔离目标上准备新字节、执行明确schema步骤，核对ID/hash/来源、引用完整性、默认视图和旧reader行为；不为造新证据而无声运行模型/Parser。
4. 注入字节发布前后、事务前后、取消及重启故障。失败保留可审计目标，不把半成品关系标为有效；重复迁移须明确拒绝或幂等，不重复生成业务事实。
5. 仅在代码、直接测试、Full和演练证据具备后准备真实切换清单。真实目标/备份/停writer/在途Browser与任务收束/新writer验收均须精确确认并获得授权，本轮不执行。
6. 切换前可回到未改动的旧数据；切换后若已有新写入，旧程序可能无法读取，不能承诺无损反向迁移。停止写入、保留新数据、依据已设计恢复策略选择修复或从备份恢复；备份后的增量不可静默丢弃。回退工具和恢复点需随具体schema定稿。

## 6. API、入口和替换顺序

先在同一应用边界分离query与明确maintenance。新独立read/parse/analyze/extract操作以加法引入；旧completion、导入导出、ID/hash与报告格式按消费者清单保留，不把内部重构变为静默公开行为变更。

每个切片同时迁移生产者、调用方、TS解析、持久化、正式对象图和适用CLI/Web/Agent入口，并加入直接回归。新路径验证后才移除被替代的内部实现，不永久双写；若确需破坏支持格式，先有明确授权、弃用/迁移策略和消费者验证。

M04 Browser和M05文档是不同能力分支；已有/人工PDF可用于M05，不要求先完成自动获取。M08只依赖明确材料/证据及提交接口，完整Q或Analysis不是业务前置。新查询可读取已有metadata/PDF而不等待全部新知识产物。

## 7. 待定项及影响范围

| 项目          | 实施前要收敛的内容                                                                                           | 不受影响的工作                            |
| ------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| 任务存续      | 关闭客户端/重启、任务ID与等待人工策略，是否需要daemon                                                        | 查询/维护隔离、当前事实重读、既有Jobs兼容 |
| 人类形态/权限 | 最终Web/桌面选择、人工登录/MFA范围                                                                           | 复用Web的基础观察/指导协议，原始材料阅读  |
| 历史保留      | 长期画面/指导回放与容量                                                                                      | 有界实时观察与当前控制反馈                |
| 新持久化      | M05 确认候选 v3 的真实DDL、fingerprint、升级输入/工具/合成恢复；M08 另行决定是否增加候选历史托管及其保留策略 | 模块 owner、查询/加工合同和即时候选交付   |
| 规模/质量     | 代表性文献、问题与预算目标                                                                                   | 有界取消、真实覆盖、零隐式扩库验收        |

常规TypeScript接口和实现拆分由工程设计形成可审查选择，不逐字段要求用户审批；涉及上述产品范围、受支持格式破坏或真实数据操作才需要相应明确决定。未答复不视为同意，不为未决项重写整个架构。
