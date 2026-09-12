# TypeScript Analysis 运行证据

2026-09-11 起，Application 在配置具备完整 Analysis 预算时自动组装 `AnalysisService`。`AnalysisOptions` 只接受 TS 超时和预算；`AnalysisService` 已删除 Python executable、module path、bridge 开关、subprocess 和 `sciretriever.entry.analysis_bridge` 调用。该生产路径由 TypeScript `AgentRuntime` 直接执行两阶段结构化调用：

1. 读取已校验 Parser Markdown，并检查输入 hash、预算和当前 Literature 快照；
2. 执行 metadata stage，保留已有书目事实，要求新增值在解析文本中有证据；
3. 执行 content stage，解析固定 H1/H2 正文和有序参考文献，并检查参考文献文本与输入对齐；
4. 由 TypeScript 固定渲染 canonical Markdown，按 hash 发布不可变 artifact；
5. 生成带输入 hash、模型身份和参数 hash 的 `LiteratureContentProposal`，交给 Literature owner 完成事务接纳。

对应实现：

- `apps/server/src/analysis/service.ts`
- `apps/server/src/analysis/ts-rules.ts`
- `apps/server/src/bootstrap/application.ts`

离线验证：

```text
pnpm exec vitest run apps/server/test/analysis-service.test.ts
pnpm exec vitest run apps/server/test/literature-completion.test.ts
pnpm exec vitest run apps/server/test/analysis-rules.test.ts apps/server/test/content-analysis-entry.test.ts
pnpm quick
pnpm full
```

上述测试覆盖 loopback 模型、无可用内容、元数据篡改、正文草稿拒绝、输入变化、预算和关闭取消；`analysis-rules.test.ts` 进一步覆盖 HTML heading、fenced code、DOI、arXiv、PMID/PMCID、measurement、formula、standalone number 和 reference 对齐。Analysis 只返回 proposal 或 `no_usable_content`，由 Literature owner 再检查输入 identity 并接纳，模型原始文本不能直接写成 current content。阶段失败、陈旧输入和取消均不会撤销 PDF、ParserResult 或旧 Content。

旧 `src/sciretriever/entry/analysis_bridge.py` 按 `migration/retirement-report.json` 作为历史 Python 文件保留，TS 源码和测试已无调用方，也不进入生产包。全业务 inventory 的逐文件处置由 T045/T061 记录，不影响 T042 的生产能力关闭。
