# 代码与文档同步映射

本文件规定代码变化时必须核对的活动文档。README 和用户手册解释当前已发布行为；architecture 描述理想产品；notes 保存外部供应商和工具的易变事实。归档材料不参与当前代码文档同步。

| 代码或配置 | 首要责任文档 | 必须同步检查的内容 |
|---|---|---|
| `src/sciretriever/core/` | [架构决策](../architecture/decisions/README.md)、[架构原则](../architecture/principles.md) | `DocumentPackage` 领域边界、Work/WorkVersion/PDF-analysis 产品语义和稳定下游契约 |
| `src/sciretriever/catalog/` | [系统设计](../architecture/system-design.md)、[技术架构](../architecture/technical-architecture.md) | 理想 schema/ownership、Work/版本、observations、authors、registries、tags、references 和 single current analysis |
| `src/sciretriever/discovery/`、`src/sciretriever/integrations/` | [需求](../architecture/requirements.md)、[系统设计](../architecture/system-design.md)、[README](../../README.md)、[Provider 注意事项](../notes/providers.md) | provider 查询、默认 limit、去重、precedence/fill-missing、已发布入口和外部契约 |
| `src/sciretriever/integrations/graph.py`、引用解析与 expansion | [需求](../architecture/requirements.md)、[系统设计](../architecture/system-design.md)、[技术架构](../architecture/technical-architecture.md)、[README](../../README.md) | direction/depth、graph capability、visited 去环、逐层 completion、branch isolation 和资源预算 |
| `src/sciretriever/acquisition/`、`src/sciretriever/network/` | [系统设计](../architecture/system-design.md)、[技术架构](../architecture/technical-architecture.md)、[README](../../README.md)、[Provider 注意事项](../notes/providers.md) | WorkVersion resolver、provider race、tier fallback、timeout、identity/content validation、immutable acceptance 和供应商限制 |
| `src/sciretriever/completion/`、`src/sciretriever/cli/completion_runtime.py` | [系统设计](../architecture/system-design.md)、[技术架构](../architecture/technical-architecture.md)、[README](../../README.md)、[AGENTS.md](../../AGENTS.md) | 四阶段事实派生、显式 stop、missing-suffix、batch/interruption、force analysis 和无第二套状态 |
| Provider API、凭据/会话、限流、准入和排障 | [Provider 接入开发手册](provider-integration.md)、[Provider 注意事项](../notes/providers.md) | 公开契约、证据等级、host/DNS/redirect/预算、敏感数据边界、disable/retire 和最后核对日期 |
| `src/sciretriever/storage/` | [架构原则](../architecture/principles.md)、[系统设计](../architecture/system-design.md) | 不可变存储、hash、路径、权限、发布和对账 |
| `src/sciretriever/normalization/`、`src/sciretriever/analysis/`、`src/sciretriever/packaging/` | [ADR 0003](../architecture/decisions/0003-operator-managed-mineru-service.md)、[需求](../architecture/requirements.md)、[系统设计](../architecture/system-design.md)、[MinerU 注意事项](../notes/mineru.md) | MinerU connection、PDF evidence、single current replacement 和 immutable package boundary |
| `src/sciretriever/diagnostics/`、`src/sciretriever/cli/failures.py`、统一计数 | [需求](../architecture/requirements.md)、[系统设计](../architecture/system-design.md)、[README](../../README.md) | 四阶段 failure 查询、latest/all、reason/action/rerun、脱敏 details 和终态计数 |
| `src/sciretriever/cli/`、配置模块、`config.example.toml` | [README](../../README.md)、[用户手册](../guides/user-manual.md)、[需求](../architecture/requirements.md)、[AGENTS.md](../../AGENTS.md) | 已发布命令、参数、accepted keys/defaults/precedence、offline/runtime 分界和 composition ownership |
| legacy 或已废弃代码 | [ADR 0001](../architecture/decisions/0001-sciretriever-scope-and-boundary.md)、[ADR 0002](../architecture/decisions/0002-work-centered-literature-library.md) | pre-v1 不保留 legacy catalog adapter、旧 schema 或退休路径 guard；未来兼容需求必须重新授权 |
| `scripts/harness.py`、`.github/workflows/ci.yml` | [AGENTS.md](../../AGENTS.md)、[HARNESS.md](../../HARNESS.md) | 检查命令、规则强度、CI 和完成标准 |
| 历史下载路线 | [归档 README](../archive/2026-07-download-roadmap/README.md) | 仅用于审计，不作为当前需求、方向或实施授权 |
| 项目立场与工具中立性 | [工具中立性声明](../notes/tool-neutrality.md) | 不对来源做道德分类，工程安全边界仍必须满足 |

## 同步规则

1. 公开 CLI、配置、schema、序列化格式或默认值变化时，代码和测试同步，README 与用户手册更新已发布行为。只有理想产品合同本身变化时才修改 architecture。
2. `WorkVersion` 与 processing/package version 必须始终使用不同术语和所有权。
3. target analysis 只保留 single current result；`package_versions` 不得解释为 analysis history。
4. 理想能力只在 architecture 定义；未实现能力不得进入当前命令示例或 accepted config。
5. 不兼容的 `DocumentPackage` 或项目边界变化必须新增 ADR。ADR 0002 已批准 pre-v1 直接替换 schema 并删除不需要的 legacy catalog 代码；未来存在受支持数据后再由 owner 明确迁移和兼容门禁。
6. 活动提案放在 `docs/proposals/`，确认方向、完成、拒绝或被替代后进入 archive；执行计划只放在 `.omo/plans/`，评估和进度记录收口后进入 archive。这些材料不参与当前代码文档同步。
7. provider 或访问方法变化不得绕过 secure transport、有限 timeout、validation、immutable storage 和 redaction。
