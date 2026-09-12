# Agent 开发与质量 Harness

> 本文件定义 SciRetriever 的稳定工程工作流、质量基线、机械门禁、Git 纪律和通用完成标准。产品边界、架构约束、项目入口和真相源见 [AGENTS.md](AGENTS.md)。

## 1. 职责、权威与规则强度

本文件回答“如何可靠地完成和验证修改”，不定义产品需求、业务数据含义或架构。项目级规则必须能够追溯到 requirements、Accepted ADR、design 或 technical；机械门禁不能替代产品、架构和安全语义审查。

| 强度 | 含义 |
| --- | --- |
| POLICY | 由实现者自检和语义审查保证，不能仅凭命令判定 |
| LOCAL GATE | 可由本地命令机械检查 |
| CI GATE | 由 CI 执行并阻断失败变更 |
| HUMAN GATE | 需要授权人员对边界、风险或不可逆影响作出明确决定 |

机械门禁只实现项目 owner 已确认且工具能够稳定判断的规则：

- 不把对话总结、执行计划、审查意见、通用经验或自行推导的约束新增为 CLI 检查、固定阈值或阻断条件。
- `package.json` 定义当前 TS Quick/Test/Full，`.github/workflows/ci.yml` 定义 CI 触发和运行方式；Python Harness 与 `pyproject.toml` 已归档到 `archive/2026-09-12-typescript-python-retirement/`，不参与当前门禁。
- 修改 Quick/Full 步骤或 CI 运行方式时，同步本文件、`AGENTS.md`、直接测试和开发入口。
- 文档中的命令或路径与仓库不符时，先核实真实入口；不虚构工具，也不把未执行的能力写成门禁。

## 2. 标准工作流

非平凡修改遵循以下顺序：

1. 确认意图：提取可验证目标、约束、授权范围和完成条件。
2. 读取上下文：检查工作树、适用真相源、实现、调用方、测试和配置。
3. 确定范围：明确责任边界、兼容性、数据、安全和文档影响。
4. 实施改动：沿用已接受模式，完成最小但完整的根因修复。
5. 分层验证：先运行最小复现、相关测试和静态检查，再按风险扩大范围。
6. 语义复核：对照原始目标，检查最终 diff、诊断、文档同步和残余风险。
7. 提交或交付：仅在用户授权时执行 Git 写操作；说明结果和验证证据。

解释、诊断、审查或方案任务不越权修改；明确要求修改或构建时，应完成实现与适用验证，不停在分析阶段。

## 3. 工作树、文件与外部系统安全

### 3.1 现有改动

- 默认工作树可能不干净；未确认来源的内容视为用户改动。
- 不得回滚、覆盖、格式化掉或顺手提交任务无关改动。
- 任务文件已有改动时，先理解差异并在其基础上工作。
- 未经明确授权，不使用会丢失工作树、索引或历史内容的破坏性命令。

### 3.2 临时文件与生成物

- 临时文件、测试数据库和一次性验证材料进入系统临时目录下的 `sciretriever-*`，不散落在仓库根目录。
- 生成物通过项目规定的命令产生，不手工编辑生成文件。
- 优先使用仓库现有 `.venv`，不创建平行虚拟环境或依赖缓存，除非任务明确需要。
- 构建和测试产物在交付前检查；不提交 `build/`、`dist/`、缓存、运行时 catalog、文献资产或用户语料。

### 3.3 凭据与外部系统

- 不读取、打印、硬编码、修改或提交 secret、Cookie、Token、签名 URL、个人 `config.toml` 或用户凭据文件。
- 测试、构建和 Harness 不连接真实 Provider、生产数据库、真实凭据或用户语料。
- 外部 HTTP、浏览器、MinerU 和 LLM 测试使用 fake、fixture 或明确的离线边界。
- 不访问生产数据、不执行生产变更、不向外部系统写入，除非用户明确授权且项目权限允许。

## 4. 实施质量原则

### 4.1 先理解再修改

- 先查看同模块实现、公开 `api.py`、调用方、直接测试和适用合同，再决定抽象与命名。
- 优先使用仓库已有框架、模式和公共 helper，不建立平行体系。
- 不推测未读取代码的行为；用搜索、类型、测试或运行结果验证。
- 修改共享合同前检查生产者、消费者、序列化边界、持久化影响和兼容策略。

### 4.2 完整修复

- 修复根因，不增加只为当前测试成立的分支，不通过吞错或动态探测掩盖内部接口缺陷。
- 新行为、错误路径和回归修复应有直接测试；实现、测试和必要合同文档形成完整能力切片。
- 不通过删除、跳过或弱化有效测试，恢复已撤销概念，降低严格级别或排除活动源码获得绿色结果。
- 只有确实降低重复、耦合或认知复杂度时才增加抽象；不建立长期临时桥接或无明确边界的兼容层。

