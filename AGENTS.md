# SciRetriever 仓库协作规范

> 本文件是 SciRetriever 的项目画像、真相源索引和项目级约束入口。稳定工程工作流、质量门禁、Git 纪律和通用完成标准见 [HARNESS.md](HARNESS.md)。

## 1. 真相源与阅读顺序

按当前任务范围渐进读取，不要求每次遍历全部文档：

1. 先确认用户要求、授权范围和完成条件，并阅读 [HARNESS.md](HARNESS.md)。
2. 产品能力、范围或验收问题读取[产品需求](docs/architecture/requirements.md)。
3. 长期设计选择从[架构决策索引](docs/architecture/decisions/README.md)找到适用的 Accepted ADR。
4. 模块责任、数据所有权、依赖、持久化或外部访问问题读取[架构原则](docs/architecture/principles.md)、[设计文档](docs/architecture/design.md)及对应[技术文档](docs/architecture/technical.md)。
5. 再读取当前实现、公开调用方、直接测试和必要的[代码与文档映射](docs/development/documentation-map.md)。

| 内容 | 权威位置 |
| --- | --- |
| 产品问题、范围和 R1-R8 验收 | `docs/architecture/requirements.md` |
| 已接受且长期有效的选择 | `docs/architecture/decisions/` |
| 模块、数据流和事实所有权 | `docs/architecture/design.md` |
| 代码结构、Model、Ports 和运行技术 | `docs/architecture/technical.md`、`docs/architecture/technical/` |
| 当前已经实现的安装与用户行为 | `README.md`、`docs/guides/`、源码和测试 |
| 易变 Provider、MinerU 等外部事实 | `docs/notes/` |
| 活动实施计划 | `docs/plans/`；用于执行与恢复，不属于产品或架构真相源 |

目标文档说明应当实现什么，README、源码和测试说明当前行为。不得用当前实现否定已接受设计，也不得把尚未实现的能力写成已发布行为。

默认沟通和项目文档使用中文；代码标识符、异常、日志和提交信息使用英文。

## 2. 项目画像

| 字段 | 值 |
| --- | --- |
| 项目定位 | 面向用户指定研究领域的大批量文献收集与文献数据库维护工具；产品自身保持领域中立 |
| 主要语言 | TypeScript/Node 22.19.0；Python 仅为历史维护材料 |
| 包管理 | `pnpm`，锁文件 `pnpm-lock.yaml` |
| 活动源码 | `packages/`、`apps/server/src/`、`apps/web/src/` |
| 测试 | `packages/*/test/`、`apps/*/test/`，Vitest；`tests/fixtures/` 仅保存合成兼容 fixture |
| 质量入口 | `pnpm quick / test / full`；Python Harness 仅为历史维护入口 |
| CI | 普通非 master 分支 push 运行 TS Quick；PR、master 和手动运行执行 TS Full（Node 22.19.0） |
| 临时文件 | 系统临时目录下的 `sciretriever-*` |
| 不提交内容 | 个人配置、运行时 catalog、文献资产、用户语料、`.venv/`、`build/`、`dist/`、缓存和临时文件 |

当前实现是按功能模块组织的模块化单体：

~~~text
entry/
metadata/
literature/
acquisition/
parsing/
analysis/
model/
network/
storage/
logging/
configuration/
bootstrap/
~~~

模块责任和依赖以[设计文档](docs/architecture/design.md)及[技术文档](docs/architecture/technical.md)为准。跨功能模块通过公开 TypeScript API 和中性 Model 协作；外部协议在所属 adapter 边界转换；`configuration/` 与 `bootstrap/` 负责生产组装，不增加新的核心产品模块。迁移前的 Python 源码、测试和工具链快照位于 `archive/2026-09-12-typescript-python-retirement/`，不属于活动源码。

## 3. 开发与架构演进

- 围绕一个可说明的能力切片确认合同，再同步修改相关源码、直接测试、对象图和必要文档。
- 当前目录和内部 API 可以在任务范围内重构，但不能绕过已接受的模块责任、依赖方向、数据所有权和公开边界。
- 修改共享合同前检查生产者、消费者、序列化、持久化和兼容性影响；不默认破坏受支持的用户数据、配置、数据库或文件格式。
- 若确需破坏公开合同或受支持数据格式，先取得明确授权，更新 requirement/ADR 及迁移或弃用策略，再实施代码变化。
- 代码与目标文档冲突时，先判断是实现缺陷还是合同确需修改；只有后者才更新 requirements、ADR、design 或 technical。
- 现有测试若与 Accepted 合同冲突，应修正测试或实现；仍验证用户结果、安全边界、数据完整性和已接受合同的测试不得弱化。
- 不强制每个函数使用固定形态，但新行为、错误路径和回归修复应有能证明重要结果的直接测试。
- 不顺手增加当前需求之外的新模块、状态、持久化事实、兼容体系或机械门禁。

## 4. 不可协商的产品与数据边界

