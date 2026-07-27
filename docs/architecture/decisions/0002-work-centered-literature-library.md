# ADR 0002: 以 Work 为中心的本地文献库

- Status: Accepted
- Date: 2026-07-23
- Supersedes: 2026-07-22 下载任务产品路线；ADR 0001 的产品中心与旧功能兼容策略部分
- Superseded by: none
- Approval reference: `conversation-2026-07-23-literature-library-reset`、`conversation-2026-07-23-pre-v1-schema-replacement`
- Related: [ADR 0001](0001-sciretriever-scope-and-boundary.md)、[需求规格](../requirements.md)、[历史实施归档](../../archive/2026-07-literature-library/README.md)

## 背景

现有 v2 已建立 `Work`、外部标识符、`RawAsset`、不可变存储、归一化、provider 竞速、失败记录和 `DocumentPackageVersion` 等基础。随后形成的下载任务路线把 durable job、pause/resume、候选 checkpoint、崩溃后精确续跑和任务报告放在产品中心。这条路线没有形成研究者需要的本地文献库，也把实现复杂度集中在后台任务语义上。

项目 owner 于 2026-07-23 决定重置产品方向。此次决定不否定已实现基础的工程价值，但不再要求保留旧路线的产品形状或兼容承诺。

## 决策适用范围

本 ADR 不整体取代 ADR 0001，也不与它合并。ADR 0001 继续控制 SciRetriever 的领域边界、`DocumentPackage` 下游契约、不可变证据、通用轻结构、稳定引用和领域输出下游化；本 ADR 控制产品中心、Work/WorkVersion 方向、PDF-required analysis、前台执行模型以及不再需要的下载任务行为兼容策略。表述重叠时按主题分别适用，阅读顺序见 [ADR 索引](README.md)。

## 决策

1. SciRetriever 的产品中心是以 `Work` 为核心的本地科研文献数据库。用户围绕检索、版本、全文、分析结果、标签、作者和引用关系管理文献，不围绕下载任务管理产品。
2. 一个 `Work` 可以拥有多个书目 `WorkVersion`。正式发表版本优先于预印本或其它版本，但版本关系和原始证据必须保留。
3. `WorkVersion` 拥有其主文 PDF，并可拥有 XML 和 HTML。PDF 是分析所需且具有权威性的基准全文；XML/HTML 只能作为可选结构补充或交叉核对，不能覆盖 PDF，也不能在缺少合格 PDF 时独立满足 analyze。所有已接受的原始资产继续不可变保存。
4. 旧下载计划引入但不再需要的行为可以在后续实现中删除或解耦，不承担向后兼容义务。旧 CLI、配置字段、状态、codec 或任务历史只有在新产品仍需要时才保留。
5. 产品使用前台 CLI。一次命令在当前进程中完成有界工作，失败后通过幂等重跑收敛。目标不包含 daemon、lease、fencing、durable pause/resume/safe-stop control state 或逐网络请求的精确崩溃续跑。前台 invocation 仍必须支持 Ctrl+C 或等价的合作式停止：停止启动新记录，安全排空或取消当前有限操作，保留已完成记录，随后重跑跳过已完成内容。
6. acquisition 内同一目标的进程内竞速继续保留。安全网络、有限 timeout、内容验证、不可变接收、幂等资产复用和脱敏也继续保留。
7. 任务、attempt、failure 和 event 历史是诊断与审计辅助，不是产品导航、数据模型或用户心智的中心。
8. 当前代码中的 `package_versions` 和 `DocumentPackageVersion.package_version` 是处理结果快照，不是书目 `WorkVersion`。后续实现不得复用名称掩盖两者差异。
9. ADR 0001 的科研文献边界、不可变原始资产、通用轻结构、稳定引用和领域抽取下游化继续有效。本 ADR 只替换产品中心、执行模型和不必要旧功能的兼容策略。
10. 每个 `WorkVersion` 只保留一份 current LLM analysis。系统先在旁路构建完整新结果；构建失败时旧结果继续可用；原子替换成功后删除或替换旧的 light content、fulltext-derived canonical metadata projection、fulltext-derived references 和 generated tags，不保留分析历史。任何 promoted section、canonical field 或 resolved reference 都必须具有 primary PDF page/span evidence locator；缺少 PDF locator 的输出不得进入 current result。不可变 RawAsset、current parser/model/schema metadata、后端 provider observations、manual metadata 和 manual tags 不随分析覆盖。
11. 当前项目处于 pre-v1，尚无受支持的旧 catalog。直接替换初始 schema，并删除不符合目标框架的旧 catalog、legacy import 和兼容代码；不实现 migration、backup、rollback、legacy-read path 或 compatibility layer。未来何时开始承担兼容义务由 owner 另行明确。

## 后果

- 先删除或解耦旧任务中心架构，再增加新的书目版本、作者、观察值、标签和引用模型。
- 本次 pre-v1 schema 直接替换已经 owner 人工批准；使用全新离线 catalog fixture 验证，不设计旧 schema 迁移、备份、回退或兼容层。未来受支持数据或公开契约变化仍需对应人审。
- README 必须只描述当前命令；requirements、system design 和 technical architecture 只描述理想产品；implementation progress 单独记录覆盖与差距。
- 失败恢复以稳定身份、不可变资产和幂等重跑为基础。系统不承诺从崩溃点继续每个内部步骤，也不引入后台 owner 协议来模拟该能力。
- 删除的是 durable 任务控制状态，不是前台进程的安全中断。任何长操作都必须在 Ctrl+C 后停止领取新记录，并安全闭合当前有限操作。
- current analysis 是直接覆盖模型，不建立 generated-result history。`package_versions` 可以作为当前实现的处理快照保留，但不能成为目标分析历史模型。
- 诊断事实只有在目标产品仍需要时才保留；旧下载历史和 legacy catalog import 不承担迁移审计或兼容职责。

## 被拒绝的替代方案

- 继续扩展旧下载任务路线。拒绝原因是它优化任务控制，而不是文献库的核心对象和研究工作流。
- 在旧 job 模型上叠加 `WorkVersion` 和本地库命令。拒绝原因是会把待删除的生命周期语义变成新模型的基础。
- 为删除旧行为提供完整兼容期。拒绝原因是 owner 已明确允许移除不需要的功能，兼容工作会延缓产品重心转换。
