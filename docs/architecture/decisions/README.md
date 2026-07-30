# 架构决策索引

ADR 记录已经接受并会长期约束后续设计的重要选择。ADR 不替代产品需求、系统设计或当前实现文档，也不保存实施进度。

## 权威顺序

1. [产品需求](../requirements.md)定义用户问题、核心流程、产品结果和验收标准。
2. 本目录的 ADR 在各自适用范围内约束后续设计，不得反向修改产品需求。
3. [系统设计](../system-design.md)在需求和已接受 ADR 的边界内推导逻辑对象、数据流、所有权和设计取舍。
4. [技术架构](../technical-architecture.md)把设计映射为代码模块、依赖和运行技术。
5. 项目 [README](../../../README.md)、源码和测试说明当前实现。

当这些文档发生冲突时，先按主题找到唯一责任文档，而不是让更具体的技术细节反向覆盖产品需求。

## 当前 ADR

| ADR | 状态 | 负责主题 | 不负责 |
|---|---|---|---|
| [ADR 0001：范围与数据边界](0001-sciretriever-scope-and-boundary.md) | Accepted | 通用文献边界、资产证据、轻结构化文本、通用结构化文献分析和领域数据下游化 | 身份模型、parser、schema、交互方式 |
| [ADR 0002：多来源文献身份与增量处理](0002-literature-identity-and-incremental-processing.md) | Accepted | Work/WorkVersion 内部身份、observations、阶段独立提交、单机增量补全 | 产品目标、匹配算法、物理 schema、PDF/LLM 语义 |
| [ADR 0003：Operator-managed MinerU PDF parser adapter](0003-operator-managed-mineru-service.md) | Accepted | 当前 MinerU adapter 的服务所有权、验证、provenance 和 parser-neutral 输出边界 | 核心产品需求、唯一 parser 选择、额外 LLM 分析 |
| [ADR 0004：产品需求与派生设计的责任边界](0004-requirement-led-literature-collection.md) | Accepted | 需求、设计、ADR、技术架构和当前实现的文档职责 | 具体系统设计方案 |

## 阅读方法

1. 所有产品或架构讨论先读[产品需求](../requirements.md)。
2. 检查是否存在约束当前问题的 Accepted ADR。
3. 讨论整体数据流和模块责任时读[系统设计](../system-design.md)。当前 ADR 的主题为：
   - 领域边界、资产证据或下游集成：ADR 0001；
   - 文献身份、版本和增量补全：ADR 0002；
   - MinerU parser service：ADR 0003；
   - 文档责任和需求/设计分离：ADR 0004。
4. 讨论代码组织和具体运行机制时再读[技术架构](../technical-architecture.md)。

尚未接受的设计放在讨论或活动提案中，不得提前写成 Accepted ADR。完成、拒绝或被替代的讨论材料进入 `docs/archive/`，不参与当前架构解释。
