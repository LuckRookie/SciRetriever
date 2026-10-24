# SciRetriever 仓库协作规范

类型：开发
负责：项目画像、真相源索引与协作边界
状态：现行

> 本文件是 SciRetriever 的项目画像、真相源索引和项目级约束入口。稳定工程工作流、质量门禁、Git 纪律和通用完成标准见 [HARNESS.md](HARNESS.md)。

## 1. 真相源与阅读顺序

按当前任务范围渐进读取，不要求每次遍历全部文档：

1. 先确认用户要求、授权范围和完成条件，并阅读 [HARNESS.md](HARNESS.md)。
2. 产品能力、范围或验收问题读取[产品需求](docs/architecture/requirements.md)。
3. 长期设计选择从[架构决策索引](docs/architecture/decisions/README.md)找到适用的 Accepted ADR。
4. 模块责任、数据所有权、依赖、持久化或外部访问问题读取[架构原则](docs/architecture/principles.md)、[设计文档](docs/architecture/design.md)及对应[技术文档](docs/architecture/technical.md)。
5. 再读取当前实现、公开调用方、直接测试和必要的[代码与文档映射](docs/development/documentation-map.md)。

文档的类型、每个主题的唯一归属文档和维护规则见[文档导航](docs/README.md)。写或改文档前先查其中的主题归属表，只改归属文档，别处只链接；被取代的内容直接改掉或移走，不原地加注；ADR 接受后正文冻结，方向变化写新 ADR。

目标文档说明应当实现什么，README、源码和测试说明当前行为。不得用当前实现否定已接受设计，也不得把尚未实现的能力写成已发布行为。

默认沟通和项目文档使用中文；代码标识符、异常、日志和提交信息使用英文。

## 2. 项目画像

| 字段       | 值                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| 项目定位   | 科研 Agent 的原始论文材料供给与有证据知识压缩组件；提供正式人类配置、Browser 观看/指导和知识阅读，保持领域中立 |
| 主要语言   | TypeScript/Node 22.19.0；Python 仅为历史维护材料                                                               |
| 包管理     | `pnpm`，锁文件 `pnpm-lock.yaml`                                                                                |
| 活动源码   | `packages/`、`apps/server/src/`、`apps/web/src/`                                                               |
| 测试       | `packages/*/test/`、`apps/*/test/`，Vitest；`tests/fixtures/` 仅保存合成兼容 fixture                           |
| 质量入口   | `pnpm quick / test / full`；Python Harness 仅为历史维护入口                                                    |
| CI         | 普通非 master 分支 push 运行 TS Quick；PR、master 和手动运行执行 TS Full（Node 22.19.0）                       |
| 临时文件   | 本机真实/一次性测试用 `sandbox/`；自动化回归的临时 home/合成库及短期工具文件用系统临时目录 `sciretriever-*`    |
| 不提交内容 | `sandbox/`、个人配置、运行时 catalog、文献资产、用户语料、`.venv/`、`build/`、`dist/`、缓存和临时文件          |

当前活动实现是按功能模块组织的 TypeScript/Node 模块化单体：

```text
packages/contracts/          # 跨模块中性合同与解析
apps/server/src/
  entry/ application/        # 用户操作边界、生命周期与 durable jobs
  metadata/ literature/      # 元数据与文献事实
  providers/                 # 按供应商组织的外部适配器与静态服务定义
  acquisition/ parsing/     # 资产获取与解析
  analysis/ agents/          # 分析与共享模型/受控 Agent 执行
  network/ storage/ logging/ # 共享访问、持久化与日志
  configuration/ bootstrap/ # 配置与生产对象图
  browser/ workbench/ cli/  # Browser 边界、工作台与入口适配
apps/web/src/                # Web 工作台适配
```

模块责任、目标依赖和当前状态以[设计文档](docs/architecture/design.md)、[技术文档](docs/architecture/technical.md)和 [TypeScript 架构锚定基线](docs/architecture/typescript-baseline.md) 为准。跨功能模块通过公开 TypeScript API 和 `packages/contracts` 中性合同协作；外部协议在所属 adapter 边界转换；`configuration/` 与 `bootstrap/` 负责生产组装，不增加新的核心产品模块。迁移前的 Python 源码、测试和工具链快照位于 `archive/2026-09-12-typescript-python-retirement/`，不属于活动源码；工作区内其它历史或生成目录不得未经授权清理。

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

