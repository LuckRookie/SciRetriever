# 01 可用性修复

状态：Completed（2026-10-19）。

**Outcome**：正文连续读取而无需频繁点击；栏宽可调；会话空态、tabs 和引用范围不误导；摘要/来源可读且窄屏可达。

进入条件：本轮明确修复授权；已阅读 HARNESS、定稿设计与现有读取合同。责任为 apps/web 的页面和阅读适配，不改变 Document、Analysis 或 Literature 事实所有权。

## Tasks

- [x] 1.1 诊断七类反馈。确认 Supporting Information 来自解析结果、32 段证据限制产生分批正文、总结技术渲染与网络取样范围。提案保留原因和限制。
- [x] 1.2 实现接近末尾自动有界续读，单次在途请求、错误停止/显式重试、固定版本与取消；保留稳定正文节点，避免图片和表格重建。继续验证目录/证据跳转和位置恢复。
- [x] 1.3 修复 tabs 对齐、Browser 空态跨列、说明折叠；导航/信息栏支持拖动、方向键、恢复默认及本机偏好，窄屏不显示拖动手柄。
- [x] 1.4 摘要与来源分开；显示真实来源名、时间和书目记录，不铺 JSON；修复窄屏信息隐藏。
- [x] 1.5 洞察明确当前筛选/选择/全库范围，显式全库入口不修改库筛选；零边显示取样说明；选项状态与内容一致，迟到图查询不能覆盖统计。
- [x] 1.6 直接浏览器回归与多主题/桌面/窄屏一次批量检查，修复发现的问题；Quick/Full 与最终 diff 审查。

## 集成与验证

新增 panels helper 只保存 localStorage UI 宽度；无 schema、公开 API 或依赖变更。自动续读继续使用现有 document-slice/max_bytes/continuation；每页最多 32 段证据由后端决定。摘要来自 metadata，来源来自 observations，不重新总结。

直接命令：`pnpm exec vitest run apps/web/test/workspace-experience.test.ts apps/web/test/workspace-reading.test.ts`；后续 `pnpm quick`、`pnpm full`。覆盖错误注入、稳定 DOM、段落不重不漏、旧读取/资源取消、快速切换、选项高亮、真实布局、键盘/拖动与刷新偏好。所有读取使用合成临时库，不连接用户语料、Provider 或模型。

退出条件：上述任务、当前指南、相关 README、完整质量门禁闭环。保留引用图抽样限制，不把本轮空态修复宣称为全库关系网络实现；不改总结和不可变 Markdown。

失败恢复：保留失败日志与合成复现，修复当前切片；不得删除断言、放宽业务合同或改用户数据让测试通过。恢复时检查本轮与既有认证 diff。

## 执行记录

基线 `master@5420f63`；实现已落在当前未提交工作树，保留前一轮认证改动。直接回归：`workspace-experience.test.ts` 4 项和 `workspace-reading.test.ts` 6 项通过；正常登录、全部合成材料、无外部服务。Quick 通过。多主题视觉检查覆盖 1440/light、1280/dark、1024/green、390/warm；集中修复中宽窗口正文被放大信息栏挤压和会话说明对齐，再确认一轮。相关测试另覆盖原阅读器的 PDF、正文和知识视图。

本机证据：`sandbox/runs/2026-10-19-web-experience/related.log`、`visual/` 和 `visual-confirmed/`。最终 Full 已通过（exit 0）：Quick、246 个测试文件/1,889 项测试、最终构建；16 个文件/40 项按既有条件跳过。命令为 `SCIRETRIEVER_BROWSER_EXECUTABLE=/home/duanjw/.cache/ms-playwright/chromium-1187/chrome-linux/chrome VITEST_MAX_FORKS=3 VITEST_MIN_FORKS=1 pnpm full`，日志 `sandbox/runs/2026-10-19-web-experience/full.log`。检查 diff、Markdown 链接与原型 hash 通过。

本轮没有调用真实模型/parser，没有修改用户数据库或资产；未新增依赖、公开 API 或 schema。全量验收包含稳定节点数组释放。真实材料读取只用于诊断，未将其放入共享回归。未 commit。残余范围为原解析标题、总结组织/生成质量与引用网络抽样改进，分别由 12（解析与引用网络）和 07（阅读器总结展示）承接；视觉、组件与动效见 02–11（React 重建）。

[计划入口](README.md)
