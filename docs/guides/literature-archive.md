# 文献建档

获取 PDF、原始解析、建档是三个独立操作。建档只读取已有的原始解析，按校订、文档、结构、元数据、参考文献、标签的顺序发布材料，不启动 MinerU，也不生成全文总结。

建档与机器/Web 接口已接入，校订采用 DSH 看原图矫正；第二版小样本已在授权范围内验证。真实库转换和全量重建是独立维护步骤，现有用户库不会在启动时自动转换。

## 发起与恢复

```bash
pnpm sciretriever archive build LITERATURE_ID
pnpm sciretriever archive status LITERATURE_ID
pnpm sciretriever archive issues --part main
pnpm sciretriever archive resume LITERATURE_ID
pnpm sciretriever archive stats
```

CLI 等待所提交的持久任务结束；MCP 和 Web 应用边界返回任务编号，沿用已有任务的暂停、继续、取消与重试入口。一次选择最多 10,000 篇，超过上限会拒绝，不截断范围。显式 ID 列表用逗号分隔；复杂筛选使用 `archive build --request FILE`，文件为：

```json
{
  "selector": { "kind": "literatures", "literature_ids": ["00000000-0000-0000-0000-000000000001"] },
  "mode": "full",
  "from_step": null,
  "idempotency_key": "archive-reviewed-batch-1"
}
```

`selector` 也可为 `{ "kind": "query", "query": LibraryQuery }`。`from_step` 可选择 `proofread`、`document`、`structure`、`metadata`、`references`、`tags`，用于显式重做该步骤及后续步骤。正常恢复不填此项，由当前输入和已保存回执决定复用。

`full` 要求正文已有部署 profile 的原始解析或可定位的已登记旧 Markdown。旧材料使用 `--mode legacy-vlm-markdown`，只要求已登记的 VLM Markdown，不要求 pipeline。页归属无法确定时报告 needs-parse。缺少这些材料时，成员回执是 `needs-parse`，不会代为解析。

## 状态与问题

- `UNREVIEWED`：没有主 PDF。
- `ASSET_READY`：已有主 PDF，尚缺解析或建档步骤。
- `ARCHIVING`：正在建档。
- `ARCHIVE_FAILED`：正文存在尚未解决的失败。
- `READY`：当前主 PDF 对应的校订稿、默认文档、结构、必填元数据和标签均满足要求；参考文献为空或有存疑不阻断就绪。
- `EXCLUDED`：勘误、社论、观点或评论类文章。人工修改文章性质后重新推导。

补充材料的缺失或失败不阻断正文就绪，问题条目标明 `affects_readiness: false`。人工修改区块、结构角色、元数据或标签，分别使用对应的校订、文档、元数据和标签命令；随后执行 `archive resume`。`archive resolve --request FILE` 接受 `{ "issue_ids": [...], "resolution": "continue" | "skip" | "cancel" }`，与任务介入使用相同的处理决定。确认或跳过问题不会补造缺失事实；取消会停止仍在运行的关联任务。

每个步骤保存输出和耗时。取消保留已完成的发布，恢复不重复执行输入、方法相同的模型步骤。单篇失败不阻断同批的其他文献。每批产生新标签后执行一次整理；整理失败单独记账，不撤销建档。

## 版本与统计

每个部分的内容版本由默认校订文档 ID 和结构注释 ID 决定；整篇描述版本由元数据 revision/hash 和标签分配 hash 决定。变化事件在原事实的数据库事务中保存。`archive events --after 0 --limit 100` 按递增序号读取，查询不生成事件、不触发重算。

`archive stats` 汇总解析页数和耗时、各建档步骤报告的模型调用/token、校订分类与整理状态。模型未返回用量的失败不能据此推算实际计费；统计不代表质量判定。

MCP 对应 `archive_query`（status/issues/stats/events）与 `archive_manage`（build/resolve/resume），共享 CLI 的应用边界。Web 已提供建档问题、显式解析与建档、统计以及元数据／标签／校订编辑入口，见 [Web 工作空间](web-workbench.md#建档标签与快照)。

[用户指南](README.md) · [解析与校订文档](document-processing.md) · [标签词表](tags.md)
