# 02 Browser 会话历史与受控工具

状态：Completed（实现与定向/Quick 已验证；最终集成 Full 和现场对照由 04 收口）。上级：[计划控制面](README.md)。本块不是创建第二个 Browser runtime。

## Outcome

同一篇文章在既有 Browser 页面上完成多轮观察与动作；DSH 会话连续保留目标、模型调用、工具结果、拒绝/失败反馈、人工指导和 transfer 恢复输入。压缩后模型仍能识别已尝试的失败路线与当前目标，旧截图按明确投影策略处理。所有实际动作继续经过 Browser 的 revision、document generation、control epoch、执行资格与节奏检查，DSH 自动循环不能越过它们。

## 进入条件

- Owner 已批准实施。1.3 的中性能力/session/模型合同稳定后可以准备工具与 fixture；接入真实循环需 1.4–1.7 通过。
- 当前 `browser/decision.ts`、`article-flow.ts`、`article-session.ts`、`control.ts`、`observation.ts`、`pacing.ts` 及对应测试已核对。以当时工作树为起点，不覆盖此前的 300 秒/30 次模型调用、末次反馈和持续补位修复。
- Browser 工具仍为现有六种封闭动作，不引入任意 URL、文本输入、脚本、selector、凭据读取或身份切换权限。

## 责任边界

Browser 拥有目标材料选择、观察净化、动作 schema/语义、页面句柄与归属、文章状态、时钟、剩余预算、epoch/revision、执行结果与真实下载事件。Agents 中性能力边界承载 session 和事件，`agents/dsh/` 把它们转成框架会话与工具；没有资格检查逻辑应只存在于 DSH prompt 或框架历史中。

本块触达 Browser flow 与 decision adapter、Agents 中性接口、必要直接测试。Workbench 指导和 transfer 的生产事件来源在 03 接线；这里先固定可验证的输入/结果与跨回合语义。Acquisition 仍是文件合法性和候选唯一 owner，模型观察不到候选 lease、资产绝对路径或原始签名 URL。

## Tasks

- [x] **2.1 明确 Browser capability 的可调用合同。** 依赖 1.3，整理当前 `BrowserDecisionTarget`、`BrowserArticleExecution`、`BrowserArticleStepResult` 与 `FlowDecision` 调用方；定义中性能力输入中的目标、当前观察、工具集、取消与文章关联，以及进度、暂停、失败、结束结果。会话句柄与业务 session 一一绑定，但不把 DSH session ID 当作 Literature/operation 身份。输出 Browser 消费方适配与输入验证测试；验收为不匹配 article/session、未知 scope、已关闭 scope 和重入调用均在模型/动作之前拒绝，结果不能通过自由文本声称 candidate 或 publication。
- [x] **2.2 以完整事件历史替代逐次输入重建。** 依赖 1.3、1.7 和 2.1，创建文章 scope 时写入目标与提示词，此后追加观察、assistant 工具调用和实际 tool result，继续同一 DSH session。用 call ID 将结果关联到原请求，记录成功、拒绝、取消、错误和未执行的原因；人类已执行操作、指导状态和下载恢复都作为明确来源事件进入历史。替换当前每轮新建 system/user、`recentActions.slice(-6)` 与少量字符串反馈作为唯一记忆的路径；保留 Web 必要短投影，但不能用它代替会话完整历史。输出历史转换与回放测试；验收为超过六轮、重复失败路线、元素 ID 改变、工具失败和空观察后，下一请求仍可追溯先前尝试与结果，A/B 历史不串篇。
- [x] **2.3 将受控动作接成真实 DSH 工具。** 依赖 1.4、2.1–2.2，把现有 `browser_action` 的严格 schema 和 `parseBrowserAction` 保留在 Browser owner，DSH 工具回调只调用软件边界。工具在执行前检查固定文章/page 身份、document generation、revision/viewport、control epoch、取消、phase 和预算；只在实际接受执行后统计动作。每个模型响应最多允许一个有副作用动作，多个工具不能在同一个旧 observation 上依次点击；完整记录其它调用被拒绝的 tool result，不能静默只取第一个。输出工具注册/结果映射与失败注入测试；验收为同批双点击只执行合法的一个，旧坐标/旧 revision/接管后的迟到调用零动作、零额外统计，拒绝反馈在下一合法模型输入可见。
- [x] **2.4 让 Browser 掌握节奏和预算准入。** 依赖 1.5、2.3，在 DSH 下一次实际模型请求和工具动作之前调用 Browser 准入；Browser 决定是否等待页面反馈、等待至少 5 秒、归还/重领 worker 或终止。DSH 管理通用工具循环与会话，Browser flow 只保留文章/页面/控制/调度职责，不再拥有另一套 assistant/tool 历史循环。保留 `BrowserArticleClock` 的 300 秒累计活跃时间、30 次实际派发、动作只统计；包括压缩在内的实际请求不得绕过剩余额度。输出逐回合调度适配与 fake-clock 测试；验收为模型/平台/worker 排队不算活跃派发，推理/动作/页面反馈/节奏按原规则计时，恢复不清零，末次合法调用仍能完成动作和既有有界反馈/下载交接，禁止新模型调用但不提前取消有效 transfer。
- [x] **2.5 实证 turn 结束与恢复边界。** 依赖 2.3–2.4，用真实 DSH loop 验证工具调用中 `concludeTurn()`、取消、`whenIdle`、下一输入的精确行为。transfer started、人工接管或候选 ready 到来时，软件立即撤销后续决策/动作资格并让出 worker；不能把 DSH idle 当作业务结算。覆盖同批多个工具、工具正在执行、模型尚未返回、结束回调重复和恢复输入竞争。输出确定的暂停/恢复接法与时序测试；验收为 conclude 后同批其它动作被 Browser guard 拒绝，不新增网络派发，工具实际结果仍能正确闭合历史，恢复使用同一文章 session 并先取得新观察。若插件语义不能满足，就在本块修正宿主交接适配，不通过放宽控制边界维持运行。
- [x] **2.6 实现截图引用、模型投影与压缩。** 依赖 1.2、1.7、2.2，把已净化的截图放入任务/文章 scope 所有的附件实现，引用包含可校验的媒体类型、尺寸、内容 hash 与拥有者，实际模型请求可读取对应字节。定义旧截图退出模型投影的规则和压缩触发/错误语义，保持当前截图清晰可用；原事件/附件在批准的短寿命会话内可追溯，不能只保留不可读 ID，也不能压缩后每次重新附上全部图片。压缩只形成模型投影，不修改页面版本、准入、预算、工具执行或候选事实。输出附件实现、投影测试和压缩前后断言；验收为旧截图/失败路线可追溯、当前截图正确读取，跨 scope 读取拒绝，缺失/损坏引用有明确错误，压缩失败不回滚有效历史或另开空会话，会话 close 释放附件且后续读取拒绝。
- [x] **2.7 闭合 Browser 离线能力切片。** 依赖 2.1–2.6，把假页面、脚本化模型响应、真实 DSH 插件和 Browser owner 组合成直接旅程：覆盖覆盖层→点击→页面变化→错误路线→返回→PDF 相关操作，以及人工操作后恢复和下载失败后的新观察。输出定向结果及必要的 Browser/Agents README 和技术合同补丁草稿；验收为 Browser 仍执行原动作语义、DSH 真正接收 tool result 并决定后续步骤，生产接线只差 03 的对象图而非缺核心会话行为。

