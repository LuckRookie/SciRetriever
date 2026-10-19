# 知识分析与综合

针对明确选择的已有材料生成单篇知识、长文知识及集合综合，保留输入和证据关系。

## 内容入口

- [service.ts](service.ts)：已有 Analysis 服务与兼容路径。
- [knowledge.ts](knowledge.ts)：单篇知识加工入口。
- [knowledge-session.ts](knowledge-session.ts)：单篇/长文共用 DSH 持续阅读，提供正文分页、回读、检索、保存图片与最终提交工具；原固定分块/分层合并实现已删除。
- [reading-image.ts](reading-image.ts)：验证已保存栅格资源的图像头并向 DSH 提供实际图片字节。
- [synthesis.ts](synthesis.ts)：集合知识综合。

## 放置边界

模型协议由 agents 实现，固定文档由 document 提供；读取缺口不隐式触发发现或下载。

相关说明：[所属技术文档](../../../../docs/architecture/technical/05-knowledge-processing.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)

- `processor*.ts`：可信处理器注册、冻结输入、结果接纳、知识分析接入与默认标签/记录提取；只读取已有材料。批量生命周期在 `application/jobs/`。

`processor-export.ts` 保持完整结果导出封套，并向三个入口提供固定引用的有界只读传输；字节读取与完整性校验仍由 Storage 提供。

新知识方法为 `dsh-document-analysis` v1，综合方法为 v3。旧结果保留但不会作为新方法的缓存命中。正文覆盖检查不等于科研语义正确；图片能力/资源限制以 coverage 缺口说明。
