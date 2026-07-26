+++
document_type = "execution-plan"
status = "approved"
owner = "project owner"
approved_by = "project owner"
approved_on = "2026-07-24"
approval_ref = "conversation-2026-07-24-universal-completion-pipeline"
source_proposal = "../proposals/literature-library-product.md"
requirements = ["../specs/requirements.md", "../specs/system-design.md"]
+++

# 以 Work 为中心的文献库执行计划

本计划替代已归档的[旧下载产品执行计划](../archive/2026-07-download-roadmap/download-product-execution.md)。批准只确认目标和实施顺序。旧计划中不符合新产品的功能可以删除，不要求保持 CLI、配置、状态或内部 codec 的向后兼容。

## 目标与非目标

目标是把 SciRetriever 从下载任务中心转为本地文献库：一个 `Work` 管理多个书目 `WorkVersion`，版本拥有不可变全文资产，库保存 canonical metadata、观察值、作者、扁平标签和引用，用户通过前台 CLI 完成搜索、扩展、下载、分析、库查询、失败查看和配置检查。

非目标：本计划不引入 daemon、lease、fencing、外部工作流平台、Web UI、向量库或领域抽取 schema；不承诺精确恢复到崩溃前的内部步骤；不把 processing/package snapshot 直接重命名为 `WorkVersion`；不为被移除的旧下载任务行为建立兼容层。

## 工作包

工作包必须按顺序进入。每个包完成责任 spec、实现、替换或删除说明、直接测试和适用门禁后，下一包才能开始。

### WP0：删除或解耦旧任务中心架构

- 盘点 `download` 自动任务入口、durable pause/resume/safe-stop control state、retry child、candidate checkpoint、candidate codec 和 task-centered report 对新产品是否有必要。invocation-local Ctrl+C/cooperative stop 不是删除对象。
- 删除无必要的产品入口和状态语义，或把仍有诊断价值的 attempt/failure/event 降为内部支持记录。
- 保留 secure transport、有限 timeout、进程内 serial/race、内容验证、不可变接收、hash 去重、redaction 和基本失败分类。
- 当前项目处于 pre-v1 且没有受支持的旧 catalog；不符合目标框架的旧 catalog 代码可以直接删除，不建立兼容层。

**验收门**：目标运行时不依赖 lease、fencing、daemon ownership、durable pause/resume/safe-stop control state、精确 candidate crash resume 或 retry-child 才能正确完成前台幂等重跑；Ctrl+C 停止领取新记录，安全排空或取消当前有限操作并保留已完成记录；重跑跳过已完成内容；被删除公开面已从 README、配置和测试移除；安全与不可变存储回归通过。

### WP1：文献库 schema 与身份

- 新增独立的书目 `WorkVersion`、版本资产关系、`MetadataObservation`、`Author`、`Authorship`、独立扁平 `Publisher`/`Venue` registries 及 aliases、canonical tag/tag alias、manual/generated tag 来源和版本引用模型。
- 直接替换初始 catalog schema；删除或重构与目标模型冲突的 processing/package snapshot schema，不把它们重命名或升级为 `WorkVersion`。
- 实现 DOI/稳定标识符优先、无稳定标识符时规范化标题的确定性去重，及保守作者合并。不同非空 DOI 不因标题相同合并；DOI 记录可与无 DOI、exact normalized-title 记录合并；不做 fuzzy/LLM 去重。
- provider record 只作为 observation；实现稳定版本标识符优先、无标识符时按 title/version class/publication date/Venue 精确匹配的保守 `WorkVersion` 身份，证据不足时保留 provisional version。
- 增加 preferred version 确定性总排序、显式用户覆盖和 unresolved raw reference 保存；同级 tie-break 不依赖 provider 返回或完成顺序。不同 DOI 的预印本/正式版只有在明确 provider/registry 版本关系或用户确认时归入同一 Work，不能只凭标题跨版本归组。

