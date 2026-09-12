# PDF Acceptance 直接验证

`acceptPdf` 将输入交给受限时长的 `pdfinfo -` 子进程，检查 PDF header、reader exit status、可读取页数和加密状态；输入为空、伪 PDF、损坏 PDF、超限或 reader 超时均失败。加密字典在调用 reader 前即被拒绝，空文本页只能得到 `uncertain` 身份结论。测试使用合成 PDF，不依赖真实文献。

命令：`pnpm exec vitest run apps/server/test/pdf-acceptance.test.ts apps/server/test/pdf-evidence.test.ts --reporter=verbose`；结果：6 tests passed。

后续[PDF 身份证据](identity-verdict.md)、[Browser Transfer](browser-transfer.md)和
[真实 Cloak Candidate 旅程](workbench-session-api.md)已经接入此验收。子进程仍使用 timeout、输入上限和
受控 executable，没有独立 memory/cgroup Worker；该平台加固项不属于当前单平台首阶段支持声明。
