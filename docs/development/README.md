# 开发手册

类型：导航
负责：开发手册
状态：现行

开发工作从项目根目录 [`AGENTS.md`](../../AGENTS.md) 和 [`HARNESS.md`](../../HARNESS.md) 开始。前者说明项目边界、模块画像和验证命令，后者说明通用协作、测试、文档和 Git 规则。

## 常用入口

- [仓库目录地图](repository-map.md)：按目录或工作类型定位责任模块。

- [代码与文档同步映射](documentation-map.md)：代码变化需要同步核对哪些当前文档。
- [测试材料与阶段记录](../../tests/README.md)：测试源码、合成 fixture、人工验收说明和临时结果的存放边界。
- [TypeScript 基础开发入口](typescript-foundation.md)：TS workspace、合同包、离线验证和当前运行时阻断。
- [Provider 接入开发手册](provider-integration.md)：新增或实质修改 Metadata Provider 或 Acquisition Provider client/adapter 时的安全与验收检查。
- [Publisher Access Profile 准入与验证矩阵](../notes/providers/publisher-access-matrix.md)：Publisher/Access Provider 的统一证据包、三态状态、Browser rule 对齐和当前生产矩阵。
- [总设计师](chief-designer.md)：这个角色怎样指定、负责哪些文档、怎样工作；只对 Owner 指定的会话生效。
- [整体架构](../architecture/README.md)：修改领域边界、数据所有权、持久化或依赖方向前的设计真相源。

[迁移映射](../archive/2026-10-24-docs-consolidation/docs/architecture/evolution-map.md)保留实施前的改造依据；[已完成计划](../archive/2026-09-28-typescript-knowledge-architecture-migration/README.md)保留验收证据。当前版本兼容见[安装指南](../guides/installation.md)，后续工作以[活动计划索引](../plans/README.md)为准。旧Python技术主体已归档，不再作为活动API。

## 验证

```bash
pnpm quick
pnpm full
```

按项目 owner 于 2026-09-10 的决定，后续全量验收采用 TS Full：Prettier、ESLint、源码与测试 strict 类型检查、Vitest 和构建。Python Harness 保留为历史维护入口，只有明确要求时才运行。精确规则见根目录 `HARNESS.md`。

自动化回归、构建和 Harness 不得连接真实供应商、生产数据库或用户语料。经用户明确授权的本机真实测试使用 Git 忽略的 `sandbox/`，目录职责见[测试目录说明](../../tests/README.md)。

[上级目录](../README.md) · [项目 README](../../README.md)
