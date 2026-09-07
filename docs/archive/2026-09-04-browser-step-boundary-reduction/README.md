# Browser Step 边界收敛计划

## 身份与状态

| 字段 | 值 |
| --- | --- |
| Run ID | `BROWSER-STEP-BOUNDARY-20260904` |
| 创建日期 | 2026-09-04 |
| Primary owner | Codex `/root` |
| Baseline revision | `4ea15d51a46cf4f6c9c586fd7ad228fda4086a57`；其上的现有未提交改动全部视为受保护工作 |
| 执行模式 | cross-session；单一 Primary owner；串行实施；未授权并行执行 |
| 当前状态 | Completed and archived — 2026-09-04 |

## 目标观察

完成后，Acquisition 和 Agent 不再共同编排 Browser 的加载、页面替换、quiet window、Candidate 和
capture 生命周期。它们只面对一项原子 Browser step：给定当前稳定 `Ready` observation，提交一个封闭
动作，Browser 自己等待并收敛为下一项稳定结果。

```text
step = browser.start(article_policy)

while step is Ready:
    action = agent.decide(step.observation)
    step = browser.apply(action)               # 验证、执行、等待、重新观察一次完成

return Captured | Blocked | Failed | Cancelled
```

用户可观察到的结果是：Agent 只看到已经稳定且仍可操作的界面；每次模型决定最多触发一次 Browser
边界调用；页面加载、frame/page replacement、PDF Candidate 和异步下载不会被上层当成需要猜测的
中间状态；失败能够说明是页面自然阻断、用户取消还是 Browser 系统失败。

## 授权与真相源

用户在指出现有 Agent–Browser 交互臃肿、偏离主线后，认可“让 Agent 操作稳定界面、由 Browser
原子收敛动作结果”的方向，并于 2026-09-04 明确要求写计划后实施。授权覆盖本计划的内部合同、源码、
直接测试、架构与当前行为文档以及离线 Harness；不包含 Git commit/push、发布、用户数据修改或新的
真实 Provider/Publisher 请求。

适用真相源：

- [产品需求 R3](../../architecture/requirements.md) 的受控 Browser、固定 controller 和 PDF 验收边界；
- [ADR 0017](../../architecture/decisions/0017-shared-agents-and-controlled-browser-agent.md) 的共享 Agents、
  统一 Observation、封闭动作、capture 与安全限制；
- [架构设计](../../architecture/design.md) 的 Acquisition/Network/Storage 责任；
- [Acquisition 技术文档](../../architecture/technical/acquisition.md)与
  [Network 技术文档](../../architecture/technical/network.md)；
- [HARNESS](../../../HARNESS.md) 的开发、安全、验证和 Git 纪律；
- 已归档的 [Browser Observation readiness](../../archive/2026-09-03-browser-observation-readiness/README.md)、
  [Capture handoff](../../archive/2026-09-04-browser-capture-handoff/README.md)实施证据。

计划不得改变这些边界：Publisher origin/DNS/host guard、固定 Profile 与串行 lane、PDF 文章归属和字节
验收、不可变资产发布、Agent 能力封闭、Public → Authorized API → Browser 顺序。

## 事实、假设与开放问题

### 已核实事实

- 当前生产主循环实际是 `observe -> settle -> model -> settle -> execute -> settle -> reclassify`；一次模型
  决策前后需要上层多次理解 Network transition。
- `network.browser_control` 向调用方公开 `STALE / SETTLED / CAPTURED / CANDIDATE_TIMEOUT /
  STOPPED / CANCELLED / FAILED` 七种 transition；Acquisition 再转换为八种 disposition 和五种 terminal
  cause。
- `_PublisherAgentControl` 必须在 Acquisition 中重新分类 Network transition，包含
  `_reclassify_generic_snapshot_failure()`；这证明 Browser 的瞬态生命周期已经泄漏到调用方。
- Network 已拥有 screenshot、action binding、vendor dispatch、page replacement、quiet window、capture
  Candidate、timeout、cancel 和 cleanup 所需事实，能够成为原子 step 的唯一 owner。
