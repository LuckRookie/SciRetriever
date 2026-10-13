# Web 回归测试

保存 界面状态、页面交互和 loopback Chromium 旅程 的可重复离线回归。测试以 \*.test.ts 命名，fixture/helper 与测试就近存放。

`workspace-launch.test.ts` 验证正式 CLI 启动、空配置拒绝、书目导入和数据库路径保存后运行绑定不变；`jobs-workbench.test.ts` 验证真实持久任务、部分失败/重试、控制及历史分页；`knowledge-workbench-integration.test.ts` 验证同源 PDF、解析、知识/身份加工、固定结果与证据阅读。外部 parser/model 使用 fake，SQLite、HTTP 和前端交互使用实际实现。

配置保存与冲突、PDF 解析回执、上下文索引与证据的完整 Chromium 旅程显式使用 30 秒用例总预算，涵盖构建、浏览器启动和临时库生命周期，避免 Full 并行执行时触发默认 5 秒总超时；各步骤的轮询时限与业务断言保持不变。

## 放置边界

共享合成输入放 tests/fixtures；本机真实外部测试、一次性脚本和报告放 Git 忽略的 sandbox。运行时临时 home/数据库由用例在系统临时目录创建。

相关说明：[共享测试材料](../../../tests/)；[测试与验收规则](../../../HARNESS.md)。

[上级目录](../README.md) · [项目 README](../../../README.md)
