# SciRetriever 仓库协作规范

> 本文件是 SciRetriever 的项目画像、真相源索引和项目级约束入口。稳定的工程工作流、质量门禁、Git 纪律和通用完成标准见 [HARNESS.md](HARNESS.md)。修改仓库前先读本文件，再按任务范围读取对应真相源。

## 1. 文件职责与工作顺序

1. 阅读 [HARNESS.md](HARNESS.md)，确认工作树保护、实施、验证和交付规则。
2. 从[产品需求](docs/architecture/requirements.md)确认用户问题、产品结果和验收标准。
3. 通过[架构决策索引](docs/architecture/decisions/README.md)查找当前问题适用的 Accepted ADR。
4. 涉及架构、模块责任、数据所有权、持久化或外部访问时，依次阅读[架构原则](docs/architecture/principles.md)、[设计文档](docs/architecture/design.md)和[技术文档](docs/architecture/technical.md)。
5. 阅读当前实现、直接调用方和测试，并按[代码与文档同步映射](docs/development/documentation-map.md)确定同步范围。

需求、ADR、设计和技术文档描述产品目标与已接受的派生设计；README、源码和测试描述当前实现。不得把理想能力写成已经发布的行为，也不得用当前代码反向证明目标设计正确。

默认沟通和项目文档使用中文；代码标识符、异常、日志和提交信息使用英文。

### 1.1 架构约束如何演进

本文件汇总当前已接受的项目级约束，但不取代 requirements、ADR、design 和 technical，也不把当前目录永久冻结：

- 普通实现和重构必须遵守当前已接受的边界。
- 仅调整文件、命名或内部实现且不改变责任边界时，更新代码、测试和受影响的当前文档即可。
- 改变模块责任、依赖方向、持久化所有权或关键技术选择时，先更新 ADR、design 或 technical，再同步本文件。
- 改变产品能力、数据边界或用户可观察合同的任务，先更新 requirement；需要长期约束的关键选择再新增或替代 ADR。
- 已获 owner 批准的架构演进可以修改本文件；不得仅以旧代码或本文件拒绝已经获批的变化。

## 2. 项目画像

| 字段 | 值 |
| --- | --- |
| 项目定位 | 面向用户指定研究领域的大批量文献收集工具；产品自身保持领域中立 |
| 产品结果 | 可持续积累、查询并交换书目信息的文献数据库 |
| 权威数据边界 | 通用文献元数据、资产信息、轻结构化文本、通用结构化文献分析结果及其 provenance；领域数据留在下游 |
| 主要语言与运行时 | Python 3.10+；开发基线 Python 3.12 |
| 包管理器 | `uv`；锁文件为 `uv.lock` |
| 活动源码 | `src/sciretriever/` |
| 测试 | `tests/`；标准库 `unittest` |
| Harness | `scripts/harness.py`，只提供 `quick` 和 `full` 两种模式 |
| CI | `.github/workflows/ci.yml`；Python 3.10 和 3.12 均运行 Full Harness |
| 临时文件 | 系统临时目录下的 `sciretriever-*`；不得散落在仓库根目录 |
| 构建产物 | `build/`、`dist/`；均不得提交 |

## 3. 环境与命令入口

所有命令从仓库根目录执行。Ruff、编译、Pyright、全部测试和 wheel 检查的准确范围由 [HARNESS.md](HARNESS.md) 与 `scripts/harness.py` 定义，本文件不复制其内部命令。

| 层级 | 用途 | 命令 | 规则强度 |
| --- | --- | --- | --- |
| - | 安装锁定开发依赖 | `uv sync --locked --dev` | 环境准备 / CI |
| L0 | 包导入与版本冒烟 | `uv run --frozen python -c "import sciretriever; print(sciretriever.__version__)"` | LOCAL GATE |
| L0 | 单个测试文件 | `uv run --frozen python -m unittest discover -s tests -p 'test_<name>.py'` | LOCAL GATE |
| L1 | 快速机械检查 | `uv run --frozen python scripts/harness.py quick` | LOCAL GATE |
| L1-L3 | 完整质量检查 | `uv run --frozen python scripts/harness.py full` | LOCAL GATE / CI GATE |
| L4 | 语义审查 | 对照需求、适用 ADR、责任文档、测试和最终 diff | POLICY |
| L5 | 人工判断 | 新 ADR、公开边界变化、受支持数据迁移或生产数据操作 | HUMAN GATE |

环境约束：