- SciRetriever 止于通用文献元数据、原始资产、可读文档与证据、产品规定的通用分析/压缩/综合结果、检索上下文及调用方规范下的提取候选，以及必要的 provenance、lineage 和失败信息；Agent 与人类共享知识事实。当前新目标及未决边界见 ADR 0026，新增能力不得当作已实现。
- 按 ADR 0027/0034，领域记录含义、schema 和最终数据集由调用方/下游拥有；平台提供可替换默认提取、外部交付及独立候选长期托管。Analysis 拥有通用处理器与结果接纳，Extraction 拥有外部候选校验；领域 payload 不成为 Literature 固定字段或权威文献事实。实施状态以源码和验收为准。
- `MetaLiterature` 和 `Literature` 是当前身份机制；来源 observation 必须保留，身份收敛必须保守、确定且可审计。
- 系统只有一个统一逻辑文献数据库；每项可变业务事实只有一个业务写入所有者。Storage 保存已确认事实，不自行形成业务决定。
- SQLite/catalog 不保存大型 BLOB 或机器相关的绝对资产路径；文件系统保存字节，catalog 保存规范相对引用、hash、关系和 provenance。
- 已接纳的原始资产和发布产物不得原地覆盖。发布采用 create-if-absent；目标路径存在不同字节时保留冲突证据并拒绝覆盖。
- 元数据、资产、解析结果和分析结果不得丢失来源、输入 hash、provenance 或 lineage；后续阶段失败不得撤销已经提交的有效事实。
- MinerU 是 operator-managed 的外部 parser service。它的协议、输出格式和运行状态不得反向成为核心产品需求或第二套业务状态。
- 下游只依赖文档化的稳定 ID、hash、provenance 和领域中立合同，不直接依赖内部数据库表。

## 5. 验证入口

测试选择、显式并发、Quick/Full 的内容与运行时机统一遵循 [HARNESS 第 5.4 节](HARNESS.md#54-typescript-开发验证)和[验证规则](HARNESS.md#6-测试验证与语义审查)。按改动影响范围先跑定向验证，未执行或失败的检查如实报告；本页不维护第二份测试政策和命令清单。

包与开发入口见[TypeScript 基础开发入口](docs/development/typescript-foundation.md)。

## 6. 必须保留的安全边界

- 工作树默认可能不干净。不得回滚、覆盖、格式化掉或顺手提交任务无关的用户改动。
- 未经明确授权，不执行 commit、amend、rebase、push、PR、发布、破坏性 Git 或会丢失数据的清理。
- 测试和 Harness 不连接真实 Provider、真实凭据、生产数据库或用户语料。
- 不读取、打印、硬编码或提交 secret、Cookie、Token、签名 URL、个人 `config.toml` 或用户凭据文件。
- 不修改、迁移或删除用户资产、真实 catalog 或仓库外材料，除非任务明确授权并先解析精确目标。
- 本机真实/一次性测试的用例、运行材料和报告进入 Git 忽略的 `sandbox/`；自动化回归的临时 home/合成数据库及短期工具文件进入系统临时目录 `sciretriever-*`，不散落到仓库根目录。
- 依赖或 `pnpm-lock.yaml` 只在当前实现明确需要时修改，不顺手升级无关依赖；交付时说明原因和影响。
- 外部 HTTP、浏览器、MinerU 和 LLM 测试使用 fake、fixture 或明确的离线边界；真实只读探测也必须由用户明确要求。
- 产品边界、事实所有权、不可变资产、凭据和网络安全由 requirements 与 Accepted ADR 约束，任何工作方式都不能绕过。

## 7. 文档与交付

项目维护的每个目录都应有 `README.md`，说明本目录职责、主要内容和下级分工，并指向上级导航或相关真相源；整体地图在[根 README](README.md#项目目录地图)。新建、移动或改变目录职责时同步维护说明，不只列文件名。第三方依赖、构建产物、工具状态内部、原始运行数据与历史快照不逐层插入 README，由上级说明其身份；本机目录的说明同样留在 Git 忽略范围。

`src/` 内的 `README.md` 必须自包含：说明模块职责、当前代码入口和源码树内导航，不链接源码树之外的计划、架构文档、归档、仓库其他文件或网页。根级源码 README 不要求向源码树外提供上级链接。

`docs/development/documentation-map.md` 是影响分析索引，不是要求每个内部文件变化都改写所有关联文档的阻断清单。公开行为、配置、schema、持久化语义、模块责任、入口和验证命令变化时，必须同步相应真相源与当前行为文档。

交付时说明：

- 实际完成范围；
- 运行的相关测试、Quick、Full 或其它验收及其结果；
- 未运行检查及原因；
- 依赖、公开行为、schema、兼容性或目标合同变化；
- 已知残余风险和需要用户决定的事项；
- 最终 diff 没有夹带凭据、真实数据、构建产物或无关改动。

代码交付只有在目标路径、直接测试、生产对象图、必要当前文档和与改动影响范围匹配的验收形成闭环后，才可以声明完成；不以重复运行无关耗时测试代替影响分析。
