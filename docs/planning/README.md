# 执行计划目录

`docs/planning/` 只保存已有明确批准记录的活动执行计划。当前行为仍以代码和 [README](../../README.md) 为准；执行计划只说明获批顺序、依赖、验收和回退，不承担实施进度追踪。实际覆盖和差距统一记录在[实施进度](../governance/implementation-progress.md)。

## 文件元数据

除本 README 外，每份 Markdown 执行计划必须从第一行开始使用 TOML front matter：

```toml
+++
document_type = "execution-plan"
status = "approved"
owner = "project owner"
approved_by = "project owner"
approved_on = "2026-07-23"
approval_ref = "owner-confirmation"
source_proposal = "../proposals/literature-library-product.md"
requirements = ["../specs/requirements.md"]
+++
```

活动执行计划的授权状态只允许 `approved`。`in-progress`、`blocked`、完成比例和工作包状态属于[实施进度](../governance/implementation-progress.md)，不得写入计划 front matter。计划完成、取消或被替代后必须移出本目录。每份计划必须包含以下二级标题：

1. `## 目标与非目标`
2. `## 工作包`
3. `## 验收与验证`
4. `## 发布与回退`
5. `## 进度引用`

## 当前执行计划

- [以 Work 为中心的文献库执行计划](literature-library-execution.md)，计划生命周期为 `approved`；实际实施状态见[实施进度](../governance/implementation-progress.md)。

旧下载任务路线和相关材料已移入 [2026-07 下载路线归档](../archive/2026-07-download-roadmap/README.md)，不再是活动计划或实施依据。