**验收门**：本次 pre-v1 schema 直接替换已获 owner 批准；多版本、provider observations 不按来源膨胀版本、版本 DOI 冲突、缺失版本证据形成 provisional version、preferred tie-break、Work DOI 补全、作者同名不误合并、Publisher/Venue alias、tag alias 和引用反向派生使用全新离线 catalog fixture 验证；旧 schema、legacy read path、迁移、备份、回退和兼容层均不属于验收范围；没有 LLM 参与身份判断。

### WP2：多来源 metadata 与本地库读取面

- 在有界并发和各 provider 独立有限 timeout 下同时启动所有启用的 metadata provider，实现默认 100 条合并上限、确定性合并和 configured precedence/fill-missing。
- 保存 canonical metadata 与 open-access status，同时在后端保留 observation provenance。
- 实现目标 `search` 和 `library` 命令：普通 search 支持 metadata/download/analyze level 和 TOML/CLI limit precedence；library 支持 exact DOI/title/internal-ID lookup、title/Abstract/light Markdown keyword search、author/year/publisher/venue/tag filters、references/cited-by traversal 与 export。metadata 可保存 backend-only provider source keywords/observations，但不生成 canonical tags。

**验收门**：测试证明多个 provider 实际并发启动、每个 provider 有独立有限 timeout，且固定 provider 输入在不同完成顺序下得到同一 Work、版本和 canonical metadata；低优先级只补空值；Publisher/Venue 只按既有 alias 和 precedence 解析，未知值保持 unresolved；provider 原始形状不泄漏到 canonical schema；首版不实现 vector semantic search；CLI 只声明已实现能力。

### WP3：版本全文获取与独立 backfill

- 将获取目标从 task/job 中心切换为 `WorkVersion` 资产缺口。
- 保留通过架构门的中性 candidate resolver/executor 和两级调度：直接官方、开放来源、出版社及配置 Sci-Hub providers 在第一层有界竞速；每个 provider 内对去重后的候选按确定性顺序逐个执行并回退，不把全部候选扁平化为无界竞速。
- 第一层耗尽后再加入 translator，最后加入 browser。三类新增能力分别完成安全设计和 fixture。
- 实现前台 `download` backfill，以 primary PDF 为必需目标并支持配置的补充 XML/HTML 获取；支持显式 ID/query/filter/tag/all-missing 选择器，无选择器时不得处理全库。

**验收门**：离线 fixture 证明 providers 有界并发启动，同 provider 的第一个候选失败后才执行第二个候选，重复候选只执行一次，不同完成顺序不改变 provider 内的确定性候选顺序，且全局始终只接受一个通过 validation 的 winner；重复运行不重复保存资产；竞速 loser 不 late accept；losing provider failure 在其它来源成功时只作为脱敏诊断细节；最终失败产生一个 overall reason/action 和可展开的 per-source details；primary PDF 和补充资产分别通过角色、HTTPS/获批 transport、timeout、redirect、大小、内容、身份和不可变接收门；XML/HTML 不能被登记为 primary PDF；未通过验收的回退层不出现在 accepted config 或 README。

### WP4：全文分析与原子 current result

WP4 保持一个工作包，但内部按以下五个门禁顺序实施。后一阶段只能在前一阶段的契约、直接测试和适用门禁通过后开始；不得先写 CLI 或 LLM prompt，再反向补持久化、证据和安全边界。

#### WP4.1：current-result、processing attempt 与配置契约

