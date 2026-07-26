# SciRetriever 技术架构

本文从代码模块、依赖方向、运行模型、配置边界和架构验收五个侧面描述理想中的 SciRetriever。产品语义以[需求规格](requirements.md)和[系统设计](system-design.md)为准；本文不记录当前代码清单、实现差距或迁移进度，这些信息见[实施进度](../governance/implementation-progress.md)。

## 1. 模块所有权图

系统采用 modular monolith。以下名称表示所有权边界，实现可以在不破坏边界的前提下调整目录名。

| 所有者 | 独占职责 |
|---|---|
| `core` | 稳定 Work/WorkVersion 引用、provider-neutral 输入输出、hash 和通用文献边界，不含 ORM 与 vendor 字段 |
| `catalog` | Work、书目版本、canonical metadata、observations、authors/authorships、独立扁平 Publisher/Venue registries、tags/aliases、version assets、references、single current generated analysis、failures |
| `completion` | 应用层全局完成编排；从 catalog 事实派生 `METADATA_PENDING -> ASSET_PENDING -> ANALYSIS_PENDING -> COMPLETE`，调用下一缺失阶段并返回统一结果，不持久化第二套状态 |
| `search` | 有界并发的多 provider metadata 查询、独立 provider timeout、观察值规范化、Work/WorkVersion 确定性身份、DOI 冲突保护、exact normalized-title 匹配、precedence/fill-missing 和 provisional provider projection |
| `acquisition` | WorkVersion 资产缺口、跨 provider 有界竞速、provider 内候选去重与确定性顺序回退、translator/browser 回退、validation 前编排 |
| `network` | 所有非浏览器 HTTP 的安全 transport、有限 timeout、redirect、响应上限和敏感 header 策略 |
| `storage` | RawAsset 和 normalization artifacts 的不可变发布、hash、相对路径与对账；current generated analysis 的替换由 `analysis`/`catalog` 拥有 |
| `normalization` | operator-managed MinerU service adapter、外部 attempt recovery、result archive/schema/page geometry validation，以及全文到通用、损失感知结构和 PDF evidence |
| `analysis` | primary PDF 必需且权威、PDF normalized/OCR content、PDF evidence locators、XML/HTML 仅补充、固定 section IDs、本地化 headings、registry-constrained entity/tag selection、灵活 Markdown、旁路构建和直接原子替换 current result/canonical projection/references/generated tags |
| `references` | 版本引用解析、unresolved 保留、cited-by 派生和仅按 depth 分层扩展；每个图节点通过 `completion` 公开契约补全 |
| `library` | exact DOI/title/internal-ID lookup、title/Abstract/light Markdown keyword search、author/year/publisher/venue/tag filters、引用遍历和导出；首版不含 vector semantic search |
| `packaging` | 从选定 WorkVersion、资产和 current result 生成不可变、版本化的 `DocumentPackage` 导出快照；不拥有书目版本身份 |
| `cli` | `search/expand/download/analyze/library/failures/config check` 前台 composition root |

`packaging` 只拥有下游导出边界。`DocumentPackage` 快照绑定稳定 ID、输入 hash 和 provenance，不得承担书目 `WorkVersion` 身份，也不得被原地改写。

## 2. 依赖规则

1. `core` 不依赖 catalog、provider、CLI、storage 或工作流模块。
2. `catalog` 不导入 search、acquisition、analysis、references、storage 或 vendor 类型。repository 接受 catalog 自有 record 或 core 中性值。
3. provider 响应在 `integrations` 或 provider adapter 转成 observation/candidate DTO，vendor dict 不进入 core/catalog。
4. search 不导入 acquisition；acquisition 不导入 search。两者通过 Work/WorkVersion id 和 catalog repository 协作，不通过对方内部类型。
5. normalization 只把已接受 primary PDF 上传到显式配置的 operator-managed MinerU service，并把验证后的 parser output 转换为中性 source units/evidence；不把 MinerU task、vendor JSON 或 Markdown 直接写入 current result。analysis 只读取已接受 primary PDF、其 validated normalized/OCR artifacts、可选补充 XML/HTML 和 catalog 中性记录，不发起全文获取或直接依赖 MinerU vendor types；无合格 PDF 时拒绝运行。
6. `completion` 位于应用层，可以依赖 catalog 的阶段查询和 search、acquisition、analysis 的公开 service contract；这些阶段模块不得反向导入 `completion`，也不得相互导入。`completion` 只决定当前阶段和下一次调用，不复制 provider、transport、parser、LLM、storage 或 atomic replacement 实现。
7. references 只通过 `completion` 公开契约让图节点收敛到 `COMPLETE`，不分别编排或直接改写 search/download/analyze 内部状态；只有 `COMPLETE` 节点的 current references 可以产生下一层。
8. library query 和 failures query 不复制权威状态；library curation 只能通过 catalog 的显式 mutation contract 写入可审计 manual 数据。failures 聚合 overall reason/action 与可展开的脱敏 per-source details；losing provider failure 在成功竞速中只作诊断，failure 不成为 completion state。
9. CLI 是 composition root。它装配一次 typed config、catalog、阶段 services 和共享 `completion`；模块不得自行读取另一份 TOML 或散落 secret。
10. RawAsset 字节只由 storage 发布。任何 provider、browser 或 analysis 路径都不能直接覆盖目标文件。