- Agent 只需要在稳定 Observation 上选择六种封闭动作；Rules 还拥有经过代码审查的 selector/locator
  能力。二者共用 Network 的导航、capture、timeout、cancel 与 cleanup 引擎，但不应伪装成同一种权限。

### 实施后确认

- `Ready / Captured / Blocked / Failed / Cancelled` 足以覆盖跨出 Browser 的长期结果；stale、candidate、
  receipt 和 page replacement 可以保留为 Network 私有诊断而不损失 Acquisition 的业务判断。
- Publisher 页面分类可作为 operation-local policy 注入 Network step session；Network 只执行 policy，
  不获得 DOI/Publisher 业务知识。
- `Stop` 可以在 chooser 层形成 `Blocked`，无需继续伪装成 vendor action；若保留为封闭动作，其收敛也只
  在 Browser 内发生一次。

### 开放问题与方向改变门

- 若某项 Publisher 规则确实必须消费 vendor object、未稳定 DOM 或完整含 query URL，停止并回到设计，
  不扩大边界。
- 若五类结果无法表达现有用户可见失败，先用直接测试证明缺失语义；不得恢复 transient transition。
- Rules 保留有限且经过审查的 selector/locator 程序；若要强行改写成 Agent action 会扩大 Agent 权限或
  丢失规则语义，则不做形式统一。Rules 不得复制 Network 的 capture/cancel/cleanup 生命周期。

## 范围与非目标

### 范围

- 定义并实现 Browser 原子 `start/apply` step 合同；
- 把 readiness、stale retry、page/frame replacement、Candidate/capture 等待收回 Network；
- 将 Publisher page/capture policy 在 session 创建时注入，删除 Acquisition 的 transition 事后重分类；
- Agent 使用唯一的稳定 step engine；Rules 与 Agent 共享 Network 的 Browser flow、capture、timeout、
  cancel 和 cleanup owner，但保留权限不同的控制面；
- 收敛 Browser controller 的终态映射、失败和日志；
- 删除已经没有生产调用方的旧 Transition/Disposition 桥接类型和机械测试；
- 同步 R3、ADR 0017、Acquisition/Network/Agents 技术文档与 PDF 获取指南。

### 非目标

- 不修改 Model registry、reasoning、stream、128K role budget 或 Provider adapter；
- 不新增 Browser 动作、任意导航、selector/script/text-entry、登录、MFA 或 Challenge 专属工具；
- 不放宽 Publisher origin、destination、DNS、host、resource、article identity 或 PDF byte guard；
- 不改变配置 schema、Catalog/schema、资产路径、provenance、lineage 或发布事务；
- 不顺手适配新 Publisher，不引入新依赖，不以固定 LOC 数量作为验收门禁；
- 不把真实站点成功率当作离线合同完成的替代品。

## 全局验收条件

- [x] **AC-1：单一原子边界。** Acquisition 的生产 controller 每次只调用 `start()` 或 `apply(action)`，
  不再直接调用 `observe()`、`settle()`、`execute()` 或解释 stale/candidate/page replacement。
- [x] **AC-2：稳定 Observation。** `Ready` 只在页面达到现有 quiet/readiness 条件、没有未决 capture
  Candidate 且没有已捕获 PDF 时返回；Agent 不接收加载中或下载后的空白界面。
- [x] **AC-3：动作原子收敛。** 一个封闭动作由 Browser 完成 binding 校验、vendor dispatch、异步等待和
  下一稳定结果；stale action 在 vendor dispatch 前安全重取稳定 `Ready`，不越界成为上层 transition。
- [x] **AC-4：自然终态准确。** login、MFA、not entitled、access denied、not found、Agent stop、
  no-progress 和 capture timeout 保留可解释的 `Blocked` reason；系统/策略/runtime/cleanup 错误为
  `Failed`，用户取消为 `Cancelled`。
- [x] **AC-5：Capture 与安全不回退。** 初始直接 capture、Challenge 后异步 capture、page replacement、
  Candidate timeout、destination failure、cancel/cleanup 与错误文章反例全部通过，正文读取和发布时机不变。
- [x] **AC-6：共享 Network owner。** Agent 只使用稳定 session step 生命周期；Rules 的受审 selector/
  locator 程序与 Agent 的封闭动作保持权限隔离，二者都不复制 Network 的 capture、timeout、cancel 或
  cleanup 生命周期。Agent 只增加模型 chooser 和 32-call safety fuse，不拥有 Browser settle 状态。
