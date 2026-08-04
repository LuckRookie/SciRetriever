# 代码与文档同步映射

本文件规定代码变化时必须核对的活动文档。README 和当前用户指南解释已经实现的公开行为；architecture 描述理想产品；notes 保存外部供应商和工具的易变事实。归档材料不参与当前代码文档同步。

| 代码或配置 | 首要责任文档 | 必须同步检查的内容 |
|---|---|---|
| `src/sciretriever/model/` | [设计文档](../architecture/design.md)、[技术文档](../architecture/technical.md)、[架构原则](../architecture/principles.md) | Pydantic 数据合同、结构解析、不可变性、vendor 类型隔离，以及 validator 不承载业务决定或 I/O |
| `src/sciretriever/core/` | [架构决策](../architecture/decisions/README.md)、[架构原则](../architecture/principles.md)、[设计文档](../architecture/design.md) | 通用文献领域边界、Work/WorkVersion 身份、验收、状态、evidence 和导出资格规则 |
| `src/sciretriever/services/collection/`、`src/sciretriever/services/literature/` | [需求](../architecture/requirements.md)、[ADR 0002](../architecture/decisions/0002-literature-identity-and-incremental-processing.md)、[设计文档](../architecture/design.md)、[技术文档](../architecture/technical.md) | 主题与引用收集、来源 observation、保守身份收敛、统一 metadata、引用关系和公开 Service API |
| `src/sciretriever/services/assets/`、`src/sciretriever/services/documents/`、`src/sciretriever/services/analysis/` | [ADR 0003](../architecture/decisions/0003-operator-managed-mineru-service.md)、[设计文档](../architecture/design.md)、[技术文档](../architecture/technical.md)、[MinerU 注意事项](../notes/mineru.md) | 主资产验收、不可变发布、轻结构化文档、MinerU 边界、single current analysis 和输入 lineage |
| `src/sciretriever/services/library/` | [需求](../architecture/requirements.md)、[设计文档](../architecture/design.md)、[技术文档](../architecture/technical.md)、[README](../../README.md) | 查询、有限整理、BibTeX/BibLaTeX、RIS、CSL JSON 导入导出和公开 Service API |
| `src/sciretriever/services/execution/` | [需求](../architecture/requirements.md)、[设计文档](../architecture/design.md)、[技术文档](../architecture/technical.md)、[README](../../README.md)、[AGENTS.md](../../AGENTS.md) | 实际目标筛选、缺失步骤、局部失败、中断、重跑、稳定 reason/action、逐目标结果和批量摘要 |
| `src/sciretriever/infrastructure/storage/sqlite/`、`src/sciretriever/infrastructure/storage/files/` | [架构原则](../architecture/principles.md)、[设计文档](../architecture/design.md)、[技术文档](../architecture/technical.md) | SQLite 事实所有权、schema manifest/fingerprint、短事务、只读验证、不可变内容寻址存储、相对路径、权限、发布和对账 |
| `src/sciretriever/infrastructure/locking/` | [设计文档](../architecture/design.md)、[技术文档](../architecture/technical.md) | canonical path 绑定、本机非阻塞 advisory lock、锁顺序、进程退出或崩溃释放，以及与事务和文件对账的协调 |
| `src/sciretriever/infrastructure/access/` | [技术文档](../architecture/technical.md)、[Provider 接入开发手册](provider-integration.md)、[Provider 注意事项](../notes/providers.md) | 有界 transport、host concurrency、候选竞速、取消和脱敏；不存在的 browser 或 provider policy 实现不得写成当前能力 |
| `src/sciretriever/infrastructure/sources/metadata/`、`src/sciretriever/infrastructure/sources/citations/`、`src/sciretriever/infrastructure/sources/assets/`、`src/sciretriever/infrastructure/sources/registry.py` | [设计文档](../architecture/design.md)、[技术文档](../architecture/technical.md)、[Provider 接入开发手册](provider-integration.md)、[Provider 注意事项](../notes/providers.md) | Metadata、citation、asset source 的中性转换、adapter identity、调用方注入 client，以及 Protocol、选择键或 fake 不得写成生产接入 |
| `src/sciretriever/infrastructure/parsers/mineru/`、`src/sciretriever/infrastructure/llm/` | [ADR 0003](../architecture/decisions/0003-operator-managed-mineru-service.md)、[设计文档](../architecture/design.md)、[技术文档](../architecture/technical.md)、[MinerU 注意事项](../notes/mineru.md) | Parser/LLM 协议映射、不可信输出、资源边界、provenance、secret 注入、operator-managed 服务责任，以及 Composition 是否实际连接对应 Service |
| `src/sciretriever/infrastructure/io/` | [需求](../architecture/requirements.md)、[设计文档](../architecture/design.md)、[技术文档](../architecture/technical.md) | 书目格式读写、逐记录隔离、原子输出、字段损失说明和外部工具私有数据隔离 |
| `src/sciretriever/model/configuration.py`、`src/sciretriever/composition/configuration/` | [README](../../README.md)、[配置手册](../guides/configuration.md)、[技术文档](../architecture/technical.md)、[AGENTS.md](../../AGENTS.md) | 十个责任组、schema version、strict unknown rejection、字段类型与默认值、路径规则、secret reference 和 secret 值边界 |
| `src/sciretriever/composition/wiring/graph.py`、`src/sciretriever/composition/wiring/provider_registry.py` | [README](../../README.md)、[配置手册](../guides/configuration.md)、[设计文档](../architecture/design.md)、[技术文档](../architecture/technical.md) | 实际 Service 对象图、调用方注入的 provider clients、registry 选择键、LLM secret 注入、operator-managed 外部服务，以及未连接能力不得写成已发布集成 |
| `src/sciretriever/interface/__init__.py` | [README](../../README.md)、[当前用户指南](../guides/README.md)、[配置手册](../guides/configuration.md) | 当前不提供受支持 CLI 或其它用户交互入口；新增 Interface 后才记录其输入、结果、公开参数和错误 |
| `scripts/harness.py`、`.github/workflows/ci.yml` | [AGENTS.md](../../AGENTS.md)、[HARNESS.md](../../HARNESS.md) | 检查命令、规则强度、CI 和完成标准 |
| 项目立场与工具中立性 | [工具中立性声明](../notes/tool-neutrality.md) | 不对来源做道德分类，工程安全边界仍必须满足 |

## 同步规则

1. 公开 Interface、Service API、配置、schema、序列化格式或默认值变化时，代码和测试同步，README 与当前用户指南更新已实现行为。只有理想产品合同本身变化时才修改 architecture。
2. `WorkVersion` 与 processing/package version 必须始终使用不同术语和所有权。
3. Target analysis 只保留 single current result；`DocumentPackage` 占位不得解释为 analysis history 或当前导出能力。
4. 理想能力只在 architecture 定义；未实现能力不得进入当前命令示例或 accepted config。
5. 不兼容的 `DocumentPackage` 或项目边界变化必须新增 ADR。当前 pre-v1 不保留旧文档和内部模型的兼容解释；未来存在受支持数据或公开契约后，再由 owner 明确迁移、弃用和兼容门禁。
6. 活动提案放在 `docs/proposals/`，确认方向、完成、拒绝或被替代后进入 archive；执行计划只放在 `.omo/plans/`，评估和进度记录收口后进入 archive。这些材料不参与当前代码文档同步。
7. provider 或访问方法变化不得绕过 secure transport、有限 timeout、validation、immutable storage 和 redaction。
