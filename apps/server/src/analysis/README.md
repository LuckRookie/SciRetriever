# 知识分析与综合

针对明确选择的已有材料生成单篇知识、长文分层结果及集合综合，保留输入和证据关系。

## 内容入口

- [service.ts](service.ts)：已有 Analysis 服务与兼容路径。
- [knowledge.ts](knowledge.ts)：单篇知识加工入口。
- [knowledge-long.ts](knowledge-long.ts)：长文分层加工。
- [synthesis.ts](synthesis.ts)：集合知识综合。

## 放置边界

模型协议由 agents 实现，固定文档由 document 提供；读取缺口不隐式触发发现或下载。

相关说明：[所属技术文档](../../../../docs/architecture/technical/05-knowledge-processing.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)