- SciRetriever 止于通用文献元数据、资产、轻结构化文本、产品规定的通用结构化文献分析结果，以及必要的 provenance、lineage、处理证据和失败信息。
- 反应、分子、路线、产率、材料性质等特定领域 schema 和数据属于下游消费者，不进入 SciRetriever 文献数据库。
- `MetaLiterature` 和 `Literature` 是当前身份机制；来源 observation 必须保留，身份收敛必须保守、确定且可审计。
- 系统只有一个统一逻辑文献数据库；每项可变业务事实只有一个业务写入所有者。Storage 保存已确认事实，不自行形成业务决定。
- SQLite/catalog 不保存大型 BLOB 或机器相关的绝对资产路径；文件系统保存字节，catalog 保存规范相对引用、hash、关系和 provenance。
- 已接纳的原始资产和发布产物不得原地覆盖。发布采用 create-if-absent；目标路径存在不同字节时保留冲突证据并拒绝覆盖。
- 元数据、资产、解析结果和分析结果不得丢失来源、输入 hash、provenance 或 lineage；后续阶段失败不得撤销已经提交的有效事实。
- MinerU 是 operator-managed 的外部 parser service。它的协议、输出格式和运行状态不得反向成为核心产品需求或第二套业务状态。
- 下游只依赖文档化的稳定 ID、hash、provenance 和领域中立合同，不直接依赖内部数据库表。

## 5. 验证入口

依据项目 owner 于 2026-09-10 的决定，后续开发和全量验收转向 TypeScript，不再默认运行 Python Quick、Full 或全量 unittest。从仓库根目录执行：

~~~bash
pnpm install --frozen-lockfile
pnpm exec vitest run <相关测试文件>
pnpm quick
pnpm full
~~~

- 相关测试：开发循环和单个能力切片的首选反馈。
- Quick：Prettier、ESLint、源码和测试 strict 类型检查。
- Full：Quick、全部 Vitest 与所有已注册 TS project 的构建；代码交付默认必须通过。
- Python Harness、Python 源码和既有 Python 测试已归档到 `archive/2026-09-12-typescript-python-retirement/`，不作为 TS 交付的阻断项；只有用户明确要求历史复核时才处理归档快照。
- 文档-only 修改检查 diff、链接、术语、命令事实和 Markdown 结构。
- Full 未通过或未运行时不得声称代码修改已经完成质量验收；确因环境无法运行时，准确说明原因、已运行检查和残余风险。

精确步骤见 [HARNESS.md](HARNESS.md)、`package.json` 与 CI；当前包、离线安装验证和恢复入口见
[TypeScript 基础开发入口](docs/development/typescript-foundation.md)。TS 生产路径不依赖 Python；历史源码归档已完成，真实用户数据切换仍需按计划授权执行。

TS Full 使用 TypeScript Configuration/Credential owner 和合成临时 home，不启动 Python bridge；Python Harness 与既有测试只作为明确要求时的历史维护入口。安装、依赖和支持边界见 [TypeScript 基础开发入口](docs/development/typescript-foundation.md)。

## 6. 必须保留的安全边界

- 工作树默认可能不干净。不得回滚、覆盖、格式化掉或顺手提交任务无关的用户改动。
- 未经明确授权，不执行 commit、amend、rebase、push、PR、发布、破坏性 Git 或会丢失数据的清理。
- 测试和 Harness 不连接真实 Provider、真实凭据、生产数据库或用户语料。
- 不读取、打印、硬编码或提交 secret、Cookie、Token、签名 URL、个人 `config.toml` 或用户凭据文件。
- 不修改、迁移或删除用户资产、真实 catalog 或仓库外材料，除非任务明确授权并先解析精确目标。
- 临时文件和测试数据库进入系统临时目录，不散落到仓库根目录。
- 依赖或 `pnpm-lock.yaml` 只在当前实现明确需要时修改，不顺手升级无关依赖；交付时说明原因和影响。
- 外部 HTTP、浏览器、MinerU 和 LLM 测试使用 fake、fixture 或明确的离线边界；真实只读探测也必须由用户明确要求。
- 产品边界、事实所有权、不可变资产、凭据和网络安全由 requirements 与 Accepted ADR 约束，任何工作方式都不能绕过。

## 7. 文档与交付

`docs/development/documentation-map.md` 是影响分析索引，不是要求每个内部文件变化都改写所有关联文档的阻断清单。公开行为、配置、schema、持久化语义、模块责任、入口和验证命令变化时，必须同步相应真相源与当前行为文档。

交付时说明：

- 实际完成范围；
- 运行的相关测试、Quick、Full 或其它验收及其结果；
- 未运行检查及原因；
- 依赖、公开行为、schema、兼容性或目标合同变化；
- 已知残余风险和需要用户决定的事项；
- 最终 diff 没有夹带凭据、真实数据、构建产物或无关改动。

代码交付只有在目标路径、直接测试、生产对象图、必要当前文档和 Full Harness 形成闭环后，才可以声明完成。