### 4.3 边界、类型与错误

- CLI、配置、数据库动态字段、第三方响应、网络和文件输入都在所属边界解析、验证并转换为中性 Model。
- 内部逻辑只消费明确类型、schema、Protocol 或领域对象；vendor、HTTP、浏览器、SQL 和文件系统类型不越过适配边界。
- 不用类型抑制、忽略诊断或关闭检查器逃避设计问题。
- 错误只在能够增加上下文、完成协议转换或形成稳定用户结果的层处理，并保留异常链。
- 禁止空 `except` 和无记录吞错；资源使用 context manager 或等价的确定性清理机制。

## 5. 验证路线与机械门禁

2026-09-10 项目 owner 决定：后续开发以 TypeScript 为主，默认 Quick/Full 分别指 `pnpm quick`/`pnpm full`；不再自动运行 Python Quick、Full 或全量 unittest。5.1–5.3 保留 Python 历史工具说明，仅在用户明确要求时使用；CI 已转向 5.4 的 TS 路线。

归档快照中的 `scripts/harness.py` 曾为 Ruff、`compileall` 和 Pyright 生成同一份排序后的 Python 文件清单。当前根目录没有活动 Python 源码，归档快照不进入 TS 验收：

- `archive/2026-09-12-typescript-python-retirement/src/sciretriever/**/*.py`；
- `archive/2026-09-12-typescript-python-retirement/tests/**/*.py`；
- `archive/2026-09-12-typescript-python-retirement/scripts/**/*.py`。

归档、虚拟环境、构建目录、缓存、生成物和 vendored code 不进入当前 TS 检查；Python 快照的历史测试发现和 wheel 内容门禁只在明确的历史复核中使用。

### 5.1 历史 Python 相关验证

开发循环先运行与改动直接相关的测试或原生命令，例如：

Python 源码和测试已移入归档快照。需要历史复核时，必须在隔离副本中恢复相应快照和合成 fixture，并明确记录其结果；当前任务不再从根目录运行这些命令。

相关验证用于快速反馈，不能单独证明跨模块或产品级修改已经完成。

### 5.2 历史 Python Quick

历史 Python Quick 的实现仍保存在 `archive/2026-09-12-typescript-python-retirement/scripts/harness.py`，不属于当前根目录的可执行门禁。

Quick 对全部活动 Python 文件执行：

1. Ruff lint；
2. Ruff format check；
3. `compileall`。

历史 Python Quick 不执行 Pyright、全量 unittest 或 wheel 构建；后续普通工作分支 push 使用 5.4 的 TS Quick。

### 5.3 历史 Python Full

历史 Python Full 的实现仍保存在上述归档快照，不属于当前根目录的可执行门禁。

Full 执行：

1. Quick 的全部步骤；
2. Pyright strict；
3. 全部 unittest，并拒绝零测试；
4. 从清理后的 staging 构建 wheel；
5. 历史复核时核对 wheel 中的 Python 模块与归档快照的 `src/sciretriever/` 一致；当前 TS 包不构建 Python wheel。

本节 Python Full 保留用于明确授权的历史维护，不作为后续 TS 代码交付、PR 或 master 的默认验收。

历史 Python 最低运行版本是 3.10，开发基线是 3.12；对应 `.python-version`、`pyproject.toml`、`uv.lock` 和 `pyrightconfig.json` 均在归档快照中。当前 TS 交付不运行这些历史检查，也不调整或弱化其工具内部检查。

### 5.4 TypeScript 开发验证

当前 TypeScript workspace 使用 `pnpm quick / test / full`，TS Full 是默认全量验收：

- Quick：Prettier、ESLint、源码 project references 构建类型检查，以及 `tsconfig.tests.json` 的测试 strict 类型检查。
- Test：Vitest 行为测试；零测试失败。包入口测试会构建两个现有 workspace，将实际 tarball 在系统临时目录离线安装，
  使用 Node 验证公开导入、配置拒绝和包内容，结束后清理自己的目录。
- Full：Quick、Test 和所有已注册 project 的 build。构建元数据进入 ignored `dist/`，不进入源码或安装包。