- [x] **AC-7：旧状态机退出。** 生产调用图中不存在七类 transition + Acquisition reclassification 的双层
  组合，也不存在长期兼容 adapter；删除无调用方代码与相应机械测试。
- [x] **AC-8：验证与文档闭环。** 相关测试、Quick、Full、wheel 核对、最终 diff/安全审查通过；目标文档
  和当前行为文档与唯一生产对象图一致。

## 分块地图

| 顺序 | Block | 可验证结果 | 主要 owner/文件 | 前置 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | [Step 合同与行为基线](01-step-contract.md) | 五类结果与关键时序由直接测试冻结 | `network/browser_control.py`、Browser tests | 计划获准 | Completed |
| 2 | [Network 原子 Step Engine](02-network-engine.md) | 瞬态生命周期只存在 Network 内部 | `network/browser.py`、`network/browser_control.py` | Block 1 | Completed |
| 3 | [Acquisition 与 Controllers 收敛](03-acquisition-and-controllers.md) | 删除重分类，Rules/Agent 共用 engine | `acquisition/browser_control.py`、`sources/browser.py` | Block 2 | Completed |
| 4 | [验证、文档与交接](04-verification-and-docs.md) | 对象图、Full、文档和残余风险闭环 | tests、architecture/current docs | Blocks 1-3 | Completed |

主依赖为 `1 -> 2 -> 3 -> 4`。在新合同尚未通过直接测试前不并行实现，避免同时维护两套未稳定接口。

## 跨块合同

- `BrowserObservation` 仍是不可序列化、article-local、query-free、截图绑定的中性快照；
- `BrowserAction` 仍携带 article/page/surface/revision/screenshot 等精确执行绑定，stale 时不得 dispatch；
- Browser step policy 只接受 Acquisition 注入的 operation-local中性 Protocol，Network 不解释 DOI、
  Publisher、entitlement 或主文业务；
- `Ready` 是唯一可提交下一动作的结果；其它四类均为当前 Browser session 的终态；
- capture Candidate、quiet fingerprint、vendor receipt、page successor、callback 和 retry 不跨出 Network；
- `Blocked` 只表达已安全收敛的业务/页面自然阻断，不吞系统错误；payload-free reason 是稳定词条；
- 已接纳 PDF 仍经 Acquisition 二次归属/字节验收后才发布，后续失败不得撤销事实；
- 不序列化 step session/result，不新增配置、数据库或跨命令恢复状态。

## 影响矩阵

| 面向 | 预期影响 | 保持不变 |
| --- | --- | --- |
| 内部接口 | Browser control 改为 `start/apply` 与五类 step result | 一次性切换，不保留双协议 |
| Network | 成为 readiness、动作 settlement 和瞬态生命周期 owner | transport/destination/DNS/host/capture guard |
| Acquisition | 只注入 policy、选择动作并解释稳定终态 | Publisher/文章语义、PDF 二次验收 |
| Agents | Browser chooser 消费 `Ready.observation` | Runtime、Provider、prompt 安全和 128K budget |
| Rules | 复用同一 Network Browser flow 与 capture/cleanup owner | 版本化受审 selector/locator 权限，不扩大 Agent action |
| 配置/CLI | 无 schema/命令变化 | Browser controller 与 Model 选择语义 |
| 数据/资产 | 无 schema、格式或迁移 | immutable publication、provenance、lineage |
| 依赖/打包 | 无新增依赖 | `pyproject.toml`、`uv.lock`、wheel 范围 |
| 文档 | 收敛 R3/ADR/technical 中泄漏的 transient 细节 | 产品边界与安全约束 |

## 风险与转化信号

