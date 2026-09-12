# Browser Observation 直接验证

`BrowserObservationStore` 生成绑定 article/page 的单调 revision、document version 和 viewport version，输出 query-free URL、有界 frame、page state、capture state 和脱敏 title。测试覆盖导航/viewport 变化、2,000,000 字节 frame 上限、敏感 title 和 unsafe URL 拒绝。

命令：`pnpm exec vitest run apps/server/test/browser-observation.test.ts --reporter=verbose`；结果：2 tests passed。

后续[目标 Cloak runtime](cloak-workbench-runtime.md)和[真实工作台会话](workbench-session-api.md)已接入有界 DOM
surface、可见 element ID、resize/viewport revision、原生 document generation、JPEG 与 Host 动态观察；
首阶段 Observation 边界已经闭环。
