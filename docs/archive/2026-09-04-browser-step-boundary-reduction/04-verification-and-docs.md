# Block 4：验证、文档与交接

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | BSB18–BSB23 |
| 前置块 | Blocks 1–3 Completed |
| 下游块 | 无；完成后归档或按 finding 返回对应 Block |
| 恢复点 | BSB18–BSB23 已完成；Full、文档、归档与交接闭环 |

## 块结果

证明唯一 step engine 在生产组装、离线 runtime/capture 矩阵、完整 Harness 与安装包中成立，并同步长期
合同和当前用户行为。最终交接准确说明真实 Publisher 未重跑时的残余风险。

## 进入条件

- Blocks 1–3 的 Tasks、直接测试和退出 review 通过；
- 生产调用图只有一套 start/apply engine；
- 旧 transient/reclassification 无生产调用方；
- 工作树没有凭据、Profile、PDF、Catalog、截图或构建产物。

## 责任与改动面

- Owner：Primary Agent；
- 主要文件：Bootstrap/acceptance tests、ADR 0017、requirements R3、architecture design、Acquisition/
  Network/Agents technical、PDF acquisition guide、本计划证据；
- 验证对象：Network、Acquisition、Rules/Agent、Bootstrap、Entry Report、capture/PDF publication；
- 受保护：其它累计工作、真实配置/凭据/Profile/Catalog、Harness/CI 定义。

## 需要保持的行为

- 测试与 Harness 全部离线，不读取真实配置；
- 文档只把已经实现且验证的行为写成当前事实；
- Full 失败不通过删测、降级类型或排除活动文件解决；
- 真实站点若未重跑，不声称所有 Publisher 已通过新实现。

## Tasks

- [x] **BSB18 — 完成跨模块对象图矩阵。** 使用 production-shaped fake 组合验证初始 capture、Challenge
  动作 capture、page replacement、terminal、candidate timeout、destination failure、cancel/cleanup。
  - 验收：不预先绕过 policy；断言 step、模型/vendor 次数、capture 与最终 report。
- [x] **BSB19 — 完成本地 Browser runtime 回归。** 运行 Playwright/CloakBrowser 本地 fixture 覆盖共享
  Profile 等价生命周期和异步 response/download。
  - 验收：稳定 Ready 才调用 chooser；capture 优先；错误资源不读取正文。
- [x] **BSB20 — 清理旧代码与测试。** 删除无调用方 transition/disposition/reclassification、旧注释和只证明
  旧机械层的 fixtures；检查模块导出和 wheel 内容。
  - 验收：`rg`/类型检查证明无死引用；有效安全与用户结果测试没有弱化。
- [x] **BSB21 — 同步真相源和当前文档。** amendment ADR 0017，修正 R3 中实现细节泄漏，更新 design、
  technical 和 PDF 获取指南。
  - 验收：产品写结果，ADR 写选择，technical 写唯一对象图，guide 写已实现行为；术语一致。
- [x] **BSB22 — 运行完整门禁与最终 Review。** 相关测试 → 目标 Ruff/Pyright → Quick → Full → wheel →
  `git diff --check` → 安全/范围/语义审查。
  - 验收：Full 退出码 0；无凭据、真实数据、临时产物、无关格式化或双状态机。
- [x] **BSB23 — 形成最终交接。** 汇总完成范围、验证、未运行项、合同影响和真实 Publisher 残余风险，
  将完成计划归档。
  - 验收：不执行未授权 Git/发布；计划状态、证据和归档位置一致。

## 执行方式与集成点

顺序为生产对象图 → 本地 runtime → dead-code 清理 → 文档 → Full/review → 交接归档。若验证产生与合同
相反的事实，返回对应 Block 修正并重新走后续验证，不在 Block 4 增加站点补丁。

## 审查门

- 进入：前置 Blocks 真正通过而非仅勾选；
- 切片：对象图、文档和测试分别检查 owner 与用户结果；
- 退出：AC-1 至 AC-8、Full、wheel 和最终安全审查全部通过；
- 阻断：真实数据进入测试、旧/新 engine 并存、文档超前、Full 非绿。

## 接口、数据与依赖影响

- 内部接口与对象图：记录最终 start/apply contract 和删除项；
- 公开 CLI/config/schema/数据格式：预期无变化，若实际变化必须停止并重新授权；
- 依赖：预期无变化；
- 文档与打包：同步并由 Full/wheel 验证。

## 验证与证据

```bash
uv run --frozen python -m unittest discover -s tests -p 'test_*browser*.py'
uv run --frozen python scripts/harness.py quick
uv run --frozen python scripts/harness.py full
git diff --check
```

最终命令按实际测试文件补充，完整输出摘要写入完成证据。真实 Publisher 运行不是 Full 的组成部分。

## 退出条件

- BSB18–BSB23 完成；
- 全局 AC-1 至 AC-8 全部有源码/测试/文档证据；
- Full 与最终 review 通过；
- 残余风险、外部未运行项和 Git 状态准确交接；
- 活动计划移入 `docs/archive/` 并更新状态为 Completed and archived。

## 完成证据

- Focused Browser/Acquisition/Bootstrap/Entry 测试全部通过；目标 Pyright 为 `0 errors, 0 warnings,
  0 informations`，Quick 通过。
- `uv run --frozen python scripts/harness.py full` 于 2026-09-04 退出码 0：Ruff lint、Ruff format、
  `compileall`、Pyright strict、全量 unittest、wheel 构建和 wheel 内容核对全部通过。
- `git diff --check` 退出码 0；当前行为文档不存在旧 `BrowserControlSession`、Disposition 或 terminal cause
  描述；公开导出不含 transition/driver/ledger。
- 工作区改动只涉及受保护的累计源码、测试和文档；没有跟踪凭据、个人配置、PDF、截图、Catalog、
  Browser Profile、`build/` 或 `dist/`。Harness 生成物均为已忽略内容。
- 未运行真实 Publisher/Model 回归和需要显式 opt-in 的本地真实 CloakBrowser fixture；这是安全边界，
  不影响离线合同完成，但真实站点适配仍保留外部变化风险。

## 失败与恢复

直接或 Full 失败时回到最小相关 Block，记录失败命令与事实后修复；不得仅更新计划状态。真实 Publisher
若在既有授权下复测失败，保留脱敏证据并判断是实现回归、站点事实变化还是适配缺口，再决定是否重开
本计划；不在交付前反复外部试错。

## 下游交接

无。最终用户交接只依赖已通过的唯一对象图、验证证据和明确残余风险，不依赖活动计划中的推测。
