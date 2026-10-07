# 03：集成与交付

Outcome：代码、当前文档、可观察来源选择与 Full 验收一致。

进入条件：01、02 直接测试完成。Primary owner 检查完整对象图与本轮 diff。

- [x] 3.1 同步技术文档、配置指南和 Provider Notes 的当前实现说明，说明政策依据、默认值、进程生命周期限制与 Browser 边界。
- [x] 3.2 运行定向回归、Quick、最终 `VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 pnpm full`，记录数量、日志及未覆盖条件。
- [x] 3.3 审查目录不是第二套业务状态、静态定义不携带 secret、旧配置兼容、原工作区改动未被覆盖；更新根计划与交付报告。

退出：Full 通过与文档闭环；如有未实现项如实保留 Partial，不用历史真实下载成功替代本次验收。证据只保存临时目录路径与脱敏结论。恢复：从实际失败用例继续，禁止扩大测试跳过范围或回滚用户改动。

最终证据（2026-10-07）：`VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 pnpm full` 退出 0；194 文件 / 1,334 项通过，15 文件 / 39 项条件跳过；Quick 与构建通过。426 文件清单没有变化，`git diff --check` 通过，新增计划与治理文档相对链接全部可解析。没有真实服务复测，不将条件跳过计为真实执行。日志在 `/tmp/sciretriever-provider-governance-20261007/full.log`。
