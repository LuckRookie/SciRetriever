# NoUsableContent 的执行记录清理与 Entry 编排

> 本文件中的 Python Analysis 旅程是迁移期历史 oracle。当前 Entry、Analysis 和清理 owner 均由 TypeScript
> Application 组装，安装包和默认 TS 验收不启动 Python。

2026-09-10。阶段 05-03/05-05，衔接实际 Analysis、Literature 清理 owner 和受控文件回收。

## 对象图与业务边界

Application 的 `app.noUsableContent.cleanup(result, signal?)` 接受带完整六字段输入身份的明确
`no_usable_content` 结果。`app.contentAnalysis.analyzeCurrent` 在 Analysis 返回这一结果后自动调用该入口。
正常内容仍由 Literature 接纳；Parsing/Analysis 异常、取消、无效输入均不被解释为无可用内容。
单独构造且未提供 cleanup port 的 `ContentAnalysisService` 仍返回原始中性决定，供其它 Entry 组装。

Entry 持有共同 Catalog 写入准入，依次执行：

1. Literature 的 `prepare` 核验完整当前 Detail/content/FTS/引用，形成清理命令和闭合 token。
2. Acquisition 的 `prepareCandidateCleanup` 解析全部 execution Candidate/intent/result，核验记录键与关联身份，
   决定本 Literature、当前 PDF hash 对应的执行记录删除集合。
3. Storage 在一个短事务内重新验证完整闭合（含 execution 原始记录），核对准确删除集合，原子移除
   receipt、Candidate 与当前 PDF/Parser/content 相关事实。
4. BrowserTransferCollector 忘记已删除的缓存 Candidate；File Reclaimer 重新检查正式与 execution 引用，
   回收不再使用的正式文件和 Candidate 文件。

成功返回 `no_usable_content_cleaned`、输入身份和 `deleted/preserved/missing` 回收结果。其它 Literature
仍使用的对象保留；不存在跨文献的 hash 黑名单。低层 `literatureCleanup.cleanup` 如果发现需要处理执行记录，
但没有经过协调提供准确 Acquisition 决定，会原子拒绝；不得只清理业务行而留下可恢复的旧 receipt。

## 删除范围与恢复语义

本 Literature + 当前 PDF hash 的已提交和未提交 receipt 都被删除。Candidate 仅在 hash 相同、没有保留的
receipt、且 capture.article_id 属于本 Literature 时删除；没有 capture 的 Candidate 必须由待删 receipt
证明归属。其它文献的 capture/receipt、不同 PDF hash 以及无法证明归属的记录保留。多个同输入 Candidate
会一起清理，但同一文件只进入一次回收列表。

执行记录与正式事实在同一个 SQLite 事务内提交，清理后重启 publisher 对账不能恢复已失效输入。旧 receipt
和持有的旧 Candidate 不能重新发布；缓存 `complete` 也必须核验当前 durable 登记。后续新运行可重新捕获
同一 PDF，不保存无效来源、决定或永久黑名单。

SQL 提交前取消不清理；提交后取消仍完成文件回收并报告实际提交结果。文件回收失败返回
`NoUsableContentReclamationFailure`，明确 catalog 已提交，携带原始 retired 描述符供
`app.artifactReclaimer.reclaim` 重试，不能假装关系已回滚。成功删除会移除隔离 identity marker 和空目录；
中断/冲突时才保留证据，不形成已拒绝 PDF 的长期删除历史。

## 证据

`no-usable-content.test.ts` 11 项覆盖：

- 正式发布和 pending receipt、重复 Candidate 的联合清理，文件删除、缓存失效和重启后不可重放。
- 新运行能再次捕获相同 PDF，证明没有永久黑名单。
- execution_receipts、execution_candidates、parser_results 三处真实 SQLite trigger 故障，全部事实与执行记录回滚。
- 低层未经协调的清理拒绝；准备后新 Candidate 导致 CAS stale；损坏 execution 身份拒绝。
- 另一文献的同 hash Candidate/receipt/文件保留；遗漏或额外的删除命令拒绝。
- 文件回收失败准确报告已提交并成功重试；SQL 提交后的取消仍完成回收。

迁移期 `analysis-service.test.ts` 曾验证实际 Python Analysis → TS Entry → catalog 与物理清理旅程；当前测试验证
TypeScript Analysis → Entry → catalog 与物理清理旅程，只调用第一阶段模型。
`artifact-reclamation.test.ts` 增至 17 项，额外验证 marker 删除后、空隔离目录尚未删除时的中断恢复。
所有数据位于合成临时 home；没有 Python Quick/Full/unittest，没有真实 Provider/LLM/MinerU 网络。

## 剩余范围

[重启恢复](artifact-recovery.md)已支持 NoUsableContent 清理，不再依赖调用者保存描述符；
其它无清单孤立文件的通用回收因缺少安全删除边界而明确 Deferred。当前处理一个已给定的 Analysis 输入；
[有界候选补全](literature-completion.md)已组装单次运行临时 hash 集合和下一 PDF 重试；
Browser source-checkout 联合旅程和 Web 发布/放弃入口已完成。Provider 自动枚举与 npm 包自含 Python/Cloak
runtime 的安装后旅程明确 Deferred。
没有新增持久 schema、依赖包、生产切换、Git 提交或外部写操作。

## 全量验收

TS Full 成功退出：75 个测试文件、317 项测试通过；Quick、源码/测试 strict 类型检查、实际 Cloak loopback、
配置 owner、离线安装以及最终 build 均通过。日志 `/tmp/sciretriever-no-content-full.log`。
`git diff --check` 通过；没有运行 Python Quick/Full/unittest，也没有修改依赖锁文件或执行 Git 提交。
