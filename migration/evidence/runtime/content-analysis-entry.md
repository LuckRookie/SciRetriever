# Entry 分析接纳入口与精确输入判定

2026-09-10。阶段 05-03/05-05 的 Entry 组装部分。

`app.contentAnalysis.analyzeCurrent(literatureId, signal?)` 连接实际 AnalysisService 与 LiteratureContentService。
当配置显式组装 `analysisRuntime` 时同时提供此入口，否则为 null。Entry 解析 LiteratureId，将取消信号
传入 Analysis，并核对返回结果属于请求文献；Proposal 交给 Literature owner 的既有 hash/lineage/事务
接纳入口，成功返回 `content_accepted` 与正式 LiteratureContent。接纳事务已开始后报告实际提交结果，
不会因为随后到达的取消把已提交内容误报为未提交。

共享 contracts 新增闭合的 `AnalysisInputIdentity`，包含 LiteratureId、primary AssetId/PDF hash、Parser
result hash、metadata revision/hash。Proposal 复用此类型；Analysis 的 `no_usable_content` 分支现在
同时返回经过验证且冻结的输入基线。Entry 不接受另一个 Literature 的判定，也不把普通异常转为该分支。

`ContentAnalysisService.close()` 取消进行中的分析并等待其结束，再允许 Application 关闭底层资源。
关闭后的新调用被拒绝；调用前已经取消时不启动 Analysis。Application 已提供后续 cleanup port，明确无内容
决定会自动进入[协调清理](no-usable-content-entry.md)，成功返回 `no_usable_content_cleaned`。未提供 cleanup
port 的独立服务仍仅返回决定，不声称已删除文件。

## 验证

- `analysis-service.test.ts` 的实际配置 → loopback 两阶段模型 → canonical Markdown → Literature 内容
  接纳测试已改为使用 Application 的 Entry 入口，不再由测试手工执行两次服务调用。
- 原有无可用内容测试检查返回的六项输入身份，与实际分析前 Detail 完全一致，已有事实保持不变。
- `content-analysis-entry.test.ts` 四项测试覆盖结果/输入不可变、跨文献结果拒绝、普通 Analysis 失败、
  关闭等待、预取消、无效输入合同，以及 no-content 分支不调用 content acceptance。
- 新增 contracts 导出后，直接 Vitest 首次因开发包 dist 尚未构建失败；运行正常 TS Quick 构建后重验。

没有新增依赖、持久 schema 或生产入口切换。后续已实现
[NoUsableContent Entry](no-usable-content-entry.md)：Application 会协调 catalog/execution 原子清理与物理回收。
[重启自动恢复](artifact-recovery.md)、[有界 Candidate 后续重试](literature-completion.md)和
[Browser→MinerU→Analysis 联合旅程](browser-mineru-analysis-journey.md)也已完成，阶段 05-05 的首阶段边界闭环。

## 本次全量验收

`SCIRETRIEVER_CLOAK_BUNDLE=/home/duanjw/.sciretriever/cloakbrowser-cache/chromium-146.0.7680.177.5 pnpm full`
通过：71 个测试文件、269 项测试。TS Quick、源码/测试 strict 类型检查、实际 Cloak 工作台、配置/网络/
业务测试、离线安装和 build 全部通过；日志 `/tmp/sciretriever-entry-analysis-full.log`。
`git diff --check` 通过。未运行 Python Quick/Full/unittest；未 commit/push/PR 或触碰真实数据。
