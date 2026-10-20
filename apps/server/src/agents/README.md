# 共享模型与受控 Agent 执行

DSH/Cordis 是唯一的模型与 Agent 执行底座，提供单次调用、完整消息调用及通用持续会话。Analysis、综合、身份核验、名称治理、模型 probe 与 Browser 均经同一基础执行；单篇/长文与综合使用持续阅读工具，历史结果合同保持。持续会话支持纯文本、多图和业务 owner 注册的受控工具，不限定为 Browser。

默认生产后端固定为 DSH，不提供原内置 Agents 后端开关；DSH 失败会返回失败，不回退到直接模型调用。保留的供应商协议 adapter 是 DSH 的受控模型传输，不是可独立选择的 Agents 后端。公开类为 `DshAgentRuntime`，原 `AgentRuntime` 兼容导出已删除。

## 内容入口

- [dsh/runtime.ts](dsh/runtime.ts)：唯一 `DshAgentRuntime` 公开门面，无旧兼容入口或执行后端。
- [protocol.ts](protocol.ts)：兼容的 `AgentCall/AgentResult`、严格 schema 与单次生命周期。
- [model-protocol.ts](model-protocol.ts)：内部多轮消息、工具调用 ID、结果状态、图像与私有续接状态；不属于文献持久化 schema。
- [common.ts](common.ts)、[openai.ts](openai.ts)、[anthropic.ts](anthropic.ts)：共享凭据和 Network 路径上的三种 wire，不自动重试。
- [capability.ts](capability.ts)：中性会话、工具、取消和逐请求准入合同。
- [dsh/](dsh/README.md)：统一配置绑定、原生 LlmRuntime 调用、AgentLoop 会话、附件及压缩适配；vendor 类型不进入业务模块。

业务消费者使用 `execute(call)` 获取既有结构化结果，`executeModel(request)` 保留完整工具历史/续接状态，或通过 `createSession({id,role,system,input_sha256,tools,...})` 创建会话。会话从 role 解析同一模型绑定，不要求消费者自行传入模型 transport。`close()` 取消并等待调用及会话释放，应当 `await`；关闭后拒绝新操作。构造对象不请求模型，首次使用时惰性组装 DSH。

会话默认保留全部输入图片；Browser 明确指定 `image_policy: "latest"`、必须返回动作和该动作输出限制。纯文本会话不要求视觉能力，实际收到图片/工具时按绑定检查，能力不足明确拒绝。DSH 的工具循环可接收证据及校验反馈；单篇/长文 Analysis 已通过固定材料工具执行多轮阅读、看图和回查；这不证明科研内容质量普遍优于旧结果。

## 放置边界

DSH 管理会话和模型—工具循环；Browser 掌握文章、控制版本、每份观察至多一个动作、节奏和探索预算。工具的副作用及结果验收归相应业务 owner，下载与发布继续走 Acquisition/Entry。会话、截图及压缩历史只存当前进程内存，关闭时释放，不保存为文献事实或跨进程恢复状态。

普通推理与压缩都经过同一模型绑定、凭据和 Network，并分别触发真实请求派发生命周期。完整 SSE body 经有界读取后重建响应，再转成 DSH 事件；这里不提供逐 token 网络交付。

[上级目录](../README.md)
