# SciRetriever 重构与质量 Harness

> 本文件定义 pre-v1 大范围重构期间的工程验证方式。它的目的，是用少量明确门禁区分正在迁移的工作包和已经完成的集成里程碑，而不是强制每次修改都遵循稳定产品的小步开发流程。项目目标和架构真相源见 [AGENTS.md](AGENTS.md)。

## 1. 基本原则

- 重构工作包可以跨多个模块，可以删除或替换旧代码、旧测试和旧内部合同。
- 中间状态不要求全库始终可发布，也不要求每个工作包运行 Full Harness。
- 相关切片应使用最小有效检查获得反馈；完整严格检查集中在集成里程碑。
- 不通过保留已撤销架构、增加无意义兼容层或弱化最终测试来换取绿色结果。
- Harness 只执行机械检查，不解释业务语义，也不把架构审查编码成项目自有规则。
- 安全、凭据、用户数据、外部访问和不可逆操作不因重构阶段而放宽。

## 2. 三层验证

### 2.1 相关验证

开发循环优先运行与当前切片直接相关的测试或原生命令，例如：

~~~bash
uv run --frozen python -m unittest discover -s tests -p 'test_<name>.py'
uv run --frozen ruff check <paths>
uv run --frozen pyright <paths>
~~~

相关验证可以只覆盖当前拥有的文件和调用方。若切片尚未接入全局对象图，不需要伪造完整产品路径来满足旧测试。

### 2.2 Quick

~~~bash
uv run --frozen python scripts/harness.py quick
~~~

Quick 对全部活动 Python 文件执行：

1. Ruff lint；
2. Ruff format check；
3. compileall。

Quick 用于发现语法、文件可解析性和基本风格问题。它不执行 Pyright、全量 unittest 或 wheel 构建，因此不能证明集成完成。

### 2.3 Full

~~~bash
uv run --frozen python scripts/harness.py full
~~~

Full 执行：

1. Quick 的全部步骤；
2. Pyright strict；
3. 全部 unittest，并拒绝零测试；
4. 从清理后的 staging 构建 wheel；
5. 核对 wheel 中的 Python 模块与 src/sciretriever/ 一致。

Full 用于：

- 完成一个跨模块集成里程碑；
- 创建或更新 PR；
- 合并到 master；
- 发布或安装包级验收；
- 用户明确要求全库验证。

CI 中普通工作分支 push 只运行 Python 3.12 Quick；PR、master push 和手动运行在 Python 3.10、3.12 上运行 Full。

## 3. 活动代码范围

scripts/harness.py 为 Ruff、compileall 和 Pyright 生成同一份排序文件清单：

- 项目根目录已有的 *.py；
- src/sciretriever/**/*.py；
- tests/**/*.py；
- scripts/**/*.py。

归档、虚拟环境、构建目录、缓存、生成物和 vendored code 不进入这组检查。全量测试和 wheel 检查使用各自明确范围。

最低运行版本仍是 Python 3.10，开发基线是 Python 3.12。Ruff 和 Pyright 的原生配置位于 pyproject.toml；Full 的 strict 类型要求是集成目标，不要求未接线的中间工作包持续满足。

## 4. 重构期间的测试规则

- 新目标行为、重要失败边界和回归修复在对应能力完成时应有测试，但不强制采用 red-green-refactor 或固定测试命名模板。
- 只验证旧内部目录、旧类名、旧状态机或已撤销合同的测试可以更新或删除。
- 仍验证用户结果、数据完整性、网络安全、凭据安全、不可变发布或 Accepted 合同的测试不能为了通过而弱化。
- 可以先迁移 Model/Port、随后迁移调用方和测试；工作包需说明暂时未覆盖的集成路径。
- Mock 和 fake 用于隔离真实外部依赖。关键事务、组装和序列化合同在形成集成里程碑时必须由真实离线实现或有意义的集成测试证明。
- 测试、构建和 Harness 不得连接真实 Provider、生产数据库、真实凭据或用户语料。

## 5. 失败与交付语义

一个普通重构工作包可以在以下情况下交付：

- 当前负责的切片已经完成或达到明确中间边界；
- 相关验证已运行；
- 未通过的全库检查来自尚未迁移的其它路径，并被准确列出；
- 没有把中间状态描述为可发布或完整产品能力。

一个集成里程碑只有在以下条件成立时才算完成：

- 目标行为及直接调用方已经接线；
- 相关旧路径和临时桥接已经按计划清理；
- 必要测试与当前行为文档已经同步；
- Full Harness 通过；
- 最终 diff 没有凭据、真实数据、个人配置、临时文件或构建产物。

不要把失败转换为 warning、降低 Full 的严格级别或排除活动源码来虚构集成完成。中间工作允许报告失败；集成完成必须真正修复失败。

## 6. 文档同步

- requirements、ADR、design 和 technical 描述目标合同；只有合同变化时才修改。
- 内部移动、重命名和机械拆分无需逐文件改写架构文档。
- README 和用户指南只描述已经实现并验证的行为，在相应集成里程碑更新。
- docs/development/documentation-map.md 用于检查影响范围，不要求每个中间工作包同步所有列出的文档。
- 计划、临时差距和实施进度保留在 .omo/plans/，不进入产品真相源。

文档-only 任务不要求运行 Quick 或 Full；应检查相关链接、术语、Markdown 结构和 git diff --check。

## 7. 工作树、Git 与外部系统

- 默认工作树可能包含用户改动；只修改任务范围，禁止回滚或清理无关内容。
- 大范围重构可以拆成多个可理解的工作包或提交，不要求每个提交都可发布；PR/主分支边界必须满足集成条件。
- 只有用户明确要求时才执行 commit、amend、rebase、push、PR 或发布。
- 禁止破坏性 Git、读取或提交凭据、访问未授权生产数据和未经授权的外部写入。
- 临时文件使用系统临时目录；构建和测试产物在交付前检查，不提交 build/、dist/、缓存或用户数据。
- 依赖变更应服务当前目标实现并同步 uv.lock；不进行无关升级。

## 8. Harness 实现约束

- scripts/harness.py 定义实际步骤，pyproject.toml 定义 Ruff/Pyright 配置，.github/workflows/ci.yml 定义触发范围。
- Harness 直接传播原生工具的失败，不重新实现 Ruff、Pyright、Python、Pydantic 或业务语义。
- 测试发现必须报告实际数量，Full 发现零测试时失败。
- wheel 构建前清理自身 staging；若 build/ 或 dist/ 是符号链接则 fail closed，不能删除链接目标。
- wheel 内容检查防止已删除模块从缓存进入安装包。
- 更改 Quick/Full 步骤时同步本文件、AGENTS、Harness 直接测试、CI 和开发入口。

## 9. 交付说明

每次交付简要列出：

- 完成范围；
- 相关验证、Quick 和 Full 的运行结果；
- 未运行 Full 的原因；
- 尚未迁移或已知失败；
- 依赖、schema、公开行为或文档合同变化；
- 需要用户继续决定的事项。

Full 通过只表示配置的机械门禁和测试通过，不替代架构、安全或产品语义审查。
