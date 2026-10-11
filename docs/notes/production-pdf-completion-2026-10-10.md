# 生产数据库剩余 PDF 获取验证（2026-10-10）

## 范围与状态

本次由用户明确授权，在当前配置指向的真实生产数据库中，尝试为尚无主 PDF 的文献获取原文。操作前保存 SQLite 一致性备份；使用生产 Application 的 `databaseCompletion.run`、`ASSET_READY`、明确 Literature ID 选择器、真实 Provider、正式候选验收和不可变资产发布。

**状态：本次范围已完成尝试及文件复核。新增 250 份正式 PDF；存在尚未修复的批量运行缺陷，不代表无需人工干预的单次任务通过验收。**

开始时有 630 篇 Literature、206 份 PDF，424 篇文献缺少主 PDF。只进行资产补全，不运行解析或分析，不修改个人配置、已有元数据、数据库 schema 或原有资产。

当前配置的 Auto 来源之外，本次运行在内存中显式选择已配置的 arXiv、Europe PMC、Sci-Hub、Elsevier 和 Wiley；公开直接链接、DOI 文章页解析及 Browser 继续走正常生产对象图。Browser 使用已校验的 Cloak runtime、配置中的 `qiuzk/gpt-6-luna` 和既有网络出口。`execution.max_concurrency=4`，供应商限速、Browser 冷却和预算保持生效。

本次接受 PDF 字节和结构验证通过的文件；按既有合同保留“文章身份未验证”，不声称已确认正文对应目标文章。

失败统计按实际到达阶段解释：公开层出现未解决的 502、超时或网络策略失败时，当前生产政策可能阻止继续升级到 API/Browser。因此不能把所有未入库文献称为 Browser 失败，也不能由本轮失败推断没有订阅权限或不存在其它可用渠道。Browser 打开失败等结果若只有稳定通用错误、缺少更底层证据，就保留诊断限制，不补写未经证实的 DNS、验证码或版权原因。

## 最终结果

下载执行时间为北京时间 2026-10-10 09:46–11:24，包含两次整批中断后的独立复现及续跑。以初始 424 个 Literature ID 为固定范围，对重复尝试采用每篇最新结果，避免把受同组故障影响后重试成功的文献重复计为失败。

| 结果                                                  | 数量 |
| ----------------------------------------------------- | ---: |
| 新增主 PDF，正式入库且重开/hash 验证通过              |  250 |
| 已尝试但失败                                          |  161 |
| 本轮正常耗尽，需人工提供 PDF（`manual-pdf-required`） |    2 |
| 历史元数据读取阻断，未进入下载                        |   11 |
| 可读但尚未开始                                        |    0 |
| 合计                                                  |  424 |

数据库仍有 **630 篇 Literature**。PDF 资产及具有主 PDF 的文献均从 **206 增至 456**；尚无主 PDF 的文献为 **174 篇**。

| 实际入库来源                     | 新增 PDF 数量 |
| -------------------------------- | ------------: |
| Sci-Hub                          |           180 |
| Browser Agent                    |            26 |
| Wiley API                        |            18 |
| 直接链接 `direct`                |            12 |
| Elsevier API                     |            10 |
| DOI 文章页静态解析 `doi-landing` |             4 |
| 合计                             |           250 |

来源表示正式 provenance 的获取路线，不等于出版商品牌；例如某出版社文献可由仓储或 Sci-Hub 提供。Browser 的 26 份由真实模型和浏览器取得，不是仅打开页面或返回点击动作。全部 250 份新 PDF 的文章身份状态均为 `unverified`；本轮未运行全文解析或文章身份匹配。

| 执行轮次   | 新增 PDF | 该轮结束方式                             |
| ---------- | -------: | ---------------------------------------- |
| 首轮       |       34 | Elsevier XML 解析异常中断，345 篇未开始  |
| 第一次续跑 |       96 | 历史 HTTP 候选触发合同异常，174 篇未开始 |
| 第二次续跑 |      120 | 范围正常结算，未开始数量为 0             |

