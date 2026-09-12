# NoUsableContent 的当前事实清理事务

> 本文件中的 Python Parser/Analysis 词句属于迁移期历史测试说明。当前清理由 TypeScript Literature/Entry owner
> 直接执行；不启动 Python，早期统计仅用于追溯。

2026-09-10。阶段 05-03/05-05 的 catalog 清理切片，接续 [Entry 分析接纳](content-analysis-entry.md)。

## 已实现的边界

`app.literatureCleanup.cleanup({outcome: "no_usable_content", input}, signal?)` 只接收明确业务判定及闭合
`AnalysisInputIdentity`。普通 Analysis/Parser 失败对象不能进入此入口。输入复制并验证后，由 Storage 在
同一读取事务返回当前 Detail/content binding、完整出站引用及支持、FTS 和内部闭合快照 token。

Literature 复用完整详情的同一验证函数，读取实际规范 content 文件并校验 metadata/content/hash/lineage，
核对 Analysis 的六项输入基线及完整 FTS 投影。出站引用数量必须包含全部实际引用；无支持的孤立引用
不能通过查询过滤而被当成完整闭合。Literature 决定移除旧 content 的哪些支持，以及哪些引用将失去全部
支持。Storage 只执行并复核这份决定，不形成新的业务判定。

提交使用短 `BEGIN IMMEDIATE` 事务，再读完整闭合并核对 token 与输入基线。metadata、主 PDF/关系、
Parser/resources/provenance、当前 content、引用支持、artifact 登记或 FTS 任何变化都会使旧命令失效。
事务按依赖顺序完成：

1. 删除该 Literature 旧 content 提供的出站引用支持；仅删除失去全部支持的相应引用。
2. 移除当前 content 绑定；没有其它 current binding 时删除共享内容引用文本。
3. 移除该主 Asset 的 ParserResult/resources、该 Literature 的主 PDF 关系；清空正文 FTS。
4. 只有最终正式关系消失才删除 Asset 登记；只有已无正式引用才删除相关 artifact/provenance 登记。

metadata、revision/hash、metadata observation、其它来源的引用证据和入站引用均保持原事实。共享字节和
共享 provenance 的登记保留。ParserResult 按 Asset 归属；若另一 Literature 当前 content 仍依赖该 Asset，
本次清理拒绝，避免使另一当前结果失效。同一输入并发清理只允许一次成功；重放返回 stale。
所有事务中途失败都回滚已删除的关系、内容、Parser、FTS 和对象登记。

结果为 `catalog_cleaned`、输入身份及失去登记的 artifact 描述符/相对引用，**仅证明 catalog 事务已完成**。
物理文件此时仍保留。文件回收必须在业务发布操作结束后，取得[共同写入准入](catalog-write-admission.md)，
并在该准入内重新核对无引用和无在途发布；后续[显式描述符回收](artifact-reclamation.md)已接入此边界。
Candidate/receipt 关联处理和 Entry 编排已由[后续切片](no-usable-content-entry.md)接入，
本次清理的[重启恢复](artifact-recovery.md)与[有界后续候选旅程](literature-completion.md)已接入；其它无清单
孤立文件的全盘回收因缺少可证明的删除边界而明确 Deferred。

## 同时修复的 artifact 复用

共享对象测试暴露 `writeLiteratureAsset` 把 Asset ID 等同于 artifact ID。现在遇到已登记路径时，先验证
hash/size/media 一致后复用该 artifact；不同字节或描述符继续拒绝。只有新路径才创建新的 artifact 登记。
该行为符合现有 v1 独立 Asset/artifact 身份，无 schema 或兼容格式变化。

## 直接测试

`literature-cleanup.test.ts` 十三项测试使用实际 Application、SQLite、FileStore、PDF inspector、Python
Parser 规则和已接纳 content；所有输入在系统临时 home 中生成：

- 有/无旧 content 两种清理，metadata 保持一致，关闭重启后仍可读；重复清理拒绝。
- 在 Parser、主关系、artifact、provenance 删除阶段用真实 SQLite trigger 强制失败，验证完整回滚。
- 在提交前真实修改 FTS、metadata revision、Parser hash，验证旧命令无法清理新状态。
- 非业务判定、错误输入 hash、预取消、损坏 FTS、孤立引用闭合均拒绝。
- 共享主 PDF、作为另一 Asset 的 Parser Markdown 和其它 metadata 引用支持保留。
- 同一基线两个并发清理只有一个成功；另一当前内容依赖共享 Parser 时拒绝。

迁移期 `analysis-service.test.ts` 的实际 Python Analysis 无可用内容分支曾将真实判定直接交给清理入口；当前
TypeScript Analysis 同样将判定交给清理入口，验证主 PDF/Parser/content 从 catalog 移除且 metadata 不变。普通
metadata/正文失败分支仍保留此前全部事实。
`literature-content.test.ts` 与清理测试复用 `content-fixture.ts`，没有复制第二套业务实现。

没有新增依赖或 schema，没有生产切换、真实 Provider/LLM/MinerU/用户 catalog 操作。

## 本次全量验收

`SCIRETRIEVER_CLOAK_BUNDLE=/home/duanjw/.sciretriever/cloakbrowser-cache/chromium-146.0.7680.177.5 pnpm full`
通过：72 个测试文件、282 项测试。TS Quick、源码/测试 strict 类型检查、真实 Cloak、Analysis loopback、
配置 owner、离线安装、catalog 清理和 build 全部通过。日志 `/tmp/sciretriever-cleanup-full.log`。
`git diff --check` 通过；未运行 Python Quick/Full/unittest，未 commit/push/PR 或执行生产操作。
