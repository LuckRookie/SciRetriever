# M2–M3｜Browser 工作区与自动获取闭环

## 结果

本文件承接原始 T019–T036。M2 先交付纯人工可用的工作区；M3 再接入冻结策略、Agent 观察—动作循环、受限 PDF 检查、身份/版本裁决、Candidate 发布、分层诊断和统一 Acquisition 编排。当前纯人工 Browser 闭环已完成，自动获取的全量验收仍未关闭。

表中的 `03-01`–`03-08` 和 `03-W1`–`03-W5` 是 Browser 实现切片编号；它们不替代原始 T019–T036。复杂捕获、自动获取、无人打扰批次和统一 Acquisition 的缺口仍必须按 T027–T036 关闭。

## 后端任务

| ID | 任务 | 交付物 | 验收 | 状态与证据 / 剩余工作 |
| --- | --- | --- | --- | --- |
| 03-01 | BrowserHost/Session | 单 Host、单 Profile、单活动页面 | 生命周期、关闭、Profile 重开和 page identity 可测试 | 已实现受支持边界；[目标 CloakBrowser 有头/固定身份/代理记录](../../../migration/evidence/browser-acquisition/cloak-workbench-runtime.md)、真实 session 组装、双 viewer/390px、受控 Literature 目标切换、多标签页/`boot_id` 和[业务联合旅程](../../../migration/evidence/runtime/product-loopback-journey.md)通过；[lifecycle 矩阵](../../../migration/evidence/browser-acquisition/browser-lifecycle-matrix.md)覆盖 profile lock/page close，宿主 SIGKILL 后 Browser 重建 Deferred |
| 03-02 | Observation | 有界 DOM/text 摘要、loading/partial、版本字段 | 不使用 `networkidle`；页面代次变化可识别 | 已实现；[Observation 记录](../../../migration/evidence/browser-acquisition/browser-observation.md)覆盖实际 DOM/文本/元素采集、同 URL 导航代次、共享 session/frame DTO 与稳定页面 revision |
| 03-03 | Action Executor | ADR 0023 六种 Agent 动作；独立的人工输入合同 | Agent 不获得 type/key 权限；人工输入须持有当前 operator 控制权；未知动作及任意 URL/selector/script/file input 在 Browser 调用前拒绝 | 已实现当前动作边界；[六种动作实现](../../../apps/server/src/browser/control.ts)与[AgentRuntime 决策组装](../../../migration/evidence/browser-acquisition/browser-agent-runtime.md)已接真实 Application binding；stale/type-text/角色/任意 URL 负例在 contracts、control、session、HTTP 和 Browser Host 测试中覆盖 |
| 03-04 | Control | viewer/operator/agent 和 takeover/release | 只有一个控制者；旧 epoch 和迟到结果零执行 | 已实现；[控制权记录](../../../migration/evidence/browser-acquisition/browser-control.md)与[生命周期矩阵](../../../migration/evidence/browser-acquisition/browser-lifecycle-matrix.md)覆盖 Web 接管/释放、旧 epoch 和迟到 Agent |
| 03-05 | Screen/Event stream | 最新帧、事件、断线恢复 | 慢客户端丢旧帧，不阻塞 Browser；frame 带 page/viewport/seq | 已实现当前传输边界；[会话/API 证据](../../../migration/evidence/browser-acquisition/workbench-session-api.md)与[lifecycle 矩阵](../../../migration/evidence/browser-acquisition/browser-lifecycle-matrix.md)覆盖最新帧、SSE 初次/断线/重连、背压保护；大规模压力基准 Deferred |
| 03-06 | Transfer pipeline | admission → receiving → staged → durable-ready | navigation/redirect/response/download 归属当前 session，有界字节和 deadline | 已实现核心 pipeline；[Transfer 记录](../../../migration/evidence/browser-acquisition/browser-transfer.md)和 Browser/Candidate 旅程覆盖 navigation/redirect/response/download、页面关闭、文章隔离、有界字节和 deadline；blob/data/popup 首次下载补充在[捕获矩阵](../../../migration/evidence/browser-acquisition/browser-capture-matrix.md)中；更细用户进度文案 Deferred |
| 03-07 | PDF/verdict | 结构检查、有限文本证据、identity/version verdict | 合法 fixture 接受；损坏、超限、身份不确定明确分类 | 已实现；[PDF 记录](../../../migration/evidence/browser-acquisition/pdf-acceptance.md)、[verdict 记录](../../../migration/evidence/browser-acquisition/identity-verdict.md)与真实 Browser Candidate 旅程覆盖 accepted/uncertain/rejected |
| 03-08 | Candidate publication | Candidate + hash + receipt | 页面关闭后仍可读；重复 receipt 幂等 | 已实现；[业务接纳与 Web 证据](../../../migration/evidence/browser-acquisition/candidate-acceptance.md)及[Candidate 回收证据](../../../migration/evidence/runtime/candidate-abandonment.md)覆盖发布、放弃、重启列表/receipt、待处理候选再发布和字节去重 |