| 风险 | 观察信号 | 处理 |
| --- | --- | --- |
| 原子调用内部无限等待 | step 没有 action/capture deadline | blocking；恢复现有有界 timeout |
| stale 被误当成重放许可 | 同一旧动作在新 revision 上自动 dispatch | blocking；只返回新 `Ready`，由 chooser 重新决定 |
| `Blocked` 吞掉系统错误 | runtime/policy/cleanup failure 被记为自然未命中 | blocking；回到结果分类测试 |
| Network 获得 Publisher 业务 | Network 出现 DOI、站点名、selector 或 entitlement 分支 | material；移回注入 policy |
| Rules 复制 Network 生命周期 | Rules 自行实现 transport/candidate/cancel/cleanup 状态 | material；收回 Network，不扩大 Agent action |
| 为删类型而丢诊断 | 用户结果不再说明具体自然阻断 | 补稳定 reason，不恢复 transient 类型 |
| 改动碰撞现有工作 | diff 覆盖计划前已有修改 | 停止当前切片，重新对照受保护 diff |

## 验证与证据策略

按成本与风险逐层进行：

1. 每个切片运行精确 `unittest`，断言模型调用、vendor action、body read、capture、cleanup 与结果类型；
2. 运行 Network、Acquisition、Agent Browser、Cloak/Playwright fake/local fixture 相关测试；
3. 运行目标 Ruff/Pyright，再运行 Quick；
4. 更新生产对象图与文档后运行 Full，核对 wheel 内容；
5. 运行 `git diff --check`、secret/个人路径/临时产物扫描和最终语义 review；
6. 真实 Publisher 矩阵仅在离线闭环后、沿用既有明确授权与安全执行方式时进行；本计划默认不新增外部请求。

证据写入各 Block 的“完成证据”，不得用计划复选框替代命令输出。

## 授权门

- 源码、测试和仓库文档：已授权；
- 离线 fixture、Quick、Full、wheel：已授权；
- 真实只读 Publisher/Model 回归：本计划不自动执行；若确需重跑，先核对既有授权范围和精确目标；
- 用户配置、Browser Profile、真实 Catalog、文献资产：不得读取、修改或删除；
- Git commit/amend/rebase/push、PR、发布：未授权；
- 依赖升级、公开配置/schema/数据迁移、安全边界放宽：超出范围，必须另行决定。

## 执行方式与审查

Primary owner 串行执行。每个 Task 遵循：核对调用方与受保护 diff → 实现一个完整切片 → 直接测试 →
审查接口、错误与安全边界 → 记录证据。Block 进入时检查前置合同；退出时检查生产调用图而不只看测试。
发现 blocking 项返回当前 Block；发现需要改变 Accepted ADR 核心安全边界、配置/schema 或外部权限时停止
并交由用户决定。

Task 只有在实现、直接测试和必要文档同时成立时才勾选；Block 只有全部 Task 和退出审查通过才标记
Completed；Plan 只有 AC-1 至 AC-8、Full 和最终交接全部闭环后才标记 Completed。

## 恢复与续作协议

跨会话继续时依次读取本 README、当前 Block、`git status --short`、目标文件 diff 和最近一次测试输出。
最近恢复点记录在对应 Block。测试失败时保留失败事实，从首个未完成 Task 继续；不得 reset、checkout 或
通过恢复旧兼容接口绕开失败。若上下文不足，先把新事实写回计划再修改实现。

## 变更记录与最终交接

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-09-04 | 创建计划，进入 Block 1 | 用户认可原子稳定 step 方向并授权实施 |
| 2026-09-04 | 收敛 Rules/Agent 的共享边界 | 实施确认受审 selector/locator 与 Agent action 权限不同；共享 Network 生命周期而非伪造相同动作 API |
| 2026-09-04 | 完成实现、Full 验收并归档 | 唯一 `start/apply` 对象图、五类稳定结果、文档和离线门禁全部闭环 |

最终交接事实：Network 现在独占 readiness、stale、page replacement、Candidate/capture、timeout、cancel
和 runtime failure 的收敛；Acquisition 只注入 Publisher policy、调用 Agent chooser 并映射稳定终态。Focused
Browser 测试与 `scripts/harness.py full` 均通过，wheel 内容一致，`git diff --check` 通过。没有新增依赖、
配置/schema 或数据迁移；没有执行真实 Publisher/Model 请求，也没有读取用户凭据、Profile、Catalog、PDF
或截图。真实站点行为仍会随 Publisher 页面和 entitlement 变化，只能在另行明确授权的小样本回归中验证。
