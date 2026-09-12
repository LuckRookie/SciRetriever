# Identity Verdict 直接验证

`judgeIdentity` 分开返回 `accepted`、`rejected` 和 `uncertain`，只有目标标识符、必要版本证据和 PDF 基本验收同时满足时才 accepted；缺证据、标识符冲突或版本冲突保持 uncertain，非 PDF rejected。

命令：`pnpm exec vitest run apps/server/test/identity-verdict.test.ts --reporter=verbose`；结果：2 tests passed。

后续[Candidate 业务接纳](candidate-acceptance.md)已连接 Literature identity、durable receipt 和实际 PDF
内容归属检查，[真实 Cloak UI](workbench-session-api.md)覆盖 accepted 发布和 uncertain 放弃；首阶段 verdict
边界已经闭环。真实论文仍按同一保守规则处理，不把 fixture 通过外推为所有来源已支持。
