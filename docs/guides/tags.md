# 标签词表与文献打标

类型：指南
负责：词表查询、打标与标签维护操作
状态：现行

标签是库中的领域主题，与“问答标注”处理器的结果不同。打标读取校订稿的摘要、引言和结论及作者关键词，先提出主题，再检索词表并决定吸附或创建。原始 PDF 和解析不会被这一步自动启动。

章节输入按完整片段限量读取：每类章节最多 64 KiB，片段正文合计最多 256 KiB；没有摘要、引言或结论标注时，退回到最多 8 个非参考文献、非前置信息片段。超过上限的片段不会被截成半段，也不会阻止读取后续仍能纳入的片段。没有任何可用片段时明确返回 `tag-input-empty`。

打标回执的 `input_coverage` 记录固定文档与结构注释 ID、实际纳入的片段 ID、各章节的可用与读取字节数，以及上限造成的遗漏数量；建档步骤结果也保留该记录。`truncated` 只说明输入有所省略，不是标签质量评分，不能把受限输入描述为全文覆盖。

CLI 可以只读浏览、查询文献分配和预览回溯：

```bash
pnpm sciretriever tags list --limit 50
pnpm sciretriever tags search "photoredox"
pnpm sciretriever tags show TAG_ID
pnpm sciretriever tags changes --since 0 --limit 100
pnpm sciretriever literature tags LITERATURE_ID
pnpm sciretriever literature search --tag TAG_ID --tag-mode any
pnpm sciretriever tags backfill TAG_ID --dry-run
```

`--tag` 可重复，可以填写名称或同义词；合并标签解析到存续 ID，上级包含下级。`--tag-mode primary` 只匹配第一标签。筛选回执的 `tag_backfill_pending` 提示创建该标签前已打标、尚未对照过它且位于结果集外的文献数，不代表确定漏检数。

写操作须显式发起：

```bash
pnpm sciretriever tags edit --request tag-edit.json
pnpm sciretriever tags undo --request tag-undo.json
pnpm sciretriever literature tags set --request assignment.json
pnpm sciretriever literature tags lock --request assignment-lock.json
pnpm sciretriever tags consolidate
pnpm sciretriever tags backfill TAG_ID --execute
```

词表编辑请求为 `{mutation, expected_version, reason}`。`mutation.op` 支持 `create`、`merge`、`set-parent`、`set-category`、`edit-definition`、`rename`、`set-lock`、`undo`。撤销使用 `{op:"undo", change_version, cascade:false}`；存在后续依赖时先返回依赖版本列表，再由用户选择是否 `cascade:true`。后续人工修改过的分配不能被旧撤销覆盖。

文献设置请求为 `{literature_id, items, expected_revision, expected_version, reason, model:null}`；每个 item 提供标签 ID、顺序、理由和校订稿片段证据。人工设置标记为 `manual` 并锁定。单项锁定请求为 `{literature_id, tag_id, locked, expected_revision}`。排序从 1 连续编号。模型不能删除或移动锁定项。

MCP 的 `tags_query` 和 `tags_manage` 与上述 CLI 共用应用边界，均接受 `{operation, request}`。只读工具支持 `list/search/show/state/changes/assignment/assignment-detail/backfill-preview`；维护工具支持 `change/assign/lock/build/consolidate/backfill`，需要维护权限。`build` 提供 `{literature_id, document_version_id, annotation_id}`，只接受当前正文校订稿，不隐式解析。

`assignment-detail {literature_id}` 返回一篇文献当前每个标签的理由、依据（全文版本与片段编号）、来历与是否锁定；依据所指的全文已不是当前版本时带过期标记。来历有三种：`auto`（模型按全文标注）、`backfill`（模型按题名、摘要与关键词补标）、`manual`（人加的，或人在编辑、锁定时保存下来的，两者不区分）。文献库页右栏的“依据”读的就是它；文献条目里的每个标签只带来历、是否锁定与依据条数。

模型与数量字段统一见[配置手册](configuration.md#标签模型与数量)。

三类任务均使用共享 DSH；没有新增 Agent 后端。回溯预览不调用模型，执行按文献合并相关标签判断。新增分配的证据必须能定位到校订稿中的元数据文本；没有支持片段会拒绝发布。模型使用次数、输入与输出 token 单独记录，不将配置预算当作实际用量。

自动整理可以合并、设上级、归类或修正定义，遇到人工锁定会记录 `skipped-locked`。定义变化后复核已带该标签的文献。新标签不自动全库回溯。

[用户指南](README.md)
