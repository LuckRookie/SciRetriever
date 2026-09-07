# Browser Outcome-First 下载改造计划

## 1. 身份与状态

- Run ID：`browser-outcome-first-2026-09-07`
- 创建日期：2026-09-07
- Primary owner：`/root`
- 执行模式：`single-session`
- 当前状态：`Complete`
- 基线：现有通用 `browser:generic`、CloakBrowser 固定 Profile、Browser Agent 和 PDF identity 实现；保留工作树中的其它用户改动。

## 2. 目标观察

完成后，用户只需要理解三个对象：

1. 一个 Agent 在真实 Browser 中自由操作页面；
2. Browser 自动接收页面产生的下载结果；
3. SciRetriever 最终得到 `PDF_READY` 或带原因的失败。

页面的 response、download、viewer、blob、redirect 和暂时不可观察状态属于 Browser 内部实现，不作为上层流程的成功条件或失败条件。只要已经出现可读取的 PDF 候选，页面截图是否暂时可用不应丢失该候选。

## 3. 授权与真相源

- 用户已确认采用“最接近人工操作”的 Browser Agent 下载方式。
- 长期架构以 [ADR 0023](../../architecture/decisions/0023-generic-browser-agent-executor.md) 及其后续修订为准。
- PDF 文件、文章归属、不可变发布和 provenance 继续由 Acquisition/Storage 合同拥有。
- 本计划不新增站点规则，不新增 Agent 框架，不保存 Agent 会话，不改变配置或数据库 schema。

## 4. 已核实事实、假设与开放问题

### 已核实事实

- 真实 Browser 已经能启动并访问目标页面。
- 真实流程曾捕获到 `application/pdf`，随后因页面 snapshot settle runtime failure 丢失候选。
- 当前 response `download_expected` 分支会等待 native download 事件，response body 不会立即读取。
- 当前 BrowserStepSession 在检查 capture 状态前先生成 page snapshot。

### 设计假设

- Playwright response body、native download、viewer/blob 结果可以归一为同一个 Browser 内部 PDF candidate。
- Agent 不需要知道 candidate 的来源，只需在没有最终 PDF 时继续探索。
- 候选读取失败可以局部丢弃并让 Agent 继续；最终 PDF 验收仍由 Acquisition 完成。

### 开放问题

- 不同 CloakBrowser 版本对 response body 和 native download 的事件顺序可能不同；通过多通道 candidate 适配和离线 fixture 覆盖，不在主流程增加事件配对假设。
- 页面长期不可观察时仍需有界超时和清理；该边界不改变“候选优先”的流程。

## 5. 范围与非目标

### 本次范围

- 引入统一的 operation-local PDF candidate 生命周期。
- response、download、viewer/blob 进入同一候选读取与验证路径。
- 候选等待、body 读取和最终验证独立于 Agent snapshot。
- 页面暂时不可观察时重试或等待，不删除仍在读取的候选。
- 为 response-only、download-only、双事件、延迟事件、页面过渡和错误候选补充直接测试。

### 明确非目标

- 不允许 Agent 获取任意 URL、脚本、凭据、Page/CDP 或文件系统能力。
- 不恢复 Publisher-specific selector、固定点击顺序或站点下载规则。
- 不引入 LangGraph/PydanticAI 状态图替代当前一次调用 Agent runtime。
- 不改变 Literature、Asset、primary-pdf、provenance 或配置合同。

## 6. 全局验收条件

- [x] Agent 只在需要探索时获取页面观察；已有 PDF candidate 不强制触发 snapshot。
- [x] 任何已支持的 Browser 下载表现都能进入统一 candidate 路径；native download 缺失不再让 response-only PDF 永久 pending。
- [x] 错误 candidate 不会发布，也不会阻断后续探索；有效 PDF 经过现有 PDF/文章归属门后发布。
- [x] Browser runtime 暂时不可观察时不会丢弃仍在读取的 candidate；真正的 runtime/timeout/cleanup failure 仍有稳定结果。
- [x] 直接测试、Quick、Full 和一次受控真实复测形成证据闭环。

## 7. 分块地图

| Block | 结果 | 主要文件/模块 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| 01 | 统一 candidate 读取和完成语义 | `network/browser.py`、`network/playwright.py`、相关测试 | 无 | `Complete` |
| 02 | Agent 与 candidate 捕获解耦 | `network/browser.py`、`acquisition/browser_control.py`、相关测试 | 01 | `Complete` |
| 03 | 文档、ADR 与回归证据同步 | ADR/technical/guides、相关测试 | 01–02 | `Complete` |
| 04 | Quick/Full 与真实复测交接 | Harness、现场证据、计划 | 01–03 | `Complete` |

## 8. 跨块合同

- Agent 只产生页面动作；Agent 的自然语言或 Stop 不代表 PDF 成功。
- Browser 只负责执行页面、收集候选和报告最终文件读取事实。
- Acquisition 继续负责 PDF 字节门、文章归属门和不可变发布。
- candidate 只存在于当前 operation，不进入数据库和公共业务结果。
- 上层成功结果只有有效 PDF；失败结果必须指出阶段和可重试性。

