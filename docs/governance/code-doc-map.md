# 代码与文档责任映射

本文件规定代码变化时必须核对的责任文档。README 解释当前已发布行为；requirements、system design 和 technical architecture 描述理想产品；[实施进度](implementation-progress.md)记录代码覆盖和差距；proposal、execution plan 和 progress 都不冒充当前用户命令来源。

| 代码或配置 | 首要责任文档 | 必须同步检查的内容 |
|---|---|---|
| `src/sciretriever/core/` | [ADR 索引](../adr/README.md)、[架构原则](../architecture/principles.md)、[ADR 0001](../adr/0001-sciretriever-scope-and-boundary.md)、[ADR 0002](../adr/0002-work-centered-literature-library.md) | ADR 0001 的 `DocumentPackage`/领域边界与 ADR 0002 的 Work/WorkVersion/PDF-analysis 产品语义，不混用权威范围 |
| `src/sciretriever/catalog/` | [系统设计](../specs/system-design.md)、[技术架构](../specs/technical-architecture.md)、[实施进度](implementation-progress.md) | 理想 schema/ownership、Work/版本、observations、authors、registries、tags、references、single current analysis，以及当前覆盖证据 |
| `src/sciretriever/discovery/`、`src/sciretriever/integrations/` | [需求](../specs/requirements.md)、[系统设计](../specs/system-design.md)、[README](../../README.md)、[实施进度](implementation-progress.md) | provider 查询、默认 limit、去重、precedence/fill-missing 的理想规则、已发布入口和当前覆盖 |
| `src/sciretriever/acquisition/`、`src/sciretriever/network/` | [系统设计](../specs/system-design.md)、[技术架构](../specs/technical-architecture.md)、[README](../../README.md)、[实施进度](implementation-progress.md) | WorkVersion selector/resolver、provider race、provider 内候选顺序、tier fallback、timeout、identity/content validation、immutable acceptance、已发布入口和当前缺口 |
| provider API、凭据/会话生命周期、限流、准入和现场排障 | [Provider 运维手册](../guides/provider-operations.md)、[WP3 acquisition 准入记录](../guides/wp3-acquisition-admission.md) | 公开契约、实测事实、证据等级、host/DNS/redirect/预算、runtime-only 敏感数据、disable/retire 证据和最后核对日期，不记录凭据值、endpoint、profile path 或正文 |
| `src/sciretriever/storage/` | [架构原则](../architecture/principles.md)、[系统设计](../specs/system-design.md) | 不可变存储、hash、路径、权限、发布和对账 |
| `src/sciretriever/normalization/`、`src/sciretriever/analysis/`、`src/sciretriever/packaging/` | [ADR 0003](../adr/0003-operator-managed-mineru-service.md)、[需求](../specs/requirements.md)、[系统设计](../specs/system-design.md)、[架构原则](../architecture/principles.md)、[MinerU 运维指南](../guides/mineru-service-operations.md)、[实施进度](implementation-progress.md) | MinerU service ownership/connection、PDF evidence、single current replacement、foreground backfill 和 immutable package boundary |
| `src/sciretriever/cli/`、`src/sciretriever/config.py`、`config.example.toml` | [README](../../README.md)、[需求](../specs/requirements.md)、[实施进度](implementation-progress.md) | 已发布命令、参数、accepted keys/defaults，理想 CLI/config contract 和当前差距 |
| legacy 或已废弃代码 | [ADR 0001](../adr/0001-sciretriever-scope-and-boundary.md)、[ADR 0002](../adr/0002-work-centered-literature-library.md)、[实施进度](implementation-progress.md) | pre-v1 不保留 legacy catalog adapter、旧 schema 或退休路径 guard；不符合目标框架的代码直接删除，未来兼容需求必须由 owner 重新授权 |
| `scripts/harness.py`、`.github/workflows/ci.yml` | [AGENTS.md](../../AGENTS.md)、[HARNESS.md](../../HARNESS.md) | 检查命令、规则强度、CI 和完成标准 |
| 产品方向与删除兼容策略 | [ADR 0002](../adr/0002-work-centered-literature-library.md)、[产品提案](../proposals/literature-library-product.md) | Work-centered 产品、前台幂等重跑、旧任务行为无兼容义务 |
| owner 产品决策追踪 | [产品决策追踪](product-decision-trace.md) | 只做对话索引到权威文档的覆盖审计；不作为独立规范或当前行为来源 |
| 已批准实施顺序 | [文献库执行计划](../planning/literature-library-execution.md) | owner、批准证据、工作包、先删除/解耦再新增 schema、验收和回退，不记录动态状态 |
| 实施覆盖与工作包状态 | [实施进度](implementation-progress.md) | 核对日期、当前命令/模块证据、能力差距、WP 状态和最近验证，不定义产品或顺序 |
| 历史下载路线 | [归档 README](../archive/2026-07-download-roadmap/README.md) | 仅用于审计，不作为当前需求、方向或实施授权 |
| 项目立场与工具中立性 | [工具中立性声明](../tool-neutrality-statement.md) | 不对来源做道德分类，工程安全边界仍必须满足 |

## 同步规则

1. 公开 CLI、配置、schema、序列化格式或默认值变化时，代码和测试同步；README 更新已发布行为，实施进度更新覆盖证据。只有理想产品合同本身变化时才修改责任 spec。
2. `WorkVersion` 与 processing/package version 必须始终使用不同术语和所有权。
3. target analysis 只保留 single current result；`package_versions` 不得解释为 analysis history。
4. 理想能力只在三份规格定义；未实现状态只在实施进度记录，不得进入当前命令示例或 accepted config。
5. 不兼容的 `DocumentPackage` 或项目边界变化必须新增 ADR。ADR 0002 已批准 pre-v1 WP1 直接替换 schema 并删除不需要的 legacy catalog 代码；未来存在受支持数据后再由 owner 明确迁移和兼容门禁。
6. proposal 不是实施授权，execution plan 不是当前行为或进度真相源，progress 不是产品规范。完成、取消或被替代的计划移入 archive。
7. provider 或访问方法变化不得绕过 secure transport、有限 timeout、validation、immutable storage 和 redaction。
