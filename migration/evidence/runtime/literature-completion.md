# 有界 Candidate → Literature 内容补全

> 本文件保留早期补全切片的 Python Parser/Analysis oracle 记录。当前生产补全路径由 TypeScript
> Parser、Analysis 和 Literature owner 组装，不启动 Python；历史统计仅用于迁移追溯。

2026-09-10。阶段 05-05/05-07，将已落盘的 Browser Candidate、主 PDF 接纳、Parsing、实际 Analysis、
NoUsableContent 清理与内容接纳串成一个 Entry 调用。

## 入口与对象图

Application 在 execution、Parsing 和 Analysis 三项运行能力均已明确组装时提供
`app.completion.complete({ literature_id, transfer_ids }, signal?)`。否则 `completion` 为 null，不伪造运行能力。
输入是一个 Literature 与至多 1,000 个有顺序的已持久化 transfer ID；本入口不声称覆盖全体 Provider 或自动发现路径。
同一服务实例内，同一 Literature 的并行调用会明确冲突，不并发调用模型争夺同一当前输入。

Entry 先读当前完整 Detail。已有有效 content 时直接返回 `content_ready`；已有主 PDF 时先处理该 PDF。
缺少主 PDF 时按提供顺序调用实际 CandidateAcceptanceService，从真实 PDF 字节与 DOI/版本证据决定接纳，
并使用当前 metadata revision/hash CAS 发布。Parser 已存在时复用，否则 prepare/commit 当前正式 PDF；
Analysis 从正式 Parser 开始，内容结果仍由 Literature owner 接纳。

明确无可用内容时，ContentAnalysis 的协调清理在同一个写入边界完成 catalog/execution 删除和文件回收，
随后本入口继续下一 PDF。临时 tried hash 集合只存在于当前调用中；提前冻结候选的身份使清理后已删除的
同字节重复 Candidate 能被跳过，不会重新读取已删文件或立即重复分析。新调用重新建立集合，仍允许重新发现。

结果：

- `content_ready`：返回实际正式 content，以及本次临时尝试结果；正常重复调用不再运行 Parser/模型。
- `supplied_candidates_exhausted`：仅表示所提供的候选列表已用完，不等于全部自动路径耗尽，不写
  automatic_pdf_acquisition_exhaustions，不触发跨版本回退。

尝试结果区分 no_usable_content、重复输入、Candidate 已不存在、owner 明确 rejected/uncertain 和内容接纳。
当前保守身份 owner 把 DOI 不同、缺失或版本不匹配视为 uncertain；该结果不会被本入口擅自提高为明确拒绝。
这些报告不保存到 catalog。Parser/模型/Storage/Network 普通失败原样终止操作，保留已提交的 PDF/Parser，
不会借失败尝试下一版本或删除输入。基本 PDF 验证的异常目前也按运行失败停止，不猜测是坏文件还是工具不可用。

关闭入口会取消并等待进行中的操作，Application 先关闭 completion 再关闭其下游服务与存储。模型等待中关闭
已验证会保留当前主 PDF；取消若与最终内容提交竞争，则沿用接纳 owner 的实际提交结果。

## 直接旅程证据

迁移期 `literature-completion.test.ts` 8 项使用实际 Application、真实 pdfinfo/pdftotext、Python Parser 产物规则、
Parser fixture port、Python AnalysisService、配置 owner、TS OpenAI adapter 和本地 HTTP 模型 fixture；当前生产
路径由 TypeScript Parser/Analysis owner 提供：

- 第一份 PDF 通过主资产准入但被模型明确判为无可用内容，清理后跳过同字节重复 Candidate，再处理另一份 PDF；
  两次 Parsing、三次模型请求后得到正式 content，查询命中正文，provenance input hash 对齐实际主 PDF、Parser
  与最终 metadata hash；无效 Candidate 文件已删除，关闭重启后 Detail 相同且无 pending receipt 需要重放。
- 当前已有正式 PDF 的同样旅程，报告第一步来自 current；相同字节候选不会被重试。
- 已有有效内容直接返回，Parser/模型调用计数保持不变。
- Parser 和 HTTP 模型错误分别保留当前 PDF、已提交 Parser 和后续候选，不前进到下一候选。
- 提供列表耗尽后状态仍 UNREVIEWED；新调用重新捕获相同 hash 后可再次处理，无永久黑名单。
- 重叠调用拒绝；模型等待期间关闭会取消、等待并保留当前 PDF；关闭后的新调用拒绝。
- 非法输入、超出候选边界和预取消在发布前拒绝。
- DOI 不同与缺失证据分别通过真实 PDF 文本检查，均保持 uncertain，未调用 Parser/模型。

测试最初使用了错误的 content 字段名和状态名，并错误假设 DOI 不同必然 rejected；已依据当前闭合合同、
provenance 输入公式和保守身份 owner 修正断言，没有改变上述 owner 规则或降低检查。

## 当前限制

本切片从已落盘 Candidate 开始；后续[真实 Browser→MinerU→Analysis 联合旅程](browser-mineru-analysis-journey.md)
覆盖 Browser Candidate、实际 MinerU HTTP、两阶段 Analysis 和 Library query，工作台又覆盖 accepted 发布与
uncertain 放弃。Provider 自动候选枚举、完整自动选文、细粒度进度 UI 和 npm 包自含 Python/Cloak runtime 明确
Deferred，不属于阶段 05-07 的 source-checkout 首阶段退出条件。

没有新增依赖、持久 job/attempt 表、业务 schema、生产切换或 Git 提交。全部数据和网络为合成临时 home/loopback，
没有 Python Quick/Full/unittest 或真实 Provider/LLM/MinerU 请求。

## 全量验收

TS Full 成功退出：77 个测试文件、337 项测试通过；Quick、源码与测试 strict 类型检查、实际 Cloak loopback、
配置 owner、离线安装和最终 build 均通过。日志 `/tmp/sciretriever-completion-full.log`。
`git diff --check` 通过；未运行 Python Quick/Full/unittest，未修改依赖锁文件或执行 Git 提交。
