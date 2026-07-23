# ADR 索引

ADR 保存已经接受的架构决策和 supersession 关系，不替代当前实现文档，也不把多次决策合并成一份会丢失时间线的产品规格。

## 权威范围

| ADR | 负责主题 | 当前效力 |
|---|---|---|
| [ADR 0001：范围与边界](0001-sciretriever-scope-and-boundary.md) | 领域边界、`DocumentPackage` 下游契约、不可变证据、通用轻结构、稳定引用和领域输出下游化 | 只在这些主题上继续 accepted |
| [ADR 0002：以 Work 为中心的本地文献库](0002-work-centered-literature-library.md) | 产品中心、Work/WorkVersion、PDF-required analysis、前台执行模型和旧下载任务兼容策略 | 在这些主题上控制当前批准方向，并局部取代 ADR 0001 |

ADR 0002 不撤销 ADR 0001 的领域边界。一个变化同时涉及两类主题时，领域边界适用 ADR 0001，产品形状和执行语义适用 ADR 0002；具体 target 行为由 requirements 定义。

## 阅读顺序

1. 先读项目 [README](../../README.md)，了解当前已实现命令和行为。
2. 修改领域边界、`DocumentPackage`、不可变证据或下游集成时读 [ADR 0001](0001-sciretriever-scope-and-boundary.md)。
3. 修改产品中心、Work/WorkVersion、PDF 分析、CLI 方向、执行模型或旧任务删除时读 [ADR 0002](0002-work-centered-literature-library.md)。
4. 读[需求规格](../specs/requirements.md)，获得批准目标的规范性行为。
5. 读[系统设计](../specs/system-design.md)，了解理想产品的数据流、状态和模块责任。
6. 读[架构原则](../architecture/principles.md)和[技术架构](../specs/technical-architecture.md)，了解理想所有权、模块和依赖边界。
7. 读[执行计划](../planning/literature-library-execution.md)，了解获批实施顺序；读[实施进度](../governance/implementation-progress.md)，了解当前覆盖、差距和验证证据。

proposal 是方向输入，planning 是实施授权，progress 是事实台账，三者都不是当前用户行为来源。[产品决策追踪](../governance/product-decision-trace.md)只证明 owner 讨论覆盖，不独立定义行为。