## 9. 影响矩阵

| 方面 | 预期变化 | 结论 |
| --- | --- | --- |
| 模块边界 | Browser 内部统一多通道 capture，Agent 不拥有 capture 状态机 | 局部重构 |
| 公共接口 | 保留现有 BrowserFlowSession/Acquisition 结果形状，收敛内部 transition 顺序 | 需测试复核 |
| 配置 | 不变 | 无迁移 |
| 数据/schema | 不变，candidate 不持久化 | 无迁移 |
| 依赖 | 不新增 | 无依赖变化 |
| 文档 | 修订 ADR 0023、Network/Acquisition 当前行为和现场计划 | 必须同步 |

## 10. 风险与转化信号

- 候选读取并行增加资源生命周期复杂度：保持单篇有界 candidate 数量和读取预算。
- Agent 可能重复点击：保留当前操作次数、超时和重复动作熔断。
- 外部站点拒绝访问：记录为站点/权限失败，不让程序将其伪装成 PDF 成功。
- 若 response/download/viewer 仍无法在同一个 candidate 合同下表达，才重新评估是否需要更大架构变化。

## 11. 验证与证据策略

1. 先补 response-only PDF 在无 native download 时的离线回归。
2. 再补 candidate pending 时 snapshot 不被调用或不阻断的 Browser 控制回归。
3. 运行 Browser/Network/Acquisition/Agents 相关测试、Quick 和 Full。
4. 以同一篇 Literature 做一次真实 Browser+Agent 复测，只记录脱敏摘要。

## 12. 授权门

- 源码、测试和文档修改：用户已授权。
- 真实 Provider/Browser 访问：用户已明确授权本轮真实测试；现场复测仍只使用单篇目标。
- Git commit/push/release：未授权，本计划不执行。

## 13. 最终验证证据

### 离线质量门禁

2026-09-07 已运行：

```bash
uv run --frozen python scripts/harness.py full
```

结果：Ruff lint、Ruff format check、compileall、Pyright strict、全量 unittest、wheel 构建和 wheel 内容核对全部通过。

### 真实 Browser + Agent 复测

目标 Literature：`b16c1886-1917-4834-a051-1e9e4a5e9544`。

脱敏运行目录：`/tmp/sciretriever-browser-outcome.jdSwg9`。

已观察到的事实：

- CloakBrowser 使用既有 `institutional-access` Profile 正常启动；
- Agent 收到真实截图并执行了 `click-element`、`click-point`、`wait-for-change`；
- 页面经历文章页、Cloudflare challenge、文章页之间的真实变化，未因页面暂时变化直接触发 readiness failure；
- 所有 Agent 请求均使用配置的 `qiuzk / gpt-5.6-luna`，流式 Responses 正常完成，偶发 `agent-remote-service` 按既定上限重试；
- 本次没有观察到 `media-type=application/pdf`、可读取的 PDF response body、native download 或 capture；
- 最终 PDF 按钮点击触发页面级 `GET`，服务器返回 HTTP `403`，随后动作 settle 超时；
- 任务最终以 `controller-safety-limit` 结束，清理成功，未发布错误资产。

因此，本次真实复测证明了“Agent 自主操作 + Browser 观察/收集 + Acquisition 最终验收”的交互链路已按设计运行，但不能证明该具体 ChemRxiv 会话在当前网络、Profile 和站点验证状态下能够取得 PDF。失败归因是目标站点的人机验证/访问响应与 Agent 服务稳定性共同导致的外部现场结果；代码没有把非 PDF 响应当成成功，也没有发布无效文件。

## 14. 执行与审查

Primary owner 串行完成 Blocks 01–04。每个 Block 按“最小切片 → 直接测试 → diff/合同审查 → 块级测试 → 交接”执行。任何 finding 改变公共接口、数据持久化、模块所有权或授权范围时，停止并更新本计划后再继续。

## 15. 进度、恢复与交接

- 只有实现、直接测试和必要文档同时闭环，才能勾选 Task/Block。
- 失败时从最近通过的直接测试或 Full 子步骤恢复，不回滚用户改动。
- 真实日志、截图、PDF 和凭据只保留在系统临时目录，不复制到计划目录。

## 16. 变更记录

| 日期 | 变化 | 原因 |
| --- | --- | --- |
| 2026-09-07 | 创建 outcome-first Browser 下载计划 | 现场验证显示 response 已捕获 PDF 候选，但 snapshot 失败导致候选丢失；用户确认采用最接近人工的单 Agent + Browser 方案 |
| 2026-09-07 | 完成 candidate 与 Agent 解耦 | response 保存资源并可直接读取；候选超时恢复可执行 Ready；Stop 不再因 pending candidate 的临时 snapshot 失败而 stale；补充 capture/snapshot race 回归 |
| 2026-09-07 | 完成离线门禁与真实单篇复测 | Full 全部通过；真实 Browser + Agent 能观察和操作挑战页面，但目标站点最终返回 403，未产生可验证 PDF；记录为外部现场失败，不伪装成代码成功 |
