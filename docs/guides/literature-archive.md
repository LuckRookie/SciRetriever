# 文献建档

获取 PDF、原始解析、建档是三个独立操作。建档只读取已有的原始解析，按校订、文档、结构、元数据、参考文献、标签的顺序发布材料，不启动 MinerU，也不生成全文总结。

建档与机器/Web 接口已接入，校订采用 DSH 看原图矫正；第二版小样本已在授权范围内验证。真实库转换和全量重建是独立维护步骤，现有用户库不会在启动时自动转换。

显式解析需要可用的 MinerU 连接；建档使用已有解析，并需要可用的 DSH 模型。校订的页面渲染还需要已通过安装校验的 CloakBrowser runtime：`SCIRETRIEVER_CLOAK_BUNDLE` 应指向包含 `chrome` 和安装清单的具体版本目录，而不是它的缓存父目录，安装方式见[安装指南](installation.md)。`parser-unavailable` 表示解析后端尚不可用；建档问题中的 `proofread-renderer-unavailable` 表示页面渲染 runtime 不可用。两者应分别检查，已完成的 PDF 接纳和解析不会因此撤销。

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
- `READY`：当前主 PDF 对应的校订稿、默认文档、结构、必填元数据和标签均满足要求；参考文献为空或疑点处置为无法确定不阻断就绪。
- `EXCLUDED`：勘误、社论、观点或评论类文章。人工修改文章性质后重新推导。

补充材料的缺失或失败不阻断正文就绪，问题条目标明 `affects_readiness: false`。人工修改区块、结构角色、元数据或标签，分别使用对应的校订、文档、元数据和标签命令；随后执行 `archive resume`。`archive resolve --request FILE` 接受 `{ "issue_ids": [...], "resolution": "continue" | "skip" | "cancel" }`，与任务介入使用相同的处理决定。确认或跳过问题不会补造缺失事实；取消会停止仍在运行的关联任务。

每个步骤保存输出和耗时。取消保留已完成的发布，恢复不重复执行输入、方法相同的模型步骤。单篇失败不阻断同批的其他文献。每批产生新标签后执行一次整理；整理失败单独记账，不撤销建档。

## 版本与统计

每个部分的内容版本由默认校订文档 ID 和结构注释 ID 决定；整篇描述版本由元数据 revision/hash 和标签分配 hash 决定。变化事件在原事实的数据库事务中保存。`archive events --after 0 --limit 100` 按递增序号读取，查询不生成事件、不触发重算。

`archive stats` 汇总解析页数和耗时、各建档步骤报告的模型调用/token、校订分类与整理状态。模型未返回用量的失败不能据此推算实际计费；统计不代表质量判定。

MCP 对应 `archive_query`（status/issues/stats/events）与 `archive_manage`（build/resolve/resume），共享 CLI 的应用边界。Web 已提供建档问题、显式解析与建档、统计以及元数据／标签／校订编辑入口，见 [Web 工作空间](web-workbench.md#建档标签与快照)。

[用户指南](README.md) · [解析与校订文档](document-processing.md) · [标签词表](tags.md)

文献库默认显示全部状态，可自行筛选已就绪文献。服务端结果接口返回六种文字核对状态及固定原文引用；片段不再保存“存疑”标记。第二轮 Web 正在接入新合同，界面与阅读引擎的验收尚未完成。

## 校订全文与单步处理

阅读器“校订”左侧保留原始 PDF，右侧逐页编辑 Markdown，可预览公式与表格。点击“保存修订”会比较当前校订版本；未变的区块保留原来源和锁，变动区块记为人工并锁定，拆合按删除与新增记录。保存后重建全文、无模型结构规则和参考文献，不重跑元数据或标签；旧结果按内容版本标为过时。并发版本变化会拒绝覆盖并保留当前草稿。保存成功但重建失败时，仍保留已保存版本，可从“单步处理”继续。

机器端用 `proofread text --request FILE|-` 有界读取完整校订稿，输入 `asset_id`，后续固定返回的 `proofread_id`，按 `next_start` 继续；单页默认 64 KiB、最多 256 KiB。`proofread save --request FILE|-` 输入 `literature_id`、`asset_id`、当前 `proofread_id`、完整 `markdown`，可带 `page_starts_utf8` 明确分页；全文最多 8 MiB。Web 保存入口单独接受最多 9 MiB 请求，其它 HTTP 上限不变。CLI/MCP 由入口绑定实际身份，无需手填 actor；细粒度 decide/revoke 仍可使用。读写对应 MCP `proofread_text` / `proofread_save`。
