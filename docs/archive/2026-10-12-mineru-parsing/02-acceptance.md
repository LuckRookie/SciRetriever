# 02：正式解析与读取验收

状态：Completed。

## Outcome 与进入条件

01 已具备可运行实现后，在隔离 v9 catalog 中使用真实 MinerU，让四篇共 39 页 PDF 经正式 CLI 形成文档。已授权使用测试副本和本机服务，不写生产 catalog。

## Tasks

- [x] 2.1 构建实际 CLI，`config test parse` 成功；四篇 `document parse` 成功并确认 ParserResult/DocumentVersion 持久化。
- [x] 2.2 重开进程，经正式文档入口读取结构、正文和实际资源；核对输入 hash、产物 hash、页数与 provenance。
- [x] 2.3 验证 `reuse-current` 不提交新服务任务，`reparse` 发布不可变版本；失败或取消不破坏已有资产与文档。故障边界用离线注入验证，不破坏真实服务。
- [x] 2.4 运行 `pnpm full`；如出现相关缺陷完成根因修复和必要复测。记录真实服务与离线测试各自结论。
- [x] 2.5 同步 MinerU Notes、当前行为及真实修复报告，检查 diff/链接/凭据/真实产物，完成集成审查与交接。

## 责任、退出与恢复

正式入口与生产组装必须参与；不可注入现成 Markdown、fake parser 或 SQL 写入冒充正式成功。协议 remote 路径没有授权公网服务时用离线运输层验证，明确披露覆盖边界。完整解析表示可读取不证明公式、数值或化学结构科学准确，也不代表下游分析已验收。

原 `/tmp/sciretriever-mineru-live-20261012-z8Ebzg` 证据保留，新复测日志使用独立文件；失败后回到具体 adapter 条件处理。全部 Tasks、Full 和最终语义复核通过后关闭计划，不自动提交或部署。

## 当前证据与恢复点

第二轮已完成四篇完整正文/资源读取、hash 和证据解析、零任务复用和重解析后旧版本读取。最终代码的四篇正式解析也已成功，`fix-verify.mjs 3` 已通过最终完整读取、92 个资源 hash、证据、默认版本、复用零新增任务、重解析及旧版本保留。首次 Full 的远程旧断言已修复；4 个 Web 超时项在较低并发复核通过，未改超时或测试范围。最终 `VITEST_MAX_THREADS=4 VITEST_MAX_FORKS=4 pnpm full` 退出码 0，211 文件/1,622 项通过，15 文件/39 项按既有条件跳过，Quick 和最终构建通过。日志根目录同 README。

## 最终审查与交接

实际产物、完整验证和覆盖边界见修复报告（本地文件：`sandbox/reports/mineru-fix-validation-2026-10-12.md`，不随仓库分发）。Notes 和文档技术入口已同步；diff/链接/格式检查通过，未带入凭据、真实材料或构建输出。没有依赖、schema 或公开结果格式变化。原生产 v2 库未升级；真实测试在隔离 v9 库完成。MinerU 服务继续运行，任务完成，无自动 Git 操作。