- 优先使用仓库现有 `.venv`；不要复制归档环境或创建平行环境。
- 未经用户授权，不升级运行时依赖，不修改 `uv.lock`。
- 测试、构建和 Harness 不得连接真实供应商、生产数据库或用户语料。
- 根目录 `config.toml` 可能包含个人运行配置；除非任务明确要求并完成敏感信息检查，否则不得提交。

## 4. 真相源与任务路由

| 主题 | 首要真相源 |
| --- | --- |
| 产品问题、核心流程、产品结果与验收 | [产品需求](docs/architecture/requirements.md) |
| ADR 的效力、状态与阅读顺序 | [架构决策索引](docs/architecture/decisions/README.md) |
| 领域与数据边界 | [ADR 0001](docs/architecture/decisions/0001-sciretriever-scope-and-boundary.md) |
| Work/WorkVersion 身份与单机增量处理 | [ADR 0002](docs/architecture/decisions/0002-literature-identity-and-incremental-processing.md) |
| MinerU 服务所有权和 parser 边界 | [ADR 0003](docs/architecture/decisions/0003-operator-managed-mineru-service.md) |
| requirements 与派生设计的责任边界 | [ADR 0004](docs/architecture/decisions/0004-requirement-led-literature-collection.md) |
| DocumentPackage 2.0 不兼容合同 | [ADR 0005](docs/architecture/decisions/0005-document-package-2-breaking-contract.md) |
| 长期实现与审查原则 | [架构原则](docs/architecture/principles.md) |
| 理想系统的数据流、模块责任与事实所有权 | [设计文档](docs/architecture/design.md) |
| 目标代码结构、依赖、Ports、持久化和运行技术 | [技术文档](docs/architecture/technical.md) |
| 当前用户安装、命令和配置 | [README](README.md)、[用户指南](docs/guides/README.md)和[配置手册](docs/guides/configuration.md) |
| Provider、MinerU 等易变外部事实 | [Notes 索引](docs/notes/README.md) |
| 代码变化需要同步的文档 | [代码与文档同步映射](docs/development/documentation-map.md) |
| 工程流程、机械门禁与完成标准 | [HARNESS.md](HARNESS.md) |

`docs/proposals/` 只保存活动提案，`docs/archive/` 只保存历史材料；两者都不能越过当前真相源授权实现。`.omo/` 保存个人执行计划和状态，不属于项目真相源，不进入正式提交。

## 5. 当前目标架构

当前已接受的目标是模块化单体和六层结构。该结构定义责任与依赖方向，不代表迁移已经完成，也不要求在迁移计划中记录的每个文件位置永久不变。

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Model | 使用 Pydantic v2 声明内部交换的纯数据，并完成受控的结构解析 | 业务判断、业务流程、I/O 和外部调用 |
| Core | 纯业务规则与决定；解释身份、验收、状态和 evidence 含义 | 数据库、文件、网络、供应商协议和用例编排 |
| Services | 编排用例、调用 Core，并通过自己拥有的 Ports 请求外部能力 | 重新定义业务规则或选择具体技术实现 |
| Infrastructure | 实现 Ports，以及存储、访问、来源、parser、LLM、记录 I/O 和本机锁 | 文献身份、最终验收、状态推导和导出资格判断 |
| Interface | 解析用户输入、调用公开 Service API、呈现稳定结果 | 业务规则、持久化和具体外部能力 |
| Composition | 读取运行配置、选择实现并构造对象图 | 产品规则和用户交互语义 |

依赖由外向内：Core 只消费 Model；Services 消费 Core 和 Model；Infrastructure 实现 Services 所拥有的 Ports；Interface 只依赖公开 Service API 和 Model；Composition 是唯一可以了解全部具体实现并完成组装的边界。

项目级建模约束：

- 结构化业务数据统一使用 Pydantic v2，不用 dataclass、裸字典或 vendor model 建立第二套内部业务合同。
- Model 默认不可变。validator 只做纯结构验证、格式转换、不可变容器转换和跨字段结构约束，不执行 I/O、环境读取、provider 调用或业务决定。
- 除已确认的边界需求外，Model 不增加自定义 serializer、自定义 `__init__`、`model_post_init`、普通业务方法或 property；身份、precedence、状态和 evidence 含义由 Core 决定。
- Ports 归消费它们的 Service 所有；不建立顶层共享 `ports/`、`repositories/`、`utils/` 或笼统 `integrations/` 包。
- 外部输入在 Interface 或 Infrastructure 边界解析为中性 Model；vendor、HTTP、浏览器、SQL 和文件系统类型不得进入 Core 或 Service API。
- 跨业务模块只调用公开 Service API，不导入其它模块的私有实现。

