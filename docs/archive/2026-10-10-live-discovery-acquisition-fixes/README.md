# 真实发现与 PDF 获取缺陷修复

> 归档于 2026-10-11：本计划已完成，保留当时的授权范围、执行记录与验收边界；当前行为以现行架构文档、指南与源码为准。

状态：Completed。基线：`b30af24`；用户于 2026-10-10 授权修复两轮真实测试发现的问题。

目标是让现有主题发现、种子扩展和 PDF 获取流程按既有合同工作。事实入口为元数据测试（本地文件：`sandbox/reports/topic-seed-live-validation-2026-10-10.md`，不随仓库分发）和PDF 测试汇总（本地文件：`sandbox/reports/pdf-live-validation-and-issues-2026-10-10.md`，不随仓库分发），适用 R2/R3/R4/R6/R8、ADR 0012/0014/0015/0022/0029 及现行模块所有权。没有新的产品模块、数据库迁移或下载身份门。

| 结果块 | 输出与依赖 | 状态 |
| --- | --- | --- |
| [01 发现结果可接纳](01-discovery.md) | 正确协议、流式有界引用接纳、关系来源与重复执行 | Completed |
| [02 PDF 路线可执行](02-acquisition.md) | API 访问语义、路由证据、官方请求/跳转、失败信息 | Completed |
| [03 集成与真实复验](03-verification.md) | 前两块汇合后 Full、真实样本、文档和遗留条件 | Completed |

主执行者在当前工作区顺序集成。授权涵盖代码/直接测试/文档和此前真实样本的有界复验；真实调用由正式 Credential owner 授权，使用隔离 catalog，与离线 Harness 分开。未授权 Git 提交、发布、真实 catalog/资产迁移、系统 DNS 或个人配置修改。原有 requirements 改动和两份测试记录必须保留。

不变量：逐 Provider 原始扫描计数不超预算；身份保守接纳；确认引用有本地端点和来源支持；有效事实不回滚；公开/API/Browser 风险顺序不变；401/403 API 授权拒绝、429 和临时网络失败不因本轮而被忽略；凭据不随任意跳转转发；PDF 文件检查与身份未验证合同保持不变。

主要风险分别由所属块处理：来源内嵌元数据误连引用（01）、重复引用关系及取消后事实（01）、API 凭据跨 origin 泄漏和元数据 API 被匿名请求（02）、预览 PDF 与 MAIN object 区别（02）、配置未就绪与真实站点限制被误报为代码通过（03）。

完成条件：各块直接回归测试通过，生产对象图接线有效，`pnpm full` 通过；真实复验清楚区分成功、环境/权限/限流及尚未验证范围。不得把一次成功推为全部出版社可用。原始日志与文件只放系统临时目录。

完成证据：01/02 的生产修复及真实元数据、引用、Wiley/Elsevier PDF 复验完成。最终 Full 在 Vitest 环境变量限制 4 workers 下通过：203 个文件、1,380 项测试通过，15 个文件 / 39 项沿用既有条件跳过，Quick 与构建成功，退出码 0；日志 `/tmp/sciretriever-fixes-full-verified.log`。执行基线为 `b30af24` 加本工作区未提交 patch。现场证据在 `/tmp/sciretriever-fixes-live-20261010-omkDRT/`，详见复验记录（本地文件：`sandbox/reports/live-discovery-acquisition-fixes-2026-10-10.md`，不随仓库分发）。

残余条件：RSC 最后一次限流，较早通用 flow-failed 无更细现场原因；Springer 章节停在 LOGIN_REQUIRED；普通开发启动仍需配置已验证 runtime。没有宣称所有出版社成功，也没有执行 Git 提交、个人配置修改或真实用户数据迁移。恢复工作先读复验记录，只有新变化或新失败才扩大测试，不重复已有成功网络样本。

[上级目录](../README.md) · [项目 README](../../../README.md)