## 3. 前台运行模型

每次 CLI invocation 构造一次配置、catalog、provider registry 和所需 adapter，在当前进程内完成有界编排后退出。长批次通过 stable selection、processing-run identity 和幂等重跑恢复，不建立 SciRetriever daemon run owner。WP4 可以连接 independently operated persistent MinerU parser service；该服务不由 SciRetriever 启停、升级、监控容量或拥有 task lifecycle，不能成为产品导航或状态真相源。

写入型 invocation 统一装配一个 `CompletionPipeline`（名称可在实现时按同一所有权调整）。输入 target 可以是规范化稳定标识符或已有 WorkVersion ID；它查询 catalog 事实并得到以下唯一阶段，然后只调用下一缺失阶段：

```text
no usable provider identity/projection -> METADATA_PENDING
provider projection, no accepted primary PDF -> ASSET_PENDING
accepted primary PDF, no aligned current result -> ANALYSIS_PENDING
current analysis + final canonical projection + references/tags -> COMPLETE
```

阶段是从 target 和权威事实派生的领域结果，不要求新增 mutable status column。WorkVersion 尚不存在时，规范化 DOI 只存在于当前 invocation，metadata 全部失败也不为记录失败创建 placeholder 或 job。阶段调用失败、来源耗尽或 Ctrl+C 时不写入 `failed/blocked/stale/interrupted` 文献状态；下次 invocation 重新查询相同事实并继续。stage-local processing run、attempt 和 diagnostic records 可以保留恢复与解释价值，但不能成为 completion 的第二真相源。

明确不引入：

- lease 或 heartbeat；
- fencing token；
- 进程隔离作为普通 provider 正确性的前置条件；
- network exactly-once；
- 为恢复单个 URL 执行而持久化的 candidate checkpoint；
- 外部工作流平台。

MinerU external task ID 是唯一获批例外：它作为 normalization processing attempt 的恢复句柄，支持 foreground invocation 在 service task 仍保留时继续 polling。它不建立通用任务中心、retry-child、lease、后台 owner 或 network exactly-once；service `404`/过期后可以在同一 deterministic processing run 下提交新 attempt。

进程内 acquisition 使用两级调度：配置的 providers 在 tier 内进行有界竞速；每个 provider 进行有界 resolution 并输出 provider-neutral runtime candidate DTO，DTO 可携带受控请求凭据或 auth reference，但敏感字段不得持久化或进入 diagnostics。候选在 provider 内去重并按确定性顺序逐个交给共享 candidate executor，直到内容与身份 validation 成功或该 provider 耗尽。translator 和 browser 作为后续 tier，不与第一层一起启动。只有验证合格的 winner 可以进入 storage acceptance。

有限 timeout 定义内容可被接受的最晚边界，race loser 必须清理且不能 late accept。Ctrl+C 停止启动新记录，安全排空或取消当前有限操作并保留已完成记录；重跑幂等跳过已完成内容。幂等性来自 Work/WorkVersion identity、目标角色、hash、immutable publication 和原子 catalog transaction，不依赖 durable pause/resume/safe-stop control state。

## 4. 配置边界

`sciretriever.config` 是 strict TOML 的唯一 parser，未知字段 fail closed。它负责以下配置：

