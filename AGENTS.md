# SciRetriever 仓库协作说明

> SciRetriever 当前处于 pre-v1 目标架构替换阶段。本文只保留代理进入仓库时需要知道的项目入口、重构自由度和安全底线；产品与架构事实以 requirements、Accepted ADR、design 和各模块 technical 文档为准，本文不再复制整套派生约束。工程验证见 [HARNESS.md](HARNESS.md)。

## 1. 当前阶段

当前工作不是在稳定产品上做小步兼容维护，而是依据已经确认的目标架构重建主要源码、测试、组装和用户入口。

因此：

- 当前旧源码、旧目录、旧内部 API 和只验证旧架构的测试是迁移材料，不是必须兼容的产品合同。
- 可以在任务范围内成组删除、移动、重命名或重写模块、测试、内部 schema、SQLite schema 和对象图。
- 可以在迁移期间短暂保留新旧实现并存或不完整的内部切片；不能把这种中间状态描述为已经集成或发布。
- 当前 pre-v1 不默认承担旧内部 API、旧数据库、旧配置或旧文件格式的兼容与迁移成本；只有用户明确要求时才增加兼容层。
- 不要求每个工作包都保持全库 Full Harness 绿色。相关切片应尽量可验证，完整集成质量在里程碑、PR、主分支和发布边界统一检查。
- 现有测试若与 Accepted 目标设计冲突，应更新或删除，不得为了保住旧测试而恢复已经撤销的概念。
- 大范围重构不要求实现、全部测试和全部文档在一个最小原子修改中完成；应按能够理解和继续集成的工作包推进，并明确当前完成范围和已知缺口。

这些自由只放宽迁移过程，不放宽产品边界、凭据安全、外部访问安全、用户数据保护和最终集成质量。

## 2. 真相源与阅读顺序

按当前任务需要渐进读取，不要求每次遍历全部文档：

1. 先确认用户当前要求和任务边界。
2. 产品能力、范围或验收问题读取[产品需求](docs/architecture/requirements.md)。
3. 长期设计选择从[架构决策索引](docs/architecture/decisions/README.md)找到适用的 Accepted ADR。
4. 模块责任、数据所有权、依赖或持久化问题读取[架构原则](docs/architecture/principles.md)、[设计文档](docs/architecture/design.md)及对应[模块技术文档](docs/architecture/technical.md)。
5. 再读取当前实现、相关测试和必要的[代码与文档映射](docs/development/documentation-map.md)。

| 内容 | 权威位置 |
| --- | --- |
| 产品问题、范围和 R1-R8 验收 | docs/architecture/requirements.md |
| 已接受且长期有效的选择 | docs/architecture/decisions/ |
| 目标模块、数据流和事实所有权 | docs/architecture/design.md |
| 目标代码结构、Model、Ports 和运行技术 | docs/architecture/technical.md、docs/architecture/technical/ |
| 当前已经实现的安装与用户行为 | README.md、docs/guides/、源码和测试 |
| 易变 Provider、MinerU 等外部事实 | docs/notes/ |
| 实施顺序和临时计划 | .omo/plans/；不属于项目真相源 |

目标文档描述应当实现什么，旧代码描述迁移起点。不得用旧实现否定已经接受的目标设计，也不得把尚未实现的目标能力写成当前已发布行为。

默认沟通和项目文档使用中文；代码标识符、异常、日志和提交信息使用英文。

## 3. 项目画像

| 字段 | 值 |
| --- | --- |
| 项目定位 | 面向用户指定研究领域的大批量文献收集与文献数据库维护工具 |
| 主要语言 | Python 3.10+；开发基线 Python 3.12 |
| 包管理 | uv，锁文件 uv.lock |
| 活动源码 | src/sciretriever/ |
| 测试 | tests/，标准库 unittest |
| 质量入口 | scripts/harness.py quick / full |
| CI | 普通分支 push 运行 Quick；PR、master 和手动运行执行 Python 3.10/3.12 Full |
| 临时文件 | 系统临时目录下的 sciretriever-* |
| 不提交内容 | .omo/、个人配置、运行时 catalog、文献资产、用户语料、.venv/、build/、dist/、缓存和临时文件 |

当前目标是按功能模块组织的模块化单体：

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
bootstrap.py
~~~

