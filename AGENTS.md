# SciRetriever 仓库协作规范

> 本文件是项目画像和入口索引。跨项目稳定规则见 [`HARNESS.md`](HARNESS.md)。修改代码前先读本文件，再按任务涉及范围读取对应真相源。

## 1. 主规范

1. 阅读 [`HARNESS.md`](HARNESS.md) 的工作流、质量、Git 和完成标准。
2. 先按 [ADR 索引](docs/adr/README.md)判断权威范围：项目领域边界或 `DocumentPackage` 适用 ADR 0001；产品中心、WorkVersion、PDF analysis、CLI 方向或旧任务行为删除适用 ADR 0002。
3. 涉及模块边界、数据所有权或持久化时读[架构原则](docs/architecture/principles.md)和[系统设计](docs/specs/system-design.md)。
4. 按[代码与文档责任映射](docs/governance/code-doc-map.md)判断文档同步范围。
5. 默认沟通和项目文档使用中文；代码标识符、异常和提交信息使用英文。

## 2. 项目画像

| 字段 | 值 |
|---|---|
| 项目定位 | 当前为文献发现、采集、不可变保存和处理快照工具；批准目标为以 Work 为中心的本地文献库 |
| 权威边界 | 带版本和 provenance 的 `DocumentPackageVersion` |
| 主要语言/运行时 | Python 3.10+；开发基线 Python 3.12 |
| 包管理器 | uv；锁文件 `uv.lock` |
| 默认分支 | `master` |
| v2 源码 | `src/sciretriever/` |
| 测试 | `tests/`，标准库 `unittest` |
| Harness | `scripts/harness.py` |
| CI | `.github/workflows/ci.yml`，Python 3.10/3.12 |
| 临时文件 | 系统临时目录下的 `sciretriever-*`；不得放仓库根目录 |
| 构建产物 | `build/`、`dist/`，均不提交 |

## 3. 环境与命令

所有命令从仓库根目录执行。

| 层级 | 用途 | 命令 | 强度 |
|---|---|---|---|
| - | 安装锁定开发依赖 | `uv sync --locked --dev` | LOCAL GATE / CI GATE |
| L0-L1 | `quick_check` | `uv run --frozen python scripts/harness.py quick` | LOCAL GATE |
| L1-L3 | `full_check` | `uv run --frozen python scripts/harness.py full` | LOCAL GATE / CI GATE |
| L1 | 编译 | `python -m compileall -q src tests scripts main.py` | full_check |
| L1 | 格式化 | 无自动 formatter；保持现有风格 | POLICY |
| L1 | Lint | 无独立 linter | N/A |
| L1 | 类型检查 | `uv run --frozen pyright src/sciretriever tests scripts` | full_check |
| L3 | 全部测试 | `uv run --frozen python -m unittest discover -s tests` | full_check |
| L0 | 单文件测试 | `uv run --frozen python -m unittest discover -s tests -p 'test_<name>.py'` | LOCAL GATE |
| L3 | 覆盖率 | 无阈值和门禁 | N/A |
| L2 | wheel 构建 | `uv run --frozen python -m build --wheel --no-isolation` | full_check |
| L1-L2 | 文档检查 | `uv run --frozen python scripts/harness.py docs` | LOCAL GATE / CI GATE |
| L1-L2 | 架构检查 | `uv run --frozen python scripts/harness.py architecture` | LOCAL GATE / CI GATE |
| L4 | 语义审查 | 对照原始需求、ADR、责任映射和最终 diff | POLICY |
| L5 | 人工审批 | 新 ADR、受支持数据迁移、边界变化、生产数据操作 | HUMAN GATE |

### 环境约束

- 优先使用仓库现有 `.venv`；不要复制归档环境或新建平行环境。
- 未经用户授权，不升级运行时依赖或修改 lockfile。
- 首次冒烟：`uv run --frozen sciretriever --version`。
- 测试、构建和 harness 不得连接真实供应商、生产数据库或用户语料。

## 4. 项目结构

| 路径 | 职责 | 稳定性/风险 |
|---|---|---|
| `src/sciretriever/core/` | 中性契约、枚举、ID、hash、文献包 | stable / 公开契约高风险 |
| `src/sciretriever/catalog/` | SQLite schema、身份、状态、关系 | stable / 持久化高风险 |
| `src/sciretriever/discovery/` | 元数据清洗、去重、合并、标注和清单 | stable |
| `src/sciretriever/integrations/` | 供应商共享 client 和中性 DTO | evolving / 外部 API 风险 |
| `src/sciretriever/network/` | HTTPS、DNS、重定向和响应边界 | stable / 安全高风险 |
| `src/sciretriever/acquisition/` | provider、路由、重试、熔断和验收 | evolving / 生命周期高风险 |
| `src/sciretriever/storage/` | Raw/Derived 不可变发布和恢复 | stable / durability 高风险 |
| `src/sciretriever/normalization/` | PDF/XML/HTML 统一归一化 | stable |
| `src/sciretriever/enrichment/` | 通用摘要、标签和引用 | stable |
| `src/sciretriever/packaging/` | 质量门与版本化发布 | stable |
| `src/sciretriever/cli/` | composition root 和配置装配 | evolving |

## 5. 架构边界