- 先定义 single current analysis 的 catalog ownership、旁路构建和原子 replacement 边界；`package_versions` 继续是不可变处理/导出快照，不充当 analysis history。
- 复用 deterministic processing run 和 immutable derived-artifact 基础，新增外部 parser attempt、validated parser artifact、source unit/evidence lineage 和 current-analysis 所需的 typed contract。明确 run/attempt 状态、唯一约束、并发冲突、失败 reason/action、`404` 新 attempt 和本地 attempt metadata 保留规则；不恢复 Job、daemon、lease、fencing 或 exactly-once 语义。
- 定义严格 MinerU/LLM target config 和 composition-root 装配：loopback/remote 模式、固定 origin、secret 引用、remote upload opt-in、version/protocol/backend/model attestation、timeout/poll/concurrency 及全部资源 bounds。配置验证先有直接测试；只有 WP4.5 完成后才进入 README、示例配置和公开命令面。

**阶段门**：fresh catalog fixture 证明 processing run、多个 external attempts、immutable parser artifact lineage 和 single current ownership 不混用；未知/冲突/不安全配置 fail closed；secret 不进入序列化、日志、失败或 provenance。

#### WP4.2：MinerU connector 与不可信结果准入

- 按 [ADR 0003](../adr/0003-operator-managed-mineru-service.md) 实现 MinerU 3.4.4 `vlm-engine` primary parser adapter。SciRetriever 只连接 operator-managed persistent `mineru-api`，不启动、停止、升级或拥有 service/GPU/model/capacity；loopback 与 remote connection 使用独立严格安全策略。
- 实现 async `health -> submit -> poll -> result` connector、external task attempt recovery 和 deterministic processing-run identity。Ctrl+C 停止新提交/polling但不虚构 remote cancellation；task `404`/过期时可在同一 run 下创建新 attempt。service completed 不等于 normalization 或 analyze success。
- 对 upload、polling、download 和 result ZIP 实施 overall deadlines、fixed-origin URL construction、DNS/TLS/auth/redaction、input/result/archive/file/JSON/page/block/text/image bounds。拒绝 redirect、response-provided absolute URL、path traversal、symlink、duplicate path、compression bomb 和错误文件集合；验证 `middle.json`、`content_list.json`、model output、page size/index/bbox 后发布 immutable parser artifacts，Markdown 不作为 canonical parser contract。
- 为 health、submit、poll、result 和 archive/schema failure 建立稳定 reason/action 映射；固定 poll backoff/deadline 和 result ZIP 必需/可选文件集合。operator acceptance manifest 及其 fixture corpus 使用版本化测试数据记录 service/parser/protocol/backend/model/config 身份与通过门槛。

**阶段门**：loopback/remote service fixtures 覆盖 health/version/protocol、HTTPS/auth/remote-upload opt-in、fixed-origin task URL、timeout、redaction、Ctrl+C recovery、`404` resubmit 和 no-cancel；恶意或超限 result 全部 fail closed，且未验证结果不能发布。

#### WP4.3：PDF source units 与 evidence

- 将 validated `middle.json` blocks 转为带 stable source IDs、page/span/bbox、offset 和 extraction provenance 的 normalized source units；`content_list.json`、model output 和 images 作为 supporting artifacts 保存。
- 保存 service/parser/protocol/backend/model/config/input/output hashes；当前 MinerU 3.4.4 `/health` 不暴露 model revision，因此明确记录为 operator-attested provenance，不把它描述成服务已验证事实。
- 将每个可提升 section、canonical field 和 resolved reference 映射回 accepted primary PDF 的页码/span evidence locator；MinerU text/bbox 只是抽取候选，不能替代 PDF bytes 或 rendered page authority。

**阶段门**：程序化 PDF 和固定 MinerU result fixtures 证明 source ID、offset、page/span/bbox、input hash 和 lineage 确定且可回放；错误 page/bbox/input 关联被拒绝；现有 generic `PyPDF2` normalization 不被误计为 MinerU/OCR 完成。

#### WP4.4：LLM analysis 与原子 current replacement