## 集成与影响

`FlowDecision` 的内部职责可能被新的 capability/session 消费方式取代；先核对 standalone 测试 seam 与生产自动/协作调用方。保留仍有意义的单步软件测试，但不能仅通过为 fake `decide` 增加数组历史来证明 DSH 接入。旧 decision 提示词中的有效 Browser 规则应迁入 Browser 持有的能力定义，不复制在新的 framework profile 和旧路径两处。

DSH event history 仅为当前执行上下文；Workbench 继续读取 Browser 的正式观察和任务状态，不直接读取 vendor event tree。图片与事件的首版内存生命周期需要在实现中显式释放，不新增 catalog 表、session 文件或长期日志。跨文章连续对话不属于本块；不得让 A 的摘要或截图出现在 B 的模型输入。

## 验证

现有直接入口：

```bash
pnpm exec vitest run apps/server/test/browser-decision.test.ts apps/server/test/browser-article-flow.test.ts apps/server/test/browser-article-session.test.ts apps/server/test/browser-pacing.test.ts
pnpm exec vitest run apps/server/test/browser-observation.test.ts apps/server/test/browser-control.test.ts packages/contracts/test/browser-actions.test.ts
pnpm quick
```

拟新增 `apps/server/test/browser-dsh-session.test.ts` 与 `browser-dsh-tools.test.ts`；2.2–2.7 创建后执行：

```bash
pnpm exec vitest run apps/server/test/browser-dsh-session.test.ts apps/server/test/browser-dsh-tools.test.ts
```

重点断言应读取模型真实收到的消息/图片引用与实际 `page.apply` 记录，而非只检查某个 helper 被调用：历史成对关联、每轮一个实际动作、旧执行权失效、末次反馈保持、压缩请求实派发、截图读取和 close 后释放。外部模型/页面可 fake，真实 DSH loop/session/tool/compaction 不能 fake。真实出版社、人类 Web 界面和后台 writer 的完整生产旅程由 03/04 验证。

## 退出条件

2.1–2.7 的中性调用、完整历史、工具执行限制、预算/节奏、turn 结束与附件生命周期有直接测试；Quick 通过。03 可以只通过对象图与事件桥接使用能力，不需要重写 Browser 原子工具、历史存储或 DSH 模型协议。没有用模型 prompt 替代硬 guard，也没有以新进程/第二个页面 provider 绕开现有 Browser。

## 恢复与交接

保存失败用例的合成事件顺序、模型请求/工具调用关联及 patch，日志不带真实页面、URL、凭据或图片。历史不完整回到 2.2；同批动作/取消竞态回到 2.3/2.5；节奏与预算回到 2.4；图片或压缩回到 2.6。若发现 1.x 模型协议缺字段，只由 01 owner 同步生产者/消费者后继续，禁止 Browser 夹带 provider 私有对象。

交接给 03 的材料包括 capability 工厂/会话句柄、Browser admission/结果事件接点、暂停恢复合同、已通过失败注入与未覆盖项。计划编写时尚无实施 revision 或测试结果；现已完成，实际证据见下方实施记录及 04 的最终验收。

[上一结果块](01-runtime-and-model-transport.md) · [下一结果块](03-production-handoff-and-control.md) · [计划控制面](README.md)

## 2026-10-13 执行证据

Browser capability、article flow、Workbench 生命周期与事件桥已实现。`browser-dsh-session.test.ts` 新增 9 项，相关六文件共 163 项通过；覆盖超过六轮的真实工具历史、批次拒绝、等待真实结果、下载中断恢复、30 次末次反馈、压缩计费与预算原因、迟到 scope 关闭、Synthetic 单步。新增正式生产测试通过；Quick 冻结轮已通过。首轮 Full 与并行编辑重叠造成新测试/旧 transform 不一致，三 DSH 文件以相同 forks=3 的新进程两次复核 24/24 通过，最终完整 Full 单独执行。
