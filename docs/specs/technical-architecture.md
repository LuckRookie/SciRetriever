# SciRetriever 技术架构

本文从代码模块、依赖方向、运行模型、配置边界和架构验收五个侧面描述理想中的 SciRetriever。产品语义以[需求规格](requirements.md)和[系统设计](system-design.md)为准；本文不记录当前代码清单、实现差距或迁移进度，这些信息见[实施进度](../governance/implementation-progress.md)。

## 1. 模块所有权图

系统采用 modular monolith。以下名称表示所有权边界，实现可以在不破坏边界的前提下调整目录名。

| 所有者 | 独占职责 |
|---|---|
| `core` | 稳定 Work/WorkVersion 引用、provider-neutral 输入输出、hash 和通用文献边界，不含 ORM 与 vendor 字段 |
| `catalog` | Work、书目版本、canonical metadata、observations、authors/authorships、独立扁平 Publisher/Venue registries、tags/aliases、version assets、references、single current generated analysis、failures |
| `search` | 有界并发的多 provider metadata 查询、独立 provider timeout、观察值规范化、Work/WorkVersion 确定性身份、DOI 冲突保护、exact normalized-title 匹配、precedence/fill-missing |
| `acquisition` | WorkVersion 资产缺口、跨 provider 有界竞速、provider 内候选去重与确定性顺序回退、translator/browser 回退、validation 前编排 |
| `network` | 所有非浏览器 HTTP 的安全 transport、有限 timeout、redirect、响应上限和敏感 header 策略 |
| `storage` | RawAsset 和 normalization artifacts 的不可变发布、hash、相对路径与对账；current generated analysis 的替换由 `analysis`/`catalog` 拥有 |
| `normalization` | 全文到通用、损失感知结构和 evidence |
| `analysis` | primary PDF 必需且权威、PDF normalized/OCR content、PDF evidence locators、XML/HTML 仅补充、固定 section IDs、本地化 headings、registry-constrained entity/tag selection、灵活 Markdown、旁路构建和直接原子替换 current result/canonical projection/references/generated tags |
| `references` | 版本引用解析、unresolved 保留、cited-by 派生和仅按 depth 分层扩展编排 |
| `library` | exact DOI/title/internal-ID lookup、title/Abstract/light Markdown keyword search、author/year/publisher/venue/tag filters、引用遍历和导出；首版不含 vector semantic search |
| `packaging` | 从选定 WorkVersion、资产和 current result 生成不可变、版本化的 `DocumentPackage` 导出快照；不拥有书目版本身份 |
| `cli` | `search/expand/download/analyze/library/failures/config check` 前台 composition root |

`packaging` 只拥有下游导出边界。`DocumentPackage` 快照绑定稳定 ID、输入 hash 和 provenance，不得承担书目 `WorkVersion` 身份，也不得被原地改写。

## 2. 依赖规则

1. `core` 不依赖 catalog、provider、CLI、storage 或工作流模块。
2. `catalog` 不导入 search、acquisition、analysis、references、storage 或 vendor 类型。repository 接受 catalog 自有 record 或 core 中性值。
3. provider 响应在 `integrations` 或 provider adapter 转成 observation/candidate DTO，vendor dict 不进入 core/catalog。
4. search 不导入 acquisition；acquisition 不导入 search。两者通过 Work/WorkVersion id 和 catalog repository 协作，不通过对方内部类型。
5. analysis 只读取已接受 primary PDF、其 normalized/OCR artifacts、可选补充 XML/HTML 和 catalog 中性记录，不发起全文获取；无合格 PDF 时拒绝运行。
6. references 只编排公开的 search/download/analyze 服务边界，不直接改写其内部状态。
7. library query 和 failures query 不复制权威状态；library curation 只能通过 catalog 的显式 mutation contract 写入可审计 manual 数据。failures 聚合 overall reason/action 与可展开的脱敏 per-source details；losing provider failure 在成功竞速中只作诊断。
8. CLI 是唯一 composition root。模块不得自行读取另一份 TOML 或散落 secret。
9. RawAsset 字节只由 storage 发布。任何 provider、browser 或 analysis 路径都不能直接覆盖目标文件。