本地与 CI 采用同一套 TS 命令。CI 普通非 master 分支 push 运行 Quick；PR、master push 和手动运行执行 Full，
使用 Node 22.19.0、锁定 pnpm 及 Playwright 的测试 Chromium。安装依赖/二进制可以联网，行为测试仍只访问 fake/loopback。
完整平台发布和 Browser 安装旅程另按对应任务验收，两个开发包的离线安装测试不能替代最终产品安装验收。详细范围见
[TypeScript 基础开发入口](docs/development/typescript-foundation.md)。

TS Full 使用 TypeScript Configuration/Credential owner 和合成临时 home，不启动 Python bridge；Python Harness 与既有测试只作为明确要求时的历史维护入口。安装、依赖和支持边界见 [TypeScript 基础开发入口](docs/development/typescript-foundation.md)。

## 6. 测试、验证与语义审查

| 层级 | 内容 | 默认适用范围 |
| --- | --- | --- |
| L0 | diff、修改文件诊断、最小复现和相关测试 | 所有改动 |
| L1 | Quick 机械检查 | 所有代码改动 |
| L2 | 类型、模块组装、序列化合同或真实依赖的离线冒烟 | 跨模块、配置或合同改动 |
| L3 | TS 全部测试、构建、安装后验收和关键用户路径 | 代码交付、用户流程或运行时改动 |
| L4 | 需求、架构责任、安全边界与最终 diff 的语义审查 | 中高风险改动 |
| L5 | 授权人员审批 | 产品边界、生产、安全、公开合同和受支持数据迁移 |

验证规则：

- 开发循环先运行最小复现和直接测试，再运行 Quick；代码交付前默认运行 Full。
- 若因环境或任务性质未运行适用门禁，必须准确说明原因和残余风险；不得把未通过或未运行描述为通过。
- Mock 只隔离真正的外部依赖，不能 mock 掉本次要证明的对象图、事务边界或序列化合同。
- 公开合同、catalog、storage、network、身份、状态、provenance、持久化或模块边界变化时，必须对照原始需求和适用 ADR 做专项语义审查。
- Full 通过只证明已配置的机械门禁和测试通过，不替代产品、架构、安全或性能判断。

## 7. Harness 实现约束

- Harness 直接传播原生工具的失败，不重新实现 Ruff、Pyright、Python、Pydantic 或业务语义。
- 测试发现必须报告实际数量，Full 发现零测试时失败。
- wheel 构建前清理自身 staging；若 `build/` 或 `dist/` 是符号链接则 fail closed，不能删除链接目标。
- wheel 内容检查必须防止已删除模块从缓存进入安装包，并发现源码模块缺失。
- 不得把失败转换为 warning、降低 Full 严格级别、缩小活动范围或跳过步骤来虚构通过。

## 8. 文档治理

- 同一事实只指定一个真相源，其它文档通过链接解释，不维护相互漂移的独立定义。
- requirements 说明用户问题和验收，architecture 说明已接受设计，README 和用户指南说明当前行为，源码与测试提供实现证据。
- 公开 API、CLI、配置、schema、序列化格式、持久化语义、默认值、模块职责、入口或验证命令变化时，按 `docs/development/documentation-map.md` 检查文档影响。
- `docs/plans/` 保存需要跨阶段恢复的活动实施计划；它不是产品或架构真相源，计划状态不能替代源码、测试和验收证据。
- 文档-only 修改不要求运行 Python Harness；应检查链接、术语、Markdown 结构、命令事实和 `git diff --check`。

## 9. Git 与提交

执行 Git 写操作前，检查分支、上游关系、`git status`、未暂存与已暂存 diff、最近提交风格和精确文件列表。

- 只暂存任务文件，不夹带用户的无关改动。
- 一个提交表达一个可独立理解、审查和回滚的意图；实现、直接测试和必要合同文档保持完整。
- 提交信息使用英文 Conventional Commits：`<type>(<scope>): <imperative summary>`。
- 只有用户明确要求时才 commit、amend、rebase、push、创建 PR 或发布。
- 不跳过 hook、不强推、不改写共享历史、不修改 Git 配置，除非用户明确授权且影响已知。

## 10. 通用完成标准

- [ ] 原始需求和用户追加约束均已处理。
- [ ] 改动遵循当前真相源、架构责任和既有模式。
- [ ] 修改文件没有新增诊断错误，直接测试和适用最高验证层级通过。
- [ ] 代码交付的 Full Harness 已通过，或准确报告未运行原因与残余风险。
- [ ] 文档同步完成，或说明无需同步的理由。
- [ ] 最终 diff 不包含无关改动、凭据、个人配置、真实数据、临时文件或构建产物。
- [ ] Git 和外部操作没有超出用户授权。
- [ ] 交付说明包含完成范围、验证证据、未运行检查、公开行为/依赖/schema 影响和残余风险。
