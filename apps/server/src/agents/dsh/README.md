# DSH 私有执行适配

上级：[Agents](../README.md)。业务模块通过 [中性 capability 合同](../capability.ts) 使用会话；本目录隔离 Cordis 和 DeepSeek Harness 类型。

`index.ts` 组合 LlmRuntime、SessionStore、SessionProjectionRegistry、SystemPrompt、ToolRuntime、AgentRegistry、AgentLoop 七个服务，并挂载 TokenMeter 与 BasicCompactionEngine。单次调用和任务会话共享该基础；工具含义、执行准入与实际动作由调用方提供。

- `runtime.ts`：`DshAgentRuntime` 配置门面、role/capability、统一调用及关闭；不再导出 `AgentRuntime` 别名。
- `calls.ts`：单次请求通过原生 `ctx.llm.stream()` 的隔离路由派发；保留严格 response schema、JSON 媒体类型、完整图像、模型设置、错误和 provenance。每次结束释放路由与附件，不执行工具或自行追加请求。
- `task.ts`：注册受控任务工具与最终提交，复用原生会话循环；结构/业务拒绝回到会话，逐次计量实际派发和 usage，结束时释放会话。
- `model.ts`：持续会话与中性模型协议的适配，推理和压缩均在 DSH 的模型服务内进入受控协议/Network adapter，不再调用另一套模型运行时。按 DSH 约定把会话身份转成对模型不可见的缓存路由：每个会话的请求带同一个由会话 ID 摘要得到的 `cache_key`，不外发内部 ID；无会话的单次调用按角色共用一个。报回 DSH 的用量把未缓存输入与缓存读写分开。
- `attachments.ts`：调用/会话拥有的不可变图片引用与字节校验。

默认投影保留全部图片；只有调用方显式选择 `image_policy: "latest"` 才省略较早图片，Browser 使用该策略。普通文本会话无需图片/工具能力，实际图片和工具请求由统一绑定检查，不能静默转成文本。关闭会话释放原事件所属 scope、附件和路由；关闭底座取消并等待在途模型请求。`append()` 记录外部上下文而不启动模型，下次运行时在完整工具批次之后纳入模型投影。

只使用进程内公开服务，不挂载 CLI、SDK 子进程、home/settings、凭据发现、Provider 插件、代理、工具重试或 shell。会话只在当前进程内短暂存在，不写入 catalog，不承诺跨进程恢复。DSH idle 或自由文本不代表业务完成。

`events.ts` 在 DSH 边界把可见会话事件与调用消息映射成中性记录，保留顺序、角色、文本、工具调用与结果；不输出图片引用、图片字节、模型隐藏推理或 provider 私有回放字段。