迁移期间，当前实现与目标目录可以暂时并存；新增代码应进入目标责任边界，迁移不得伪造尚未实现的公开 API。实施顺序、文件清单和完成进度只保存在 `.omo/plans/`，不写入本文件、design 或 technical。

## 6. 不可协商的产品与数据边界

- SciRetriever 止于通用文献元数据、资产、轻结构化文本、产品规定含义的通用结构化文献分析结果，以及必要的 provenance、lineage、处理证据和失败信息。
- 反应、分子、路线、产率、材料性质等特定领域 schema 和数据属于下游消费者，不进入 SciRetriever 文献数据库。
- `Work` 和 `WorkVersion` 是当前接受的内部身份机制；来源 observation 必须保留，身份收敛必须保守、确定且可审计。
- 系统只有一个统一逻辑文献数据库；每项可变业务事实只有一个业务写入所有者。Storage 保存已确认事实，不自行形成业务决定。
- SQLite/catalog 不保存大型 BLOB 或机器相关的绝对资产路径；文件系统保存字节，catalog 保存规范化相对引用、hash、关系和 provenance。
- 已接受的原始资产和发布产物不得原地覆盖。发布采用 create-if-absent；目标路径存在不同字节时保留冲突证据并拒绝覆盖。
- 元数据、资产、轻结构化文本和分析结果不得丢失来源、输入 hash、provenance 或 lineage；后续阶段失败不得撤销已经提交的有效事实。
- MinerU 是 operator-managed 的外部 parser service。它的协议、输出格式和运行状态不得反向成为核心产品需求或第二套业务状态。
- 下游只能依赖文档化的稳定 ID、hash、provenance 和领域中立合同，不直接依赖内部数据库表。
- 当前 pre-v1 内部 catalog/schema 的直接替换已获 owner 批准；这不自动授权未来受支持数据迁移，也不降低 ADR 0005 对 DocumentPackage 2.0 的合同约束。

## 7. 高风险修改路由

| 变化范围 | 修改前至少阅读 | 必须重点证明 |
| --- | --- | --- |
| 产品能力或领域边界 | requirements、ADR 0001、ADR 0004 | 用户结果、范围边界和验收仍一致 |
| Work/WorkVersion、身份或来源合并 | ADR 0002、principles、design | 保守收敛、来源事实和稳定关系不丢失 |
| DocumentPackage 合同 | ADR 0005、design、technical | schema、canonicalization、hash、URN、重放和版本拒绝语义 |
| SQLite、文件系统或不可变发布 | principles、design、technical、直接测试 | 所有权、相对路径、hash、事务、崩溃恢复和冲突证据 |
| 网络、浏览器、凭据或外部访问 | technical、provider 文档、直接安全测试 | URL/DNS/redirect、预算、清理和脱敏边界 |
| MinerU、其它 parser 或 LLM | ADR 0003、design、technical、对应 notes | operator/service 边界、中性输出、provenance 和输入对齐 |
| 六层责任或依赖方向 | requirements、适用 ADR、design、technical | 变更有上游依据，且同步更新本文件和验收证据 |
| CLI、配置或公开用户行为 | README、用户指南、配置手册、documentation map | 文档只描述已经实现并测试的行为 |

公开契约、不可变存储、网络安全、产品边界和未来受支持数据迁移需要人工判断。机械检查不能替代这些语义审查。

## 8. 文档、Git 与交付边界

- 代码变化按 [documentation map](docs/development/documentation-map.md) 同步责任文档。
- 实现、直接测试和必要的契约文档属于同一个原子变更；纯用户指南可以独立变更。
- 提交信息使用英文 Conventional Commits；当前是 POLICY，没有 commit-msg hook。
- 只有用户明确要求时才执行 commit、amend、rebase、push、PR、发布或其它历史修改。
- 不提交 `.omo/`、个人配置、运行时 catalog、下载资产、用户语料、`.venv/`、`build/`、`dist/`、缓存或临时文件。

项目交付前除 [HARNESS.md](HARNESS.md) 的通用完成标准外，还要确认：

- [ ] 改动能够追溯到需求、Accepted ADR 或明确的当前行为修复。
- [ ] 目标设计、当前实现和迁移计划没有被混写为同一种事实。
- [ ] 产品与数据边界、事实所有权、provenance 和不可变性仍然成立。
- [ ] README、用户指南和配置示例没有宣称尚未实现的能力。
- [ ] diff 不包含 `.omo` 状态、个人配置、真实数据或构建产物。
