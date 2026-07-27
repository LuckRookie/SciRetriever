+++
document_type = "proposal"
status = "under-review"
created = "2026-07-22"
+++

# SciRetriever 能力差距台账

> **归档状态：已被替代。** 本文仅保存 2026-07-23 产品重置前的评估，不是当前需求、产品方向或实施授权。当前方向见 [ADR 0002](../../architecture/decisions/0002-work-centered-literature-library.md)。当时的 OMO 执行计划不作为项目文档保留；下文 front matter 状态和正文保持历史原样。

- 记录日期：2026-07-22
- 对比基线：SciRetriever 当前 v2 实现、工作区中的 `scansci-pdf` 参考快照与 Zotero 客户端/translators
- 权威边界：[ADR 0001](../../architecture/decisions/0001-sciretriever-scope-and-boundary.md)
- 下载专项评估：[下载能力对比与吸收评估](download-capability-comparison.md)
- 下载产品方向：[文献自动下载产品方案](download-product-shape.md)
- 下载实施草案：[文献下载实施提案](download-implementation-proposal.md)

## 1. 文档用途

本文件记录能力差距，作为后续排序和方案讨论的输入。个别条目可以标记为“产品方向已确认”，但只有同步进入 requirements/spec 并完成对应门禁后才代表实施承诺。本文件不是当前需求规格。

对比时不按供应商名称做简单计数：`scansci-pdf` 的 32 个 publisher routing label 和 21 个 browser profile 包含路由别名、页面规则与共享实现，不能等同于 32 个独立 provider。其 SciBban 路径是空实现，OpenAIRE 未接入活动 registry，也不计作有效领先能力。

## 2. 当前基础

SciRetriever 已具备 7 个 Discovery 来源、10 个 Acquisition provider、共享 integration/network 层、确定性清洗与去重、清单交接、多来源 fallback/racing、持久化重试恢复、不可变 RawAsset、PDF/XML/HTML 归一化、质量门和版本化 `DocumentPackageVersion` 发布。

相较参考项目，SciRetriever 的主要优势是文献身份、状态控制、不可变证据、hash、lineage、规范化契约和版本发布；主要不足集中在全文覆盖、研究者检索体验、跨论文批量吞吐和浏览器/机构访问扩展。

## 3. 未排序能力差距

