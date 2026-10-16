# 调用方提取候选交付

接收调用方定义的提取规范，准备已有材料与证据，并验证和交付候选批次。

## 内容入口

- [spec.ts](spec.ts)：提取规范处理。
- [prepare.ts](prepare.ts)：固定输入准备。
- [delivery.ts](delivery.ts)：候选交付与回执。
- [schema-worker.ts](schema-worker.ts)：隔离的 schema 校验执行。

## 放置边界

领域字段含义、提取算法与最终数据集归调用方；不要在 Literature 固定字段里加入领域 payload。

相关说明：[所属技术文档](../../../../docs/architecture/technical/05-knowledge-processing.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)