三轮生产运行合计调用模型执行入口 305 次。两次单篇诊断均在进入 Browser 前复现，未增加模型调用。每轮失败分区包含可能在后续重试的目标，不能直接相加；上面的最终 161 篇已按 Literature ID 去重。

## 失败分布与证据边界

| 最终失败码                          | 数量 | 本轮可确认的原因                                                                           |
| ----------------------------------- | ---: | ------------------------------------------------------------------------------------------ |
| `pdf-browser-open-failed`           |   48 | Browser 打开文章页失败；稳定错误未充分揭示底层原因                                         |
| `pdf-http-response-failed`          |   44 | 公开 HTTP 502 共 39 篇、405 共 3 篇；Wiley entitlement 403 和 Elsevier request 400 各 1 篇 |
| `pdf-network-failed`                |   40 | 超时 14、NetworkPolicyError 12、NetworkConnectionError 12、response-limit 1、budget 1      |
| `pdf-browser-flow-budget-exhausted` |    9 | 活跃时间/模型/动作保护预算触发；日志未逐篇细分具体预算                                     |
| `pdf-route-delivery-failed`         |    7 | 候选交付或 PDF 验收未通过；现有稳定错误不足以进一步细分                                    |
| `pdf-browser-agent-stopped`         |    5 | Agent 在 HTTP 403 页面停止 3 篇、404 页面 1 篇、登录要求页面 1 篇                          |
| `pdf-browser-navigation-failed`     |    5 | 两篇报告无法打开文章页，三篇报告网络清理后无法恢复导航                                     |
| `pdf-acquisition-failed`            |    1 | 已单篇复现：Elsevier XML 元素数超过 10,000                                                 |
| `pdf-acquisition-contract`          |    1 | 已单篇复现：HTTP 候选传入仅接纳 HTTPS 的下载组装边界                                       |
| `pdf-browser-flow-failed`           |    1 | Browser 在交付文档前失败，尚无更细根因证据                                                 |
| 合计                                |  161 |                                                                                            |

这张表按最终稳定错误码计数。相同的通用 reason 可能出现在不同错误码下，例如“页面无法打开”共出现 50 次，其中 48 次为 open failure、2 次为 navigation failure，不能把 reason 与 code 两种分组混加。

## 最终复核

- 三轮分别关闭 Application，再由独立 QueryApplication 读取该轮新增的 34、96、120 份 PDF；250 份的 SHA-256 均与 catalog 一致。
- 额外从文件系统独立流式读取全库 **456 份 PDF**，文件大小和 SHA-256 全部匹配。
- 操作前 206 份 `assets`、`artifact_objects` 和主 PDF 关联的所有原有记录保持不变。
- `PRAGMA integrity_check` 返回 `ok`；`foreign_key_check` 无违规；重复主 PDF 关联数量为 0。
- 文献数量仍为 630，数据库 schema 未迁移；本次未运行解析/分析、未修改个人配置或产品代码。

本次为明确授权的真实运行和文档记录，没有将真实 Provider/凭据/生产 catalog 纳入自动化 Harness。本轮不重复运行 Quick/Full；文档执行格式、链接和 diff 检查。已有工作区源码改动属于此前任务，不能把本轮运行记录当作那些改动的新 Full 结果。

## 已确认的问题

### 11 篇历史记录在读取阶段被拒绝

首次冻结目标时，已有的 11 篇 DataCite 来源记录因摘要含 LF/CRLF，被当前内部单行文本合同拒绝，错误路径为 `abstract`。这些内容已经存在于操作前备份，与本轮新下载无关。逐 ID 只读预检确认其余 413 篇可读，随后仅对这 413 篇发起获取。

这 11 篇单列为历史数据兼容问题，不算作出版社拒绝或下载失败。当前没有直接重写这些真实记录及其来源 hash。

### Elsevier 响应解析异常会中断整个操作

