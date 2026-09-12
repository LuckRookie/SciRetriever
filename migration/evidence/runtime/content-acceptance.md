# Literature 内容接纳与完整事务

> 本文件保留迁移期 Python 接纳函数的差分记录。当前生产内容接纳由 TypeScript Literature owner 直接执行，
> 不启动 Python；早期 bridge/测试统计仅用于追溯。

2026-09-10。阶段 05-03/05-05 的 Literature owner 切片，衔接现有正式 PDF / ParserResult / Detail。

## 当前能力

共享 contracts 新增闭合 `LiteratureContentProposal`、严格 parser 与 `analysisInputSha256`。Proposal 绑定
输入 LiteratureId、primary AssetId/hash、ParserResult hash、metadata revision/hash；包含最终 metadata、
sections、references、内容 hash、Markdown descriptor 与 Analysis provenance，但不携带权威输出 revision。
metadata/hash、内容/hash、来源 lineage 三者不匹配即拒绝，正文 Unicode 不被 NFC 重写。

`app.literatureContent.accept(proposal, markdownBytes, signal?)` 由 Literature 分配下一 metadata revision。
它复制可变输入，验证正式当前 Detail、PDF/ParserResult、metadata 基线、最终 metadata 可接纳性与实际
Markdown 字节；规范结构化 JSON 上限 16 MiB，与 Detail reader 一致。Markdown 亦有 16 MiB 发布上限。

通过不可变 FileStore 先发布规范结构化 JSON 与 Markdown，复用相同 hash/size/media 的既有正式 artifact。
随后 Storage 在一个 SQLite 事务内：

1. 再次检查 primary PDF ID/hash、当前 ParserResult、输入 metadata revision/hash。
2. 一起替换最终 metadata、下一 revision/hash、作者/机构/标识符/关键词、内容绑定、provenance 和引用文本。
3. 清理旧内容提供的引用支持，仅当引用失去所有 Provider/metadata/content 支持才删除该引用；相同内容
   manifest 的重新接纳保留支持。共享内容文本仅在没有其它 current binding 时清理。
4. 同步更新 metadata FTS 与正文 FTS。正文投影包含 section/subsection 的标题与正文，沿用 Python 的
   Unicode casefold、索引词规范化和分段换行规则。

任何事务内故障回滚完整 current view。旧原始 PDF、已发布解析文件和历史内容文件不原地覆盖；新文件已发布
而事务失败时可能留下未登记文件，重试可核对复用。提交开始后负责完成或报告失败，不宣称取消回滚已发布字节。
一次基线并发提交只允许一次成功；旧 proposal 重放被视为 stale。使用新基线再次接纳相同内容仍按现有 Python
合同推进 revision，同时保留该内容的引用支持。

## 直接验证

迁移期 `apps/server/test/literature-content.test.ts` 使用真实 Application / SQLite / FileStore / PDF inspector /
Python Parsing 规则 bridge，只有 Parser 输出和待接纳 Analysis proposal 为合成 fixture；当前生产路径改由
TypeScript 规则 owner 直接执行：

- 将同一当前 Detail/Proposal 交给实际 Python `decide_content_acceptance`，TS 得到相同 revision 和规范
  LiteratureContent JSON 字节；接纳后 Detail、关键词、状态和全文搜索一致，关闭重开后仍可读。
- 通过 SQLite trigger 在内容写入时强制失败，验证 metadata、关键词、内容、Detail 和 FTS 一起回滚。
- 真实文件异字节冲突保留原文件；取消、损坏 bytes、错 metadata hash、错 provenance lineage、错 primary、
  错 parser hash、额外 revision 字段都拒绝，既有事实不变。
- 发布文件后、事务前改变实际 primary 关系，验证 CAS 拒绝；同一基线两个真实并发 accept 只有一个成功。
- 相同 manifest 重接纳保留引用支持；替换内容只删除失去全部证据的引用，metadata 支持的引用继续存在。
- 调用 accept 后立即修改原始 proposal 与字节数组，正式发布仍采用调用时复制的输入。

`literature-detail.test.ts` 和 `literature-reference-query.test.ts` 联合回归通过。
没有新增 v1 schema、依赖或生产入口变化；未触碰真实 catalog、用户语料、Provider/LLM。

## 后续闭环与边界

Analysis 两阶段执行、metadata 保护、模型响应校验和 canonical Markdown renderer 已由
[Analysis bridge](analysis-execution.md)接入；[Entry 分析接纳](content-analysis-entry.md)、
[NoUsableContent 协调清理](no-usable-content-entry.md)及
[Browser→MinerU→Analysis 联合旅程](browser-mineru-analysis-journey.md)继续复用本 owner。阶段 05-05 的
source-checkout 首阶段旅程已经闭环；真实外部服务和安装包自含 Python/Cloak runtime 仍不在支持声明内。

## 本次全量验收

`SCIRETRIEVER_CLOAK_BUNDLE=/home/duanjw/.sciretriever/cloakbrowser-cache/chromium-146.0.7680.177.5 pnpm full`
通过：67 个测试文件、243 项测试，含实际 Cloak / MinerU loopback、配置 owner、离线包安装和本次内容接纳。
Quick、源码/测试 strict 类型检查及 build 全部通过。日志：`/tmp/sciretriever-content-full.log`。
未运行 Python Quick/Full/unittest；差分仅由 Vitest 调用实际 Python 纯接纳函数。
`git diff --check` 通过；无提交、推送、PR 或生产操作。