- 实现只消费已保存且验证合格的 primary PDF 及 normalized/OCR content 的 LLM 分析，保持原文语言；XML/HTML 只补充结构或交叉核对，冲突时 PDF 优先，缺少 PDF 时 analyze blocked。
- 抽取原始 Abstract，缺失时才生成并记录来源。
- 实现十个稳定 section ID：`document_information`、`abstract`、`research_background`、`research_question_and_objectives`、`research_approach`、`methods`、`data_and_materials`、`results`、`conclusion`、`limitations`；heading 使用论文语言，section 内允许段落、列表、表格和子标题，证据不足时明确说明。metadata 是普通正文 section，不是 YAML front matter，Data/Materials 不强制表格。
- 完整 reference list 默认不进入 light Markdown，显式选项可追加或导出；reference parsing 可以属于全文处理，不禁止 references 参与分析上下文。向 LLM 提供现有 tag registry 或相关候选及允许的 Publisher/Venue IDs/names；严格解析 stable IDs，并分别处理 new-tag/new-entity proposals。
- section、fulltext-derived canonical field 和 resolved reference 保存 primary PDF 页码/span evidence locator；无 PDF locator 的模型输出不得提升。在旁路构建并验证完整新分析；失败时旧 current 继续可用，成功时原子替换 light content、fulltext-derived canonical projection、fulltext-derived references 和 generated tag links，不保留 analysis history。保留 RawAsset、current parser/model/schema metadata、provider observations、manual metadata 和 manual tags。

**阶段门**：PDF-only fixture 可完成分析，XML/HTML-only 被阻断，补充资产冲突时 PDF 控制生成内容和 canonical projection；十个 stable section IDs、原文 heading、evidence coverage、registry-constrained 输出和 replacement 保留/删除集合均有直接测试。

#### WP4.5：`analyze` backfill、package 集成与发布面

- 实现独立 `analyze` backfill，支持 ID/query/filter/tag/all-pending；全量和强制重析必须显式 all/force。重复运行复用合格 processing result，失败对象可获得稳定 reason/action，Ctrl+C 后重跑收敛。
- 将 current analysis 通过稳定 ID、hash、lineage 和 evidence 接入 packaging；下游只读取版本化 `DocumentPackage`，不得直接依赖 MinerU task、vendor JSON 或内部 current 表。
- 只有 connector、normalization、analysis、replacement 和 CLI/config 验收全部通过后，才同步 README、`config.example.toml`、`--help`、运维指南和实施进度；不得提前宣传目标行为。

**阶段门**：CLI selectors、无隐式全库、all/force、幂等重跑、中断恢复、失败输出和 package snapshot fixture 全部通过；更新 current 后重导出产生新不可变 package，旧 package 不变；README、示例配置、accepted schema 和 `--help` 一致。

**工作包验收门**：WP4.1-WP4.5 的阶段门全部通过；SciRetriever 从不启动 MinerU；相同 accepted PDF、parser/model/config 和 analysis schema 可得到可审计的 processing identity、artifact lineage 和 current result；任何 connector、admission、normalization、LLM、replacement 或 package 阶段失败都不污染 RawAsset、已发布 parser artifact、旧 current result 或旧 `DocumentPackage`；full harness 和对应人工安全/证据审查通过。

### WP5：全局文献信息完成管线