模块责任和依赖以[设计文档](docs/architecture/design.md)及[技术文档](docs/architecture/technical.md)为准。跨功能模块通过公开 api.py 和中性 Model 协作；外部协议在对应 adapter 边界转换；根级 bootstrap.py 负责生产组装。迁移可以分阶段实现这些边界，不需要为了旧目录保持平行的长期架构。

## 4. 重构工作方式

- 先围绕一个可说明的能力切片确定目标合同，再改相关源码、测试和组装；不以最小 diff 为目标。
- 允许删除只服务旧分层、旧命名、旧状态机、旧兼容格式或旧测试假设的代码。
- 允许先建立目标 package、Model 或 Port，再迁移调用方；工作包结束时说明哪些路径仍是临时桥接。
- 旧测试只有在仍验证用户结果、安全边界或 Accepted 合同时才必须保留。测试内部实现细节或已撤销合同的测试可以重写、合并或删除。
- 不强制 red-green-refactor、Given/When/Then 命名、每个函数单一固定形态或每个中间提交可发布；测试应证明最终重要行为，而不是维护过程仪式。
- 文档同步以合同变化和集成里程碑为单位。普通内部搬迁无需逐文件改写架构文档；公开行为真正实现后再更新 README 和用户指南。
- 代码与目标文档发生矛盾时，先判断是实现尚未迁移还是目标合同真的需要修改。只有后者才更新 requirements、ADR、design 或 technical。
- 实施中发现问题可以回到设计修订，但不得顺手增加当前需求之外的新模块、状态、持久化事实或兼容体系。

## 5. 验证入口

从仓库根目录执行：

~~~bash
uv sync --locked --dev
uv run --frozen python -m unittest discover -s tests -p 'test_<name>.py'
uv run --frozen python scripts/harness.py quick
uv run --frozen python scripts/harness.py full
~~~

- 相关测试：开发循环和单个能力切片的首选验证。
- Quick：Ruff lint、Ruff format check 和 compileall；用于发现基础机械问题，不包含全库严格类型检查和全量测试。
- Full：Quick、Pyright strict、全部 unittest、wheel 构建和 wheel 内容核对；用于集成里程碑、PR、master、发布或用户明确要求的全库验收。
- 文档-only 修改不要求运行 Python Harness；检查 diff、链接、术语和 Markdown 结构即可。
- 中间重构工作包可以交付已知的全库失败，但必须准确说明已运行的检查、失败范围和为什么尚未达到集成里程碑。声称完成集成或可发布时必须通过 Full。

精确步骤由 [HARNESS.md](HARNESS.md)、scripts/harness.py 和 CI 定义。

## 6. 必须保留的安全边界

- 工作树默认不干净。不得回滚、覆盖、格式化掉或顺手提交任务无关的用户改动。
- 未经明确授权，不执行 commit、amend、rebase、push、PR、发布、破坏性 Git 或会丢失数据的清理。
- 测试和 Harness 不连接真实 Provider、真实凭据、生产数据库或用户语料。
- 不读取、打印、硬编码或提交 secret、Cookie、Token、签名 URL、个人 config.toml 或用户凭据文件。
- 不对用户资产、真实 catalog 或仓库外材料执行修改、迁移或删除，除非任务明确授权并先解析精确目标。
- 临时文件和测试数据库进入系统临时目录，不散落到仓库根目录。
- 依赖或 uv.lock 可以在当前实现明确需要时修改，但不得顺手升级无关依赖；交付时说明原因和影响。
- 外部 HTTP、浏览器、MinerU 和 LLM 测试使用 fake、fixture 或明确的离线边界。真实只读探测也必须由用户明确要求。
- 产品和数据边界、事实所有权、不可变资产、凭据与网络安全仍由 requirements 和 Accepted ADR 约束；重构模式不能绕过它们。

## 7. 文档与交付

docs/development/documentation-map.md 是影响分析索引，不是要求每个内部文件改动都同步全部文档的阻断清单。

交付时说明：

- 本工作包实际完成了什么；
- 仍有哪些临时桥接或未迁移调用方；
- 运行了哪些相关测试、Quick 或 Full；
- 已知失败是否只属于未完成的集成范围；
- 是否修改依赖、公开行为、schema 或目标合同；
- 没有夹带凭据、真实数据、构建产物或无关改动。

只有在声称一个集成里程碑已经完成时，才要求目标路径、直接测试、对象图和必要当前文档形成完整闭环。