## 前端任务

| ID | 任务 | 交付物 | 验收 | 状态与证据 / 剩余工作 |
| --- | --- | --- | --- | --- |
| 03-W1 | 工作台壳 | `apps/web` 路由、会话连接、布局 | 桌面三栏、窄屏底部抽屉，390px 无横向溢出 | 已实现当前切片；[源码样本](../../../apps/web/README.md)和真实目标 Cloak 390px 旅程通过，安装包静态资产由[独立证据](../../../migration/evidence/runtime/installed-web-assets.md)验证 |
| 03-W2 | 画面与观察面板 | screen/event 消费组件 | 显示 loading、partial、frame 跳跃和最新状态 | 已实现当前切片；live 页面消费真实 JPEG、Observation、capture 状态、SSE 最新投影和断线提示，缺少的大规模压力不属于支持声明 |
| 03-W3 | 控制与输入 | 接管、释放、鼠标、滚轮、键盘 | 控制权明确；过期输入展示原因 | 已实现当前输入边界；live 页面接人工输入与服务端协议，旧 observation/epoch、viewer、Agent type/key 和网络错误均有直接负例；`type-text` 继续使用 `insertText`，避免按键与 composition 重复 |
| 03-W4 | Candidate 面板 | 捕获进度、verdict、发布/放弃 | uncertain、rejected、needs-assistance 有具体下一步 | 已实现当前切片；live 页面已接 Candidate 发布/放弃、控制权取消和重启列表/receipt，并通过 Observation 显示接收中/Captured 状态；更细的失败分类仍由后续 Provider/页面状态扩展 |
| 03-W5 | 错误与可访问性 | aria、焦点、通知、断线恢复 | 键盘可操作；不以颜色作为唯一状态；secret 不进前端 | 已实现当前切片；[样本直接测试](../../../apps/web/test/browser-workbench.test.ts)、真实 Cloak UI 旅程及[SSE/lifecycle 矩阵](../../../migration/evidence/browser-acquisition/browser-lifecycle-matrix.md)覆盖键盘、焦点、错误、断线重连和 secret 边界 |

前端保留 4173 静态交互样本，并新增 4174 真实 Cloak 合成工作台：真实 JPEG、会话权限、PDF 下载、Candidate 持久化与向临时文献库的正式发布已经贯通。[Web 文献库](../../../migration/evidence/runtime/workbench-library.md)已接入搜索、详情、引用/被引/版本导航、引用证据与正式文件下载；动态目标切换已通过统一 `/api/target` 与 Browser Host 导航边界接入；同一认证端口的 `/api/tabs` 提供标签列举和激活，前端不持有 Browser 句柄；[接纳证据](../../../migration/evidence/browser-acquisition/candidate-acceptance.md)、[Candidate 回收](../../../migration/evidence/runtime/candidate-abandonment.md)和[lifecycle 矩阵](../../../migration/evidence/browser-acquisition/browser-lifecycle-matrix.md)共同关闭阶段退出门。

## 依赖与后续任务

依赖 M0/M1，Candidate 重启读取与发布回执依赖 Storage。首阶段已支持 navigation、redirect、普通 response/download；blob/data/frame/popup 已补充归属和 admission，Range 明确失败，复杂 viewer 继续 Deferred。未实现 admission 的通道必须禁用或明确拒绝，popup 等页面变化仍须遵守 Network 合同。

T029–T036 是当前计划的必做范围：冻结 never/notify/pause 策略，完成 Agent 预算与迟到结果处理，补齐 PDF 资源限制和三态文章/版本验收，完成冷却、取消、Public → API → Browser 编排，并用混合成功/拒绝/慢下载/错文 fixture 验证无人打扰批次和人工接管。它们不能再作为“首阶段之外”的可选扩展。

## 退出门

首阶段核心门已达到：真实 Browser 只访问 loopback fixture；两名观看者可看同页但只有一名控制者；普通 response/download、blob/data 和 popup PDF 形成 Candidate，Range 不误收；旧 Observation/epoch 不调用 Browser；人工输入不能通过 Agent 入口执行；桌面和窄屏旅程通过。目标运行时仍为 ADR 0016/0024 的 operator-managed CloakBrowser，证据见[目标 runtime](../../../migration/evidence/browser-acquisition/cloak-workbench-runtime.md)和[生命周期矩阵](../../../migration/evidence/browser-acquisition/browser-lifecycle-matrix.md)。原始 M2 的剩余限制是复杂 viewer 和跨版本 Range 兼容性，已在[捕获矩阵](../../../migration/evidence/browser-acquisition/browser-capture-matrix.md)中明确，不以 skipped 测试冒充支持。

M3 只有在 T029–T036 的原始验收全部通过后才能关闭；当前状态见[全量路线](full-migration-roadmap.md#m3自动获取闭环)。