- 将 metadata、primary PDF 获取、MinerU/LLM 分析和最终 canonical promotion 收口为全系统共享的应用层完成管线；该管线是所有写入型入库、补全和后续扩展流程的统一主干，不属于某一个 CLI，也不在 catalog、discovery、acquisition、normalization 或 analysis 底层建立反向依赖。
- 使用一个简单、可由 catalog 事实确定的单向完成阶段：`METADATA_PENDING -> ASSET_PENDING -> ANALYSIS_PENDING -> COMPLETE`。供应商全部失败、资产来源全部耗尽、MinerU/LLM 失败或 Ctrl+C 都不产生新的持久化文献状态；对象停留在当前未完成阶段，重跑时复用已提交事实并从该阶段继续。
- `METADATA_PENDING` 表示尚无足以确定 `Work`/`WorkVersion` 身份和支持资产获取的供应商元数据；此时 completion target 可以只是当前 invocation 中的规范化 DOI，不要求先创建持久化文献状态。供应商 observations、configured precedence 和 provisional canonical projection 成功入库后进入 `ASSET_PENDING`。供应商元数据只是临时发现/获取输入，不得描述为文献最终元数据。
- `ASSET_PENDING` 表示已有临时供应商元数据但没有 accepted primary PDF；WP3 的不可变资产验收成功后进入 `ANALYSIS_PENDING`。XML/HTML 和补充 PDF 不能替代 primary PDF 完成该阶段。
- `ANALYSIS_PENDING` 表示已有 accepted primary PDF，但尚未完成当前 PDF 对应的 MinerU normalization、LLM 全文分析、PDF evidence 验证和 canonical promotion。MinerU artifact 可以在失败重跑时复用，但不单独增加用户层完成阶段。
- `COMPLETE` 只在 current analysis、fulltext-derived canonical fields、references 和 generated tags 验证通过并原子发布后成立。最终 canonical metadata 按 `manual override > current PDF/LLM-derived value > provider projection` 逐字段统一；LLM 未可靠提取的字段继续使用 provider 值，provider observations、manual metadata 和 RawAsset 始终保留。
- 建立统一的完成阶段判定和 `ensure_complete` 应用层契约。WP1 提供身份和 catalog 事实，WP2 提供临时供应商元数据，WP3 提供 accepted assets，WP4 提供 MinerU/LLM current result 与最终 canonical promotion；WP5 只编排并复用这些已验收能力，不复制各阶段实现，也不恢复 WP0 已删除的 task/job、daemon、lease、durable pause/resume 或后台状态机。
- 将现有写入型入口接入同一完成管线：DOI/稳定标识符入库和 `search` 从 metadata 阶段进入，已有 WorkVersion 的 `download` 从资产阶段进入，已有 accepted PDF 的 `analyze` 和本地资产导入从分析阶段进入。命令可以按显式 level/selector 停在中间阶段，但 catalog 中的完成判定、后续补全和重跑必须使用同一契约；只读 `discover` manifest 和完成后的 package/export 不属于该管线。

**验收门**：离线 fixture 分别从 DOI、供应商元数据、已有 WorkVersion 和已有 primary PDF 进入同一完成管线，并得到一致阶段判定；成功路径严格收敛到 `COMPLETE`，各阶段失败后重跑只执行缺失阶段且不重复保存 observation、RawAsset、parser artifact 或 current result；供应商元数据在 analysis 前明确保持临时性质，成功 analysis 在同一事务中切换 current result、fulltext-derived projection、references、generated tags 和最终 canonical metadata；字段优先级为 manual > PDF/LLM > provider；现有 `search`、`download`、`analyze` 和本地资产入口不维护平行完成逻辑；没有新增 durable job/task 状态机；受影响 WP1-WP4 回归、architecture harness 和 full harness 通过。

### WP6：引用扩展与目标 CLI/config 收口

- 实现 `expand`，默认 references，支持 cited-by/both，仅接受 depth 控制，并用 stable Work visited set 去环和阻止重复入队。
- 每一层对所有新增 Work 完成 metadata、download 和 analyze 后再进入下一层。
- expansion 只有 depth 边界，不设置 product-level maximum-new-documents cap；报告每层计数。分支失败只停止该分支，其它分支继续；Ctrl+C 停止新记录并安全闭合当前有限操作。
- 实现 `failures` 和 `config check`，完成目标命令树、显式 backfill selectors、待复核项与可审计/可撤销的人工整理、阅读版与版本化 `DocumentPackage` export/`--include-references`，以及统一进度计数。`failures` 覆盖 metadata、acquisition、analysis 和 expansion 的对象级 reason/action，acquisition 另有显式、脱敏 per-source details；`config check` 默认离线，显式 runtime 模式只做有界只读 capability probe。
- 收口严格 TOML：复用 WP2/WP3 已发布的 search/acquisition 配置、WP4.5 已验收的 MinerU/LLM 配置和 WP5 全局完成管线，只增加 WP6 expansion/curation/export 所需默认值及尚缺的格式/默认 30 秒文献启动间隔字段；沿用同一 secret 引用和 redaction 语义，不建立第二套配置路径，CLI 只覆盖当前 invocation。

