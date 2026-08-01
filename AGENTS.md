# SciRetriever 仓库协作规范

> 本文件是项目画像和入口索引。跨项目稳定规则见 [`HARNESS.md`](HARNESS.md)。修改代码前先读本文件，再按任务涉及范围读取对应真相源。

## 1. 主规范

1. 阅读 [`HARNESS.md`](HARNESS.md) 的工作流、质量、Git 和完成标准。
2. 先读[产品需求](docs/architecture/requirements.md)，再按[架构决策索引](docs/architecture/decisions/README.md)判断已接受约束：领域与数据边界适用 ADR 0001；Work/WorkVersion 内部身份和单机增量处理适用 ADR 0002；MinerU parser adapter 边界适用 ADR 0003；需求与派生设计的责任边界适用 ADR 0004。
3. 涉及设计文档、模块边界、数据所有权或持久化时，依次读[架构原则](docs/architecture/principles.md)、[设计文档](docs/architecture/design.md)和[技术文档](docs/architecture/technical.md)；先检查它们能否追溯到需求，不得用当前代码反向证明目标设计正确。
4. 按[代码与文档同步映射](docs/development/documentation-map.md)判断文档同步范围。
5. 默认沟通和项目文档使用中文；代码标识符、异常和提交信息使用英文。
6. Harness 只执行项目 owner 明确要求建立的机械门禁。Agent 不得把对话总结、计划、审查意见、通用经验或自行推导的约束编码为 Harness；未获 owner 明示批准的协作约束应保留为自然语言 POLICY 或审查事项，不得新增 CLI 检查、AST 规则、固定阈值或阻断条件。

## 2. 项目画像

| 字段 | 值 |
|---|---|
| 项目定位 | 面向指定领域的大批量文献收集工具；通过多来源元数据搜索、资产获取和轻结构化文本解析形成文献数据库 |
| 权威边界 | 文献元数据、资产信息、轻结构化文本和通用结构化文献分析结果；领域数据留在下游 |
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
| L4 | 语义审查 | 对照原始需求、ADR、责任映射和最终 diff | POLICY |
| L5 | 人工审批 | 新 ADR、受支持数据迁移、边界变化、生产数据操作 | HUMAN GATE |

### 环境约束

- 优先使用仓库现有 `.venv`；不要复制归档环境或新建平行环境。
- 未经用户授权，不升级运行时依赖或修改 lockfile。
- 首次冒烟：`uv run --frozen sciretriever --version`。
- 测试、构建和 harness 不得连接真实供应商、生产数据库或用户语料。

## 4. 当前实现结构

下表用于定位现有代码，不定义下一版目标架构。模块是否保留、拆分或调整，必须从产品需求和已接受 ADR 重新推导。

| 路径 | 职责 | 稳定性/风险 |
|---|---|---|
| `src/sciretriever/core/` | 当前中性契约、枚举、ID、hash 和文献包 | 公开契约高风险 |
| `src/sciretriever/catalog/` | 当前 SQLite schema、身份、状态和关系 | 持久化高风险 |
| `src/sciretriever/discovery/` | 当前 metadata 候选检索、身份匹配和 sink 投影 | 多来源收敛高风险 |
| `src/sciretriever/integrations/` | 供应商共享 client 和中性 DTO | evolving / 外部 API 风险 |
| `src/sciretriever/network/` | 当前 HTTPS、DNS、重定向和响应边界 | 安全高风险 |
| `src/sciretriever/acquisition/` | 当前 WorkVersion resolver、候选执行、验证和验收 | 资产生命周期高风险 |
| `src/sciretriever/completion/` | 当前阶段派生、补全编排和批处理机制 | 待设计审查 |
| `src/sciretriever/storage/` | 当前 Raw/Derived 不可变发布和恢复 | durability 高风险 |
| `src/sciretriever/normalization/` | 当前 PDF/XML/HTML 归一化和 parser 接入 | 解析边界高风险 |
| `src/sciretriever/packaging/` | 当前处理快照发布 | 公开导出合同高风险 |
| `src/sciretriever/cli/` | 当前 composition root 和配置装配 | 用户入口高风险 |

## 5. 产品边界与设计治理

- 产品主流程是“领域条件或种子文献 → 多来源元数据 → 文献资产 → 轻结构化文本 → 通用结构化文献分析 → 可持续使用的文献数据库”。目标设计必须完整覆盖该流程和需求中的批量、局部成功、重复运行、查询、书目信息交换与可追溯性验收。
- `Work`、`WorkVersion` 是 ADR 0002 接受的内部身份机制；阶段枚举、completion pipeline、CLI 命令、SQLite、`DocumentPackage` 和当前目录划分仍是实现或派生设计，不是产品需求。
- 设计文档负责系统架构、模块命名、责任、数据流和所有权；技术文档负责代码映射、依赖、持久化、外部访问和运行技术；README、CLI `--help`、源码与测试负责当前已实现行为。
- 设计审查应建立“需求 → 系统行为 → 数据与状态 → 模块责任 → 验收”的可追踪关系，并删除无需求依据的旧设计。
- 模块依赖和责任边界通过权威设计文档、代码审查与相关行为测试确认；除非 owner 明确要求，不建立项目自有架构解释器或阻断门禁。

