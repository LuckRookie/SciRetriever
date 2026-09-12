# Browser AgentRuntime 决策组装

2026-09-10。合成 Workbench 启动时检查 Application 的 `browser` Agent binding；仅当同时具备 `image_input` 和
`tool_decision` 时才向 WorkbenchSession 注入真实决策函数。每次调用绑定当前 Observation JSON、最新 JPEG、输入 hash
和 256 token 上限，通过统一 AgentRuntime/NetworkBudget 调用配置模型。

模型只能调用单个 `browser_action` 工具，参数合同只列出 ADR 0023 的六种动作；返回值再次经过
`parseBrowserAction`。`type-text`、按键、selector、URL、脚本、文件和凭据没有工具字段，也无法通过解析边界。
人工接管仍会中止迟到模型结果并使旧 control epoch 失效。

Browser transfer dispatcher 在字节接收开始时把 Observation `capture_state` 投影为 `CANDIDATE`，正式 Candidate
完成后投影为 `CAPTURED`，失败且尚无已捕获候选时恢复 `NONE`；live 页面据此显示捕获进度状态。

`browser-decision.test.ts` 使用 fake adapter 验证图像与工具 capability、Observation 绑定、合法动作以及模型尝试
`type-text` 时的拒绝；`workbench-session.test.ts` 继续验证迟到 Agent 不执行。未连接真实 LLM。