- metadata provider precedence；
- catalog database/assets 路径、search 默认 level/limit；
- acquisition provider priority 和配置 Sci-Hub；
- translator/browser enablement 与安全引用；
- LLM provider/model/参数和 secret 引用；
- MinerU parser service mode/base URL、expected service/protocol/model/backend identity、remote-upload opt-in、auth reference、polling/timeouts/concurrency 和 request/result/archive/schema bounds；
- PDF/XML/HTML 策略；
- expansion direction/depth/provider paging、curation/export format 和 reading reference inclusion；
- 默认 30 秒文献启动间隔。

CLI 显式值只覆盖当前 invocation，不回写 TOML。`download`/`analyze` 的 ID/query/filter/tag/all selectors 和 force 语义属于 CLI contract，不得藏入另一套 task policy。`config check` 默认离线检查 strict schema、启用能力的 secret reference、目录权限、模型和 browser profile；只有显式 runtime 模式才构造有界只读 probes。

固定 acquisition credential 可由权限合格的 TOML 直接提供；MinerU remote auth 和 LLM credential 只以环境变量名称进入 typed config，并在 composition root 读取运行时 secret。所有 secret 都不得回显。MinerU loopback mode 只接受显式 loopback HTTP origin；remote mode 只接受显式 HTTPS origin，并要求独立 remote-PDF-upload opt-in。两种模式都拒绝 userinfo、query/fragment、跨 origin redirect 和响应提供的任意 absolute status/result URL。

## 5. 强制架构边界

- HTTPS、DNS、redirect、header 和有界读取原则；
- 每个网络与分析操作的有限 timeout；
- acquisition 跨 provider 有界 race、provider 内确定性候选回退和 loser 清理；
- 资产角色、MIME、magic、EOF、解析和身份 validation；
- storage 的 immutable create-if-absent、hash、相对路径、权限和 reconciliation；
- durable write 前和用户输出前的 secret redaction；
- provider-neutral DTO、provenance 和 lineage；
- 全局 completion 只编排稳定 service contract，阶段事实仍由各所有者写入；
- 外部 parser POST/upload、polling 和 result download 的 overall deadline、DNS/origin policy、bounded streaming、archive bomb/path/symlink/file/schema limits；
- MinerU service/version/protocol/backend 和 operator-attested model revision provenance；
- `DocumentPackage` 的领域中立边界，除非后续 ADR 明确修改。

## 6. 架构验收

- 产品术语在代码、schema、README 和 specs 中保持一致，书目身份、处理状态和导出快照不混用。
- `WorkVersion` 与 processing/package snapshot 有独立名称、表和生命周期。
- 每个系统设计能力模块都映射到一个明确的代码所有者；一个事实没有两个写入所有者。
- provider 响应只在 adapter 边界转换为中性 observation/candidate DTO，vendor 类型不穿透 core/catalog。
- 没有模块绕过 catalog/storage ownership。
- search、acquisition 和 analysis 不导入彼此或 `completion`；`completion` 只依赖它们的稳定公开 contract，references 只依赖 completion contract。
- CLI 保持 composition root，所有写入型入口共享同一 completion 装配、typed config 和 secret redaction 边界。
- DOI/search、已有 WorkVersion、已有 accepted PDF 和已有 current result 分别进入同一完成管线并得到确定的四阶段；各 CLI 不维护平行完成条件。
- provider projection 在 `COMPLETE` 前保持临时性质；最终 canonical metadata 只随 validated current analysis、references 和 generated tags 原子 promotion。
- failure、diagnostic、processing run 和 MinerU attempt 不增加 completion state；失败重跑从 catalog 当前事实继续。
- SciRetriever 运行时不拥有 daemon、lease、fencing、durable pause/resume 或后台 worker；operator-managed MinerU service 只能经批准的 capability adapter 使用，service task state 不成为产品状态。
- MinerU adapter 不信任 response-provided URLs、redirect、ZIP 或 vendor JSON；只有 validated and immutably published parser artifacts 可以进入 analysis。
- RawAsset 和 `DocumentPackage` 快照只通过各自所有者发布，不允许旁路覆盖或原地改写。
- 任何功能替换或退役都必须保持 secure transport、timeout、race、validation、immutable storage 和 redaction 回归性质。
- 需求中的产品验收场景由产品测试证明，本节只验证代码所有权、依赖方向和技术不变量。