## 3. 前台运行模型

每次 CLI invocation 构造一次配置、catalog、provider registry 和所需服务，在当前进程内完成有界操作后退出。长批次通过 stable selection 和幂等重跑恢复，不建立 daemon run owner。

明确不引入：

- lease 或 heartbeat；
- fencing token；
- 进程隔离作为普通 provider 正确性的前置条件；
- network exactly-once；
- 为恢复单个 URL 执行而持久化的 candidate checkpoint；
- 外部工作流平台。

进程内 acquisition 使用两级调度：配置的 providers 在 tier 内进行有界竞速；每个 provider 进行有界 resolution 并输出 provider-neutral runtime candidate DTO，DTO 可携带受控请求凭据或 auth reference，但敏感字段不得持久化或进入 diagnostics。候选在 provider 内去重并按确定性顺序逐个交给共享 candidate executor，直到内容与身份 validation 成功或该 provider 耗尽。translator 和 browser 作为后续 tier，不与第一层一起启动。只有验证合格的 winner 可以进入 storage acceptance。

有限 timeout 定义内容可被接受的最晚边界，race loser 必须清理且不能 late accept。Ctrl+C 停止启动新记录，安全排空或取消当前有限操作并保留已完成记录；重跑幂等跳过已完成内容。幂等性来自 Work/WorkVersion identity、目标角色、hash、immutable publication 和原子 catalog transaction，不依赖 durable pause/resume/safe-stop control state。

## 4. 配置边界

`sciretriever.config` 是 strict TOML 的唯一 parser，未知字段 fail closed。它负责以下配置：

- metadata provider precedence；
- catalog database/assets 路径、search 默认 level/limit；
- acquisition provider priority 和配置 Sci-Hub；
- translator/browser enablement 与安全引用；
- LLM provider/model/参数和 secret 引用；
- PDF/XML/HTML 策略；
- full reference list 是否追加到 light Markdown/export 和扩展默认方向；
- 默认 30 秒文献启动间隔。

CLI 显式值只覆盖当前 invocation，不回写 TOML。`download`/`analyze` 的 ID/query/filter/tag/all selectors 和 force 语义属于 CLI contract，不得藏入另一套 task policy。`config check` 只要求启用能力的 secret/runtime，并检查目录权限、模型和 browser profile。

直接 secret 和环境变量都先在 composition root 解析成不回显的 typed config。

## 5. 强制架构边界

- HTTPS、DNS、redirect、header 和有界读取原则；
- 每个网络与分析操作的有限 timeout；
- acquisition 跨 provider 有界 race、provider 内确定性候选回退和 loser 清理；
- 资产角色、MIME、magic、EOF、解析和身份 validation；
- storage 的 immutable create-if-absent、hash、相对路径、权限和 reconciliation；
- durable write 前和用户输出前的 secret redaction；
- provider-neutral DTO、provenance 和 lineage；
- `DocumentPackage` 的领域中立边界，除非后续 ADR 明确修改。

## 6. 架构验收

- 产品术语在代码、schema、README 和 specs 中保持一致，书目身份、处理状态和导出快照不混用。
- `WorkVersion` 与 processing/package snapshot 有独立名称、表和生命周期。
- 每个系统设计能力模块都映射到一个明确的代码所有者；一个事实没有两个写入所有者。
- provider 响应只在 adapter 边界转换为中性 observation/candidate DTO，vendor 类型不穿透 core/catalog。
- 没有模块绕过 catalog/storage ownership。
- search、acquisition、analysis 和 references 只通过稳定 service/repository contract 协作，不导入彼此内部类型。
- CLI 保持唯一 composition root，所有模块共享同一 typed config 和 secret redaction 边界。
- 运行时不依赖 daemon、lease、fencing、durable pause/resume 或 process-isolation 才能正确完成。
- RawAsset 和 `DocumentPackage` 快照只通过各自所有者发布，不允许旁路覆盖或原地改写。
- 任何功能替换或退役都必须保持 secure transport、timeout、race、validation、immutable storage 和 redaction 回归性质。
- 需求中的产品验收场景由产品测试证明，本节只验证代码所有权、依赖方向和技术不变量。
