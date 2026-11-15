# 调用方提取候选交付

接收调用方定义的提取规范，准备已有材料与证据，并验证和交付候选批次。

## 内容入口

- [spec.ts](spec.ts)：提取规范处理。
- [prepare.ts](prepare.ts)：平台内部的固定输入准备；READY 文献沿用现有材料准入，可读初稿在建档就绪前也可作为明确输入。文档清单返回固定版本的 `text_level`，片段与证据由 document 模块返回等级和初稿核对依据。
- [delivery.ts](delivery.ts)：独立外部候选交付与回执；校验调用方 manifest 的固定材料、文档、等级与能力，不以内部建档就绪作为外部交付前置条件。未带等级的旧清单仍按原合同校验，不改变其 hash。
- [schema-worker.ts](schema-worker.ts)：隔离的 schema 校验执行。

## 放置边界

领域字段含义、提取算法与最终数据集归调用方；不要在 Literature 固定字段里加入领域 payload。

[上级目录](../README.md)
