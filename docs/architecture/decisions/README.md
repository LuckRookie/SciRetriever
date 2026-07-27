# 架构决策索引

ADR 保存已经接受的架构决策和 supersession 关系，不替代当前实现文档，也不把多次决策合并成一份会丢失时间线的产品规格。

## 权威范围

| ADR | 负责主题 | 当前效力 |
|---|---|---|
| [ADR 0001：范围与边界](0001-sciretriever-scope-and-boundary.md) | 领域边界、`DocumentPackage` 下游契约、不可变证据、通用轻结构、稳定引用和领域输出下游化 | 只在这些主题上继续 accepted |
| [ADR 0002：以 Work 为中心的本地文献库](0002-work-centered-literature-library.md) | 产品中心、Work/WorkVersion、PDF-required analysis、前台执行模型和旧下载任务兼容策略 | 在这些主题上控制当前批准方向，并局部取代 ADR 0001 |
| [ADR 0003：Operator-managed MinerU PDF parsing service](0003-operator-managed-mineru-service.md) | PDF parser 选择、外部 MinerU service 所有权、连接/恢复/证据边界 | 在这些主题上细化 ADR 0002 的前台执行模型，不引入 SciRetriever-owned daemon |

ADR 0002 不撤销 ADR 0001 的领域边界。一个变化同时涉及两类主题时，领域边界适用 ADR 0001，产品形状和执行语义适用 ADR 0002；外部 PDF 解析服务适用 ADR 0003；具体 target 行为由 requirements 定义。

## 阅读顺序

1. 先读项目 [README](../../../README.md)，了解当前已实现命令和行为。
2. 修改领域边界、`DocumentPackage`、不可变证据或下游集成时读 [ADR 0001](0001-sciretriever-scope-and-boundary.md)。
3. 修改产品中心、Work/WorkVersion、PDF 分析、CLI 方向、执行模型或旧任务删除时读 [ADR 0002](0002-work-centered-literature-library.md)。
4. 修改 PDF parser、MinerU service connection、外部 task attempt 或 parser provenance 时读 [ADR 0003](0003-operator-managed-mineru-service.md)。
5. 读[需求规格](../requirements.md)，获得目标产品的规范性行为。
6. 读[系统设计](../system-design.md)，了解理想产品的数据流、状态和模块责任。
7. 读[架构原则](../principles.md)和[技术架构](../technical-architecture.md)，了解理想所有权、模块和依赖边界。

完成提案、进度和工作包材料已进入[历史归档](../../archive/2026-07-literature-library/README.md)，不参与当前架构解释；OMO 执行计划不作为项目文档保存。
