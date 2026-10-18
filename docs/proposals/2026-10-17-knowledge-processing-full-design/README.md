+++
document_type = "proposal"
status = "reference"
created = "2026-10-18"
+++

# 文献知识加工平台：完整版设计（参考）

> 状态：参考设计，不作为首版实施范围。Owner 于 2026-10-18 决定首版采用精简方案，见[精简实施计划](../../archive/2026-10-18-knowledge-processing-platform/README.md)。本目录完整保存讨论中形成的最复杂版本，供后续某项能力成为真实瓶颈时按需取用。

## 内容

| 文件 | 内容 |
| --- | --- |
| [proposal.md](proposal.md) | 2026-10-17 平台提案原文副本：两区、文档版本与 Unit、内容资产、两类更新语义、复用与依赖、证据与修订、验收场景、技术候选 |
| [operator-design.md](operator-design.md) | 算子抽象的具体设计：方法、上下文、结果状态、五种形状、步骤与配方、现有代码映射、完成形态与代价 |
| [plan/](plan/README.md) | 按完整版编写的九块实施计划副本（原状态 Draft，未执行） |

## 与精简方案的关系

精简方案是完整版的子集。两者的对应关系如下，后续按需演进时不必推翻首版：

| 精简版 | 完整版 |
| --- | --- |
| `Processor` 接口 | `Method`（program、llm、agent、external） |
| `scope: document` | map、filter、expand 三种形状 |
| `scope: collection` | group、whole |
| `runBatch` 的跳过键 | 加入实际依赖集合的复用键 |
| `Result` | Item、Asset 与版本 |
| 手工指定上一步结果作为输入 | 配方 |

## 何时引入完整版中的能力

| 触发条件 | 引入的能力 |
| --- | --- |
| 文档修复频繁，整篇重跑成本明显 | Unit 级依赖与按 Unit 重算 |
| 同一多步流程被反复手工串联 | 配方与模板 |
| 分组综合需要增量更新 | 按组处理形状 |
| 出现第三个只是提示词不同的方法 | `llm` 方法的数据化定义 |
| 人工修订后下游结果需要自动跟进 | 修订、影响分析与“待更新”标记 |
| 允许运行用户或 Agent 编写的处理代码 | `ctx` 可见范围限制与隔离 |
| 规范频繁增加字段 | 新旧记录匹配与差异展示 |

[提案导航](../README.md) · [文档导航](../../README.md)