首轮处理到第 68 篇时，`10.1016/j.rser.2024.114783` 的 Elsevier Article API 返回 HTTP 200 XML。`elsevierMainObjects` 统计全文 XML 元素数超过 10,000，抛出 `AuthorizedProviderError(response-schema)`。

独立单篇复现的调用栈确认异常位于元素数上限分支。该异常未转换为单篇供应商结果，经 cohort 传播后被补全入口归为操作级 `pdf-acquisition-failed`，导致尚未开始的 345 篇停止调度；同组另一篇未完成文献也收到操作级失败。这不证明这些后续文献无法下载。

首轮已入库的 34 篇均保留，并由独立 QueryApplication 重开、流式读取和 SHA-256 验证通过。随后单独继续未开始的目标及同组受影响的另一篇；没有放宽 XML 上限、吞掉异常或更改生产实现。

### 历史 HTTP 线索在下载组装边界抛出合同异常

第一次续跑新增 96 篇，全部重开与 hash 校验通过，随后因 `10.1007/s002669900100` 再次停止。独立单篇复现确认，`direct` 来源产生了协议为 `http:`、主机为 `link.springer.com` 的候选；没有 fragment 或 userinfo。`assemblePublicPdfDownloadTransport` 要求 HTTPS，直接抛出 `TypeError`，补全入口将其归为操作级 `pdf-acquisition-contract`。

这篇尚未向下载目标发出请求，因此不能归因为出版社拒绝。失败候选的协议与下载端合同不一致，加上异常作用范围扩大，导致同组另外三篇及后续 174 篇无法正常完成该轮。第二次续跑仅移开已确认的故障目标，继续三篇受影响目标与未开始部分；没有修改原始线索或放宽网络边界。

### 批次等待影响吞吐和进度显示

本次观察到一批中只剩一两篇 Browser 慢任务时，后面的公开下载/API 目标仍等待当前批次结束。当前入口按有限 cohort 执行，这不是整个进程没有活动，但会降低真实混合队列的吞吐。

`acquireCohortInternal` 的 Browser wave 使用 `Promise.all` 完成后才发出该 wave 的结果回调。因此某篇主 PDF 已提交到 catalog，`progress` 仍可能暂时显示该目标处理中。本次以额外的只读数据库统计校对进度，最终再由独立读取和文件 hash 验证结算；不会仅凭回调计数推断文件是否存在。

## 证据

完整运行材料保存在 `/tmp/sciretriever-production-pdf-20261010-YkIOlN/`，不纳入 Git：

- 根目录 `scope.json`、`catalog-before.sqlite3`：原始精确目标和操作前一致性备份。
- `preflight.json`、`legacy-records.json`：可读目标与历史记录阻断证据。
- 根目录 `run.log`、`events.ndjson`、`report.json`、`result.json`、`reopen.json`：首轮实际下载、提前停止与 34 份文件重开验证。
- `diagnostic/`：Elsevier XML 元素数上限的独立复现及安全调用栈。
- `continuation-01/`：后续目标下载及其独立报告、重开验证。
- `diagnostic-url/`：历史 HTTP 候选触发 HTTPS 下载合同异常的单篇复现；只记录协议、主机与布尔字段，不记录完整 URL。
- `continuation-02/`：第二次整批中断后继续其余目标的记录。
- `overall-progress.json`：跨首轮、复现和续跑的累计数据库统计及逐目标最新状态，由监测脚本刷新。
- `target-results.json`：初始 424 个目标的逐篇最终结果、题名/标识、入库来源或失败原因。
- `final-audit.json`、`final-asset-checks.json`：最终分区、原记录保留、SQLite 完整性与 456 份文件的独立复核。
- `source-summary.json`、`failure-reasons.json`：来源数量/字节数与最终通用错误 reason 分布。

运行日志只记录稳定文献标识、主机、状态码、媒体类型、动作种类和经过限制的异常字段，不记录凭据、Cookie、授权头或完整签名 URL。系统临时目录中的材料可能被清理；本文将保留最终汇总与明确证据边界。