## 6. 不可协商的数据边界

- SciRetriever 止于通用文献元数据、资产信息、轻结构化文本和产品规定含义的通用结构化文献分析结果；不得加入反应、分子、路线、产率等领域 schema。
- `package_versions` 是处理快照，不是已经实现的书目 `WorkVersion`。
- catalog 不存大型 BLOB，不存绝对资产路径；文件系统存字节，catalog 存相对路径、hash、关系和 provenance。
- RawAsset 永不原地修改；发布只允许 create-if-absent，不覆盖冲突证据。
- 元数据、资产和解析结果不得丢失来源、输入、hash 或 lineage。
- 下游通过文档化的稳定 ID、hash、provenance 和领域中立合同集成，不直接依赖内部数据库表。
- MinerU 是当前 operator-managed PDF parser adapter；不得把其服务协议、输出格式或额外 LLM 分析反向写成核心产品需求。

## 7. 真相源

| 主题 | 真相源 |
|---|---|
| ADR 权威范围与阅读顺序 | `docs/architecture/decisions/README.md` |
| 领域与数据边界 | `docs/architecture/decisions/0001-sciretriever-scope-and-boundary.md` |
| Work/WorkVersion 内部身份与单机增量处理 | `docs/architecture/decisions/0002-literature-identity-and-incremental-processing.md` |
| MinerU parser/service connection 与外部 attempt/evidence 边界 | `docs/architecture/decisions/0003-operator-managed-mineru-service.md` |
| 长期架构原则 | `docs/architecture/principles.md` |
| 理想产品数据流与模块责任 | `docs/architecture/design.md` |
| 理想代码模块与依赖边界 | `docs/architecture/technical.md` |
| 用户安装、命令和配置 | `README.md`、`docs/guides/config.toml`、`docs/guides/config.minimal.toml`、`docs/guides/configuration.md` |
| 代码到文档同步 | `docs/development/documentation-map.md` |
| 跨项目协作规则 | `HARNESS.md` |

requirements、design 和 technical 描述产品目标和派生设计，不承担现状或执行进度追踪。代码表达实际行为，README 是当前用户解释层；不得把理想能力写成当前实现，也不得让当前实现反向覆盖需求。`docs/proposals/` 只保留活动提案，完成或终止后及时归档；OMO 执行计划只放在 `.omo/plans/`，不进入项目文档。

## 8. 当前关键实现与测试

以下条目是理解和回归当前行为的入口，不表示目标设计必须继续采用相同模块或合同。

- `src/sciretriever/core/contracts.py`：冻结、可序列化的中性边界对象。
- `src/sciretriever/integrations/`：一个供应商一个共享 client，能力 adapter 只做边界转换。
- `src/sciretriever/network/secure.py`：有界读取、DNS pinning、重定向复检和敏感 header 处理。
- `src/sciretriever/storage/coordinator.py`：durability 优先的不可变发布。
- `tests/test_discovery_acceptance.py`：离线端到端 Discovery 验收。
- `tests/test_download_wp3.py`：WorkVersion selector、三层 acquisition、身份拒绝、幂等复用和脱敏诊断。
- `tests/test_browser_wp3.py`：browser profile snapshot、网络边界、deadline 和 cleanup。
- `tests/test_raw_asset_crash_recovery.py`：崩溃恢复与证据保留模式。
- PDF analysis 已实现；MinerU 接入边界见 `docs/notes/mineru.md`，SciRetriever 只连接 operator-managed 服务。
- `tests/test_completion_wp5.py`：真实临时 SQLite/不可变存储上的 DOI 到 COMPLETE、重启、并发和原子回滚验收。

## 9. 雷区和遗留代码

- 当前 pre-v1 无受支持旧 catalog；不保留 legacy import、旧 schema、迁移 adapter 或退休数据库 guard。
- `catalog/models.py`、schema bootstrap、`core/package.py`：修改前必须读 ADR、设计文档和直接测试。
- `network/secure.py`、URL policy、credential plumbing：修改必须做安全专项检查。
- `dist/`、`build/`、`.venv/`、运行时 catalog、下载资产和语料不得提交。

## 10. 文档、Git 与审查覆盖

- 代码变化按 `docs/development/documentation-map.md` 同步责任文档。
- 提交格式采用英文 Conventional Commits；当前仅 `POLICY`，无 commit-msg hook。
- 实现、直接测试和必要契约文档应在同一原子提交；纯用户指南可独立提交。
- 只有用户明确要求时执行 commit、push、rebase、PR 或发布。
- 完成后的集中审查最多使用 2 个 reviewer；按实际风险选择目标/质量和安全/QA 角色。
- 公开契约、不可变存储、网络安全、边界变化和未来受支持数据迁移需要人工判断。本次 pre-v1 schema 直接替换已获 owner 批准。

## 11. 完成检查

- [ ] 需求、代码、测试和责任文档一致。
- [ ] 修改文件无新增诊断。
- [ ] 相关测试通过。
- [ ] `quick_check` 通过；交付前 `full_check` 通过。
- [ ] diff 无凭据、数据、生成物或无关改动。
- [ ] Git 操作没有超出用户授权。