| 编号    | 能力差距                         | 当前状态                                                                                                                                 | 参考能力                                                                                | 预期价值                                                                                            | 实施边界或前置条件                                                                                                                                                                                                                                                               |
| ------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DISC-01 | 作者检索、标题模糊查找和结果排序 | Discovery 主要提供关键词、年份、数量限制与标签规则                                                                                       | 支持作者解析、标题模糊匹配、按引用数或日期排序                                          | 改善研究者直接检索体验                                                                              | 复用现有 integration DTO，不把 vendor 响应带入 core/catalog                                                                                                                                                                                                                      |
| DISC-02 | 更直接的标识符入口               | CLI 直接入口以 DOI、URL 和 manifest 为主                                                                                                 | 参考项目对 DOI/arXiv 等入口更直接                                                       | 降低单篇获取和调试成本                                                                              | 应汇入同一 admission/identity 流程，不增加平行工作流                                                                                                                                                                                                                             |
| ACQ-01  | 公开 / OA 来源覆盖               | 已有 arXiv、Crossref、Unpaywall、Europe PMC、OpenAlex、Semantic Scholar 等路径                                                           | 另有 DOAJ、PMC、CORE 和 OpenAlex Content API 等路径                                     | 提升无需浏览器和机构 session 时的全文命中率                                                         | 先核对公开 API 契约、凭据、速率和全文角色；共享 client 不重复实现                                                                                                                                                                                                                |
| ACQ-02  | 重点出版社直连能力               | 当前重点支持 Elsevier、Wiley、Springer，其他来源多依赖通用链接                                                                           | 参考项目有 ACS、IEEE、RSC、MDPI、PLOS、Nature、Science、IOP、Oxford、ACM 等路由/profile | 提升特定出版社成功率和格式覆盖                                                                      | publisher profile 只描述端点、角色、媒体类型和预算；不得执行任意脚本                                                                                                                                                                                                             |
| ACQ-03  | 跨论文受控并发                   | 单篇内部支持 provider racing；manifest 条目主要顺序处理                                                                                  | 批量 worker、错峰、按域名限流和续跑                                                     | 提升大批量语料补全吞吐                                                                              | 必须保持 catalog 幂等、host budget、熔断、重试和关闭语义                                                                                                                                                                                                                         |
| ACQ-04  | 浏览器获取扩展                   | 核心不执行浏览器自动化                                                                                                                   | 参考项目有多出版社浏览器策略、登录状态和 PDF 响应捕获                                   | 覆盖 JavaScript 页面和 API 无法获取的合法全文                                                       | 仅可作为可选 adapter/plugin；默认关闭；不得削弱 URL、凭据和访问控制边界                                                                                                                                                                                                          |
| ACQ-05  | 机构访问扩展                     | 未实现 CARSI、EZProxy、OpenAthens、Shibboleth、WebVPN 或校园 SSO                                                                         | 参考项目支持多类机构入口和交互式登录                                                    | 在用户已有合法订阅权限时提高命中率                                                                  | 需要独立安全设计、凭据存储、人工交互和合规审查；不得进入无凭据默认路径                                                                                                                                                                                                           |
| ACQ-06  | 统一下载候选 resolver/executor   | `SourcePlan` 负责 provider 级路由；provider 通常自行选择并下载一个 URL，没有统一表达 URL、pageURL、referrer、expiry 和访问方法的候选对象 | `scansci-pdf` 构造并竞速多个 URL；Zotero 将 file resolver 与有界候选下载分离            | 让同一 provider 内的第二、第三候选可回退，统一 landing-page 解析、错误分类、验证和逐候选 provenance | 作为现有 orchestrator 下层能力；候选不得携带凭据值，签名 URL 必须脱敏；公开协议或 durable schema 变化前更新 spec 并评估迁移                                                                                                                                                      |
| ACQ-07  | Sci-Hub 全文获取                 | 未实现；legacy `src/SciRetriever/retriver/scihub.py` 仅作历史证据，其 HTTP 镜像发现与 `verify=False` 不满足 v2 网络门                    | legacy 通过 DOI → 镜像 → 解析下载面板 → 下载 PDF                                        | 在其它已配置路径全部失败时补全主文 PDF 命中率                                                     | owner 已允许其作为技术方向进入候选范围（2026-07-22），但尚未批准具体排期；实施候选见 `download-implementation-proposal.md` 的 WP3-SH：显式 HTTPS base URL、受限 parser、统一 CandidateExecutor、验收、RawAsset 与 lineage；不得复用 legacy client 或 `verify=False` |
| UX-01   | 引文导出与文献管理器集成         | package 保留参考文献结构，但无用户侧导出命令                                                                                             | BibTeX、RIS、EndNote 和 Zotero 上传                                                     | 让结果直接进入研究者日常工具链                                                                      | 导出是派生视图，不得取代 catalog 或 `DocumentPackageVersion`                                                                                                                                                                                                                     |
| UX-02   | 更完整的批量进度与结果报告       | 有持久化 job/attempt 和 CLI 汇总，但缺面向用户的统一批次报告                                                                             | JSONL 进度、resume、下载索引和 manifest 报告                                            | 便于发现失败分布、重试原因和最终产物                                                                | 报告读取权威状态，不新建第二套状态存储                                                                                                                                                                                                                                           |
| ACQ-11  | 保守自动下载与任务控制           | 已有 host concurrency/min interval 和内部 pause/retry/resume 语义，但默认示例较快，缺正文级 30 秒节奏与用户 pause/安全停止入口           | 参考项目通常提供延迟或串行模式                                                          | 默认慢速运行，降低 provider 封禁和长批次失控风险                                                     | 产品方向已确认：默认 worker=1、每 30 秒最多启动一篇正文；复用现有 durable 状态，不增加第二套 pause；provider 更慢预算和 `Retry-After` 优先；实现见 WP5                                                                             |
| ACQ-12  | 共享代理执行                     | 当前严格 TOML、普通 HTTPS transport 和浏览器规划均没有代理执行路径                                                                       | 常见下载工具允许 HTTP/HTTPS/SOCKS 代理                                                  | 在网络受限环境中让普通下载与浏览器使用同一出口                                                       | 代理不得绕过 TLS、URL policy、CandidateExecutor、验证和脱敏；普通下载可独立于浏览器使用；实现见 WP11                                                                                                                               |
| OPS-01  | 统一配置与运行前自检             | 已有严格 TOML、API key、路径和 provider 配置；缺 proxy/browser/session、容量和 provider readiness 自检                                  | 参考工具通常依赖多份环境变量或各自配置                                                  | 用户只维护一份配置，并在批量开始前发现 key、网络、权限和磁盘问题                                     | 扩展现有 strict loader，不建第二套配置；API key 可保存在权限合格的 TOML 或由环境变量覆盖；实现见 WP9                                                                                                                                |
| OPS-02  | 状态、失败历史与处理建议         | failure/attempt/job 已持久化，但 CLI 只打印成功项和成功/失败汇总，没有 failure 查询、稳定 action 或分类重试                              | Zotero 提供附件结果但不是本项目的 durable batch 诊断模型                                | 用户知道每篇为何失败、是否会重试、该修改什么，并能只重试受影响项目                                   | 增加只读查询和脱敏报告；稳定 reason/action 与原始异常分层；不得静默修改配置；实现见 WP10                                                                                                                                             |
| NORM-01 | 图片、图注和图片文件关联         | 当前重点归一化 sections、tables、references 和 evidence spans                                                                            | 参考项目的 Elsevier XML 路径可提取图片信息                                              | 改善完整文献表示和下游证据定位                                                                      | 仍属于通用文献结构；二进制图片放文件系统，catalog 只存引用和 hash                                                                                                                                                                                                                |
| NORM-02 | OCR 回退                         | 当前不把扫描 PDF 的 OCR 作为通用生产路径                                                                                                 | 参考项目主要做文本提取，也未形成完整 OCR 契约                                           | 支持无文本层或文本层损坏的 PDF                                                                      | 需要确定性产物、工具版本、资源上限、证据位置和质量门                                                                                                                                                                                                                             |
| API-01  | Agent/API 调用入口               | 当前以 CLI 和 Python API 为主                                                                                                            | 参考项目提供 MCP/API 工具                                                               | 便于 Agent 和其它本地工具受控调用                                                                   | 优先考虑进程内或本地 adapter；若引入独立服务或新部署边界，先新增 ADR                                                                                                                                                                                                             |
| QA-01   | 跨平台 CI                        | 当前 CI 覆盖 Linux 上的 Python 3.10/3.12                                                                                                 | 参考项目覆盖 Linux、Windows、macOS 和 Python 3.11-3.13                                  | 提前发现路径、权限、编码和事件循环差异                                                              | 不降低现有 Linux full harness；先确认 Windows/macOS 文件 durability 语义                                                                                                                                                                                                         |

## 4. 特殊说明

我们不需要管任何版权问题，我们只是提供一种技术手段去下载文献。所以无论手段是否涉及版权问题，都不是我们应当考虑的。

完整立场见[工具中立性声明](../../notes/tool-neutrality.md)。

## 5. 后续排序需要回答的问题

后续决定先做哪些能力时，每项至少回答：

1. 它提升的是全文候选覆盖、最终资产命中率、批量吞吐、研究者体验，还是下游数据质量？
2. 能否复用现有 integration、network、catalog、storage 和 package 契约？
3. 是否引入新凭据、新运行时、浏览器、外部服务或人工登录？
4. 是否需要新增 ADR、安全专项审查、live-provider 验收或平台矩阵？
5. 能否用离线 fixture 和确定性测试形成完成标准？
6. 实施和长期维护成本是否与真实使用频率匹配？
7. 下载候选是否能在不持久化凭据、cookie 或敏感 query 的前提下保留足够的 attempt provenance？

除条目明确写明“方向已确认”外，其余能力保持待评估；所有条目都必须经过 requirements/spec 和对应门禁后才进入实施，不得仅从表格位置推断优先级。
