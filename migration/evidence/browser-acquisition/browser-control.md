# Browser Control 直接验证

`BrowserControlCoordinator` 提供 workspace 绑定、观看者登记、单一 controller、takeover/release 和 epoch 校验。`click-point` 在 dispatch 前校验 revision、viewport version 和坐标边界；旧 controller、旁观者和旧 epoch 不会调用执行回调。

命令：`pnpm exec vitest run apps/server/test/browser-control.test.ts --reporter=verbose`；结果：2 tests passed。

本文件记录最初的 coordinator 单元切片。后续[真实工作台会话](workbench-session-api.md)和
[Browser lifecycle 矩阵](browser-lifecycle-matrix.md)已接入实际 Web client、人工 text/key、SSE 重连、
真实 Playwright/Cloak 动作、takeover 取消和旧 epoch 拒绝；首阶段控制权边界已经闭环。