```text
CLI / adapters
      │
      ├── Discovery ──▶ shared integrations/network
      ├── Acquisition ─▶ shared integrations/network
      ├── Catalog / Storage
      └── Normalization ─▶ Enrichment ─▶ Packaging
                         │
                         ▼
              core contracts / DocumentPackage
```

- `discovery` 和 `acquisition` 互不导入，只通过 `DownloadManifest` 文件契约交接。
- `catalog` 不依赖 discovery、acquisition、storage、normalization、enrichment 或 packaging 类型。
- `core` 不依赖任一工作流或基础设施模块。
- 供应商响应在 `integrations` 转换为中性 DTO；vendor dict 不进入 core/catalog。
- Composition root：`src/sciretriever/cli/main.py`。
- 自动门禁：`python scripts/harness.py architecture`。

## 6. 不可协商的数据边界

- SciRetriever 止于 `DocumentPackageVersion`；不得加入反应、分子、路线、产率等领域 schema。
- 当前 `package_versions` 是处理快照，不是批准目标中的书目 `WorkVersion`。
- catalog 不存大型 BLOB，不存绝对资产路径；文件系统存字节，catalog 存相对路径、hash、关系和 provenance。
- RawAsset 永不原地修改；发布只允许 create-if-absent，不覆盖冲突证据。
- 清洗、去重和 catalog 比对必须先于可能消耗 token 的标注。
- Acquisition、Normalization 和 Packaging 不得丢失来源、输入、hash 或 lineage。
- 下游通过稳定 ID、hash 和包契约集成，不直接依赖内部 ORM 表。
- 不添加微服务、外部工作流平台、向量库或 Web UI，除非新 ADR 明确授权。

## 7. 真相源

| 主题 | 真相源 |
|---|---|
| ADR 权威范围与阅读顺序 | `docs/adr/README.md` |
| 领域边界与 `DocumentPackage` | `docs/adr/0001-sciretriever-scope-and-boundary.md` |
| 产品中心、WorkVersion、PDF analysis 与 pre-v1 删除策略 | `docs/adr/0002-work-centered-literature-library.md` |
| 数据所有权与 `DocumentPackage` | `docs/architecture/principles.md` |
| 理想产品数据流与模块责任 | `docs/specs/system-design.md` |
| 理想代码模块与依赖边界 | `docs/specs/technical-architecture.md` |
| 当前实施覆盖、差距与验证证据 | `docs/governance/implementation-progress.md` |
| 用户安装、命令和配置 | `README.md`、`config.example.toml` |
| 代码到文档同步 | `docs/governance/code-doc-map.md` |
| 跨项目协作规则 | `HARNESS.md` |

requirements、system design 和 technical architecture 只描述理想产品，不承担现状或执行进度追踪。代码表达实际行为，README 是当前用户解释层；实施覆盖、差距和工作包状态统一记录在 `docs/governance/implementation-progress.md`。不得把理想能力写成当前实现。

未批准的方向、评估和草案只放在 `docs/proposals/`；`docs/planning/` 只放带 owner、批准记录和责任 spec 的执行计划，计划只负责顺序、依赖、验收和回退。目录和授权契约由 documentation harness 阻断检查；proposal、plan 和 progress 都不是当前用户行为真相源。

## 8. 金牌实现与测试

- `src/sciretriever/core/contracts.py`：冻结、可序列化的中性边界对象。
- `src/sciretriever/integrations/`：一个供应商一个共享 client，能力 adapter 只做边界转换。
- `src/sciretriever/network/secure.py`：有界读取、DNS pinning、重定向复检和敏感 header 处理。
- `src/sciretriever/storage/coordinator.py`：durability 优先的不可变发布。
- `tests/test_discovery_acceptance.py`：离线端到端 Discovery 验收。
- `tests/test_acquisition_p5.py`：多来源生命周期与出版商能力测试。
- `tests/test_raw_asset_crash_recovery.py`：崩溃恢复与证据保留模式。

## 9. 雷区和遗留代码

- 当前 pre-v1 无受支持旧 catalog；不保留 legacy import、旧 schema、迁移 adapter 或退休数据库 guard。
- `catalog/models.py`、schema bootstrap、`core/package.py`：修改前必须读 ADR、系统设计和直接测试。
- `network/secure.py`、URL policy、credential plumbing：修改必须做安全专项检查。
- `dist/`、`build/`、`.venv/`、运行时 catalog、下载资产和语料不得提交。

## 10. 文档、Git 与审查覆盖

- 代码变化按 `docs/governance/code-doc-map.md` 同步责任文档。
- 提交格式采用英文 Conventional Commits；当前仅 `POLICY`，无 commit-msg hook。
- 实现、直接测试和必要契约文档应在同一原子提交；纯用户指南可独立提交。
- 只有用户明确要求时执行 commit、push、rebase、PR 或发布。
- 完成后的集中审查最多使用 2 个 reviewer；按实际风险选择目标/质量和安全/QA 角色。
- 公开契约、不可变存储、网络安全、边界变化和未来受支持数据迁移需要人工判断。本次 WP1 pre-v1 schema 直接替换已获 owner 批准。

## 11. 完成检查

- [ ] 需求、代码、测试和责任文档一致。
- [ ] 修改文件无新增诊断。
- [ ] 相关测试通过。
- [ ] `quick_check` 通过；交付前 `full_check` 通过。
- [ ] 架构和文档门禁通过。
- [ ] diff 无凭据、数据、生成物或无关改动。
- [ ] Git 操作没有超出用户授权。