**验收门**：固定引用图按深度产生确定性层级且不受隐藏文档数上限截断；每层计数可对账；每层完整处理；单分支失败不阻塞其它分支；安全中断后重跑跳过完成内容；unresolved reference 可在重跑后解析；人工归组、preferred、metadata、tag 和 author 操作有前后值、可撤销且不删除 observations/RawAsset；更新 current 后重导出产生新 `DocumentPackage` 快照且旧快照不变；各阶段 failure 可按对象查询；未知 TOML 字段拒绝；secret 不进入输出、日志、catalog 或 lineage；README、示例配置和 `--help` 一致。

## 验收与验证

每个工作包至少运行受影响单元和集成测试、Pyright、documentation harness、architecture harness 和 full harness。公开契约、网络安全、browser/session、不可变存储和未来涉及受支持数据的迁移继续经过对应人工门禁；本次 pre-v1 WP1 schema 直接替换已获 owner 批准。

产品级验收使用离线 provider、固定时钟、程序化最小全文和本地 catalog fixture，证明：

- 一个 Work 正确连接多个书目版本，正式版本优先但其它版本仍可读。
- 所有写入型入库和补全入口共享 `METADATA_PENDING -> ASSET_PENDING -> ANALYSIS_PENDING -> COMPLETE` 完成管线；metadata、download、analyze 可分别停在显式阶段或 backfill，重复运行从缺失阶段收敛。
- provider metadata 在 analysis 前只是临时 projection；`COMPLETE` 的最终 canonical metadata 按 manual > PDF/LLM > provider 原子统一，并与 current analysis、references 和 generated tags 对齐。
- 同层 acquisition race 安全，RawAsset 不可变，失败输出脱敏。
- analyze 以 primary PDF 为必要基准；XML/HTML-only 被拒绝，补充资产冲突时 PDF 优先，evidence locator 回到 PDF。
- manual tags、作者、引用、provider observations 和当前 parser/model/schema metadata 不被 analysis replacement 覆盖；旧生成分析在 replacement 成功后被删除或替换。
- README、三份规格和实施进度分别遵守当前行为、理想产品和覆盖台账的文档责任边界。

## 发布与回退

WP0 先缩小旧架构，WP1 直接建立全新目标 schema。当前没有受支持旧 catalog，因此不做 additive migration、备份、回退、旧数据读取或兼容适配；不符合目标框架的旧 schema 和代码直接删除。运行时失败仍不得覆盖或删除已接受 RawAsset。未来存在真实受支持数据后，迁移与兼容要求由 owner 另行明确。

新增 CLI 和配置字段只能随实现发布。某个 provider、translator、browser 或 LLM 路径失败时关闭该路径并回到已验证的前台流程，不放宽 transport、validation、immutable storage 或 redaction。

文档同步范围包括 [需求规格](../specs/requirements.md)、[系统设计](../specs/system-design.md)、[技术架构](../specs/technical-architecture.md)、[实施进度](../governance/implementation-progress.md)、[README](../../README.md)、`config.example.toml`、provider/MinerU 运维手册和代码文档责任映射。

## 进度引用

本计划的 front matter 只表示计划授权生命周期，不表示工作包完成程度。WP0-WP6 的实际状态、验证日期、证据和 blocker 统一见[实施进度](../governance/implementation-progress.md)；不得在本计划维护第二份进度台账。
