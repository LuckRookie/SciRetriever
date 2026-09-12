# M5–M6｜持久服务、打包、切换与 Python 退役

## 结果

本文件承接原始 T046–T064。M5 在模块化单体内增加最小持久运行事实、恢复和单端口服务；M6 完成 TS 门禁、安装包、备份/迁移/回滚、性能安全、文档、Python 退役和最终发布审查。此前“关闭第二阶段”的结论已被全量迁移目标取代，M5/M6 现在属于当前计划必做范围。

## M5：持久任务与受控服务

| ID | 交付物 | 验收重点 | 当前状态 |
| --- | --- | --- | --- |
| T046 | v2 完整 DDL/manifest；`inspect/backup/migrate` dry-run 和 receipt | 不在普通查询时静默升级；v1 业务数据不变；失败和重复执行可恢复 | 完成：TS Worker 显式 v1/v2 identity、runtime manifest、dry-run/migrate receipt、backup/restore-check/rollback 已由 execution-runtime.test.ts 和 CLI 直接覆盖。 |
| T047 | 最小 jobs/targets/attempts/policy/关键事件 repositories | 不建立第二套 Literature 状态；policy 版本冻结；不存 secret 或无限历史 | 完成：jobs/targets/attempts/policy/budget/events/leases/interventions 有冻结 hash、幂等、连续序列和有界查询测试。 |
| T048 | 可恢复队列、单 workspace Browser 串行、其它独立任务有界并发 | pause/resume/cancel、`nextEligibleAt` 和预算跨重启保持；任务失败不取消整队 | 完成（单机有界范围）：ExecutionQueue 覆盖 durable lease、retry、`nextEligibleAt`、pause/resume/cancel、workspace fencing 和 boot recovery；`ExecutionScheduler` 允许不同 workspace 在固定进程上限内并发，同 workspace 串行；未扩展分布式 scheduler。 |
| T049 | durable Candidate spool、ready/ACK/GC 对账 | 文件先于 ready；commit 后 ACK 丢失可恢复；清理不删正式资产 | 完成：Candidate spool、receipt ACK/reconcile、GC 保护和正式 Asset 关系由 candidate-publication/recovery 测试覆盖。 |
| T050 | never/notify/pause 协助请求和控制现场恢复 | never 不阻塞等人；旧 lease 不复活；故障不统一转交用户 | 完成：never/notify/pause、过期时间、continue/skip/cancel 和 QueuePausedError 重开恢复已通过持久旅程。 |
| T051 | bootId、旧 lease 失效、outcome-unknown 和任务/业务/Candidate 恢复 | 已提交资产不重下；未完整 transfer 不报成功；关键 kill 点可解释 | 完成：新 bootId、旧 lease/attempt 回收、current facts 优先、Candidate/receipt/job/intervention 重开和 Browser 重新打开边界已测试。 |
| T052 | 认证单端口 API、事件/画面流、CLI/daemon 协调 | Host/Origin/CSRF/身份校验；一个 Catalog writer；不暴露 Page/CDP/SQL/任意文件 | 完成：同一认证端口提供版本化 jobs、Library、Browser API，Host/Origin/Cookie/CSRF、SSE 背压和 CLI run 已测试。 |
| T053 | 导入、任务、策略、观看/接管、Literature 和结果工作台 | UI 与 CLI 使用同一 Application；状态和处置准确；无需前端构建工具 | 完成：任务工作台支持 content/PDF、策略确认、创建/执行/pause/resume/cancel、预算和 intervention 展示，Browser/Library 同端口通过 Playwright。 |
| T054 | v1→v2、任务、断线、接管、重启和无人工批次的端到端演练 | 全流程无 Python；所有成功都有已提交事实；恢复不损坏既有文献和资产 | 完成：persistent-service-journey 覆盖 v2、Literature 保留、durable job、pause/resolve、关闭重开；真实外部流程保持未授权。 |

### M5 的最小实现边界

只新增恢复所需的 jobs、targets、attempts、policy snapshot、关键 events、Candidate 和 intervention 记录；默认不做完整 event sourcing，不保存每步 DOM/截图/浏览历史，不引入 Redis、消息队列、分布式 lease、多租户或远程集群。SQLite 继续保存关系和运行事实，ArtifactStore 保存字节，一个 Application 负责协调。

v1 兼容和 v2 产品升级分开验收。升级只在合成副本进行；先停止 writer 和 Browser、创建一致备份、检查 v1、执行显式迁移、验证 v2 后再启动。真实用户数据迁移不在计划文档修改的授权内。

## M6：验证、打包与切换

| ID | 交付物 | 验收重点 | 当前状态 |
| --- | --- | --- | --- |
| T055 | TS Quick/Full/CI：format、lint、strict types、Vitest、Browser/data/build/install | 不弱化旧用户结果、安全和数据完整性；零测试失败；真实站点不进默认 CI | 完成：TS Quick/Full、CI、portable package/doctor 和安装后 smoke 通过。 |
| T056 | 同平台副本备份、v1→v2、Profile 分离和恢复演练 | 不复制活动 WAL 冒充备份；不覆盖唯一副本；说明 v2 新写入后的回滚边界 | 完成：合成副本 backup、restore-check、dry-run、migrate、rollback 通过；真实副本待授权。 |
| T057 | 支持平台的 server/web/browser/native 完整安装包与 doctor | 用户不安装 Python、编译器、Rust 或 VNC；系统显示依赖和许可如实说明 | 完成：portable Node/server/contracts/Web 包、runtime manifest、可选 Cloak bundle 和 doctor 已验证。 |
| T058 | 性能、背压、SSRF、控制面、prompt injection、secret 专项 | 事件循环、帧、DB、内存和传输有界；未达目标先修复或披露 | 完成：限额、背压、SSRF/Origin/CSRF、凭据脱敏和封闭动作专项证据已补齐。 |
| T059 | 获授权真实站点单变量对照，或明确 `not-authorized/not-run` | 不自动访问真实站点/凭据；不把失败移出分母；未运行不声明效果 | 当前未授权/未运行 |
| T060 | README、架构、配置示例、安装、升级、弃用和用户指南 | 当前行为与目标分开；命令由安装包实际验证；Python API 替代入口清楚 | 完成：README、HARNESS、架构、foundation、配置、安装、升级、切换和证据索引已同步。 |
| T061 | 删除 Python 生产源码入口、bridge、依赖和旧对象图 | 每个活动文件有退役记录；无 Python 子进程 fallback；有效测试已有 TS 替代 | 完成生产退役：[`migration/retirement-report.json`](../../../migration/retirement-report.json) 逐项记录 242 个 Python 模块、161 个测试和 4 个历史支持文件；Python CLI entry 已移除，历史源码/无替代测试保留且不进 TS 包 |
| T062 | 干净支持环境安装后导入→获取→解析→分析→搜索→导出 | 环境无 Python/编译器仍完成流程；包不含 secret/数据；动态资源可用 | 完成：独立临时 home 的 portable doctor/config/import/search/export smoke 通过；真实 Browser/Provider 按授权不运行。 |
| T063 | 切换/回退操作手册和副本演练 | 旧 writer 停止、Profile 关闭、备份、迁移、启动和失败恢复顺序完整 | 完成：合成副本切换/回退手册和演练顺序已记录。 |
| T064 | 功能、数据、安全、平台证据总表和最终全 TS 交付物 | 无未归属功能或隐藏 Python 后门；限制准确；发布/真实切换只在授权后执行 | 完成工程审查：[`release-readiness-manifest.json`](../../../migration/evidence/final/release-readiness-manifest.json) 汇总 TS Quick/Full、119 个测试文件/466 个通过用例、模块清单、Python 退役、平台边界和未授权外部验证；结论仍为 `not-ready-for-production-cutover`。 |

## 验收矩阵

沿用原始 `08-tests-release.md` 的五组验收语义：

- C：合同、Model、canonical、CLI、Provider、Parser/Analysis 和配置差分；
- B：Browser 画面、输入、控制、Observation、生命周期和运行时组合；
- D：下载/response/blob/frame/popup/viewer/Range、PDF 结构、身份和 Candidate；
- N：SSRF、credential、控制面、预算、取消、日志和隐私；
- S/E：v1/v2、FileStore、崩溃恢复、产品全流程、安装、现场状态和切换回滚。

最新 `pnpm full` 结果为 119 个测试文件（3 个 skip）、466 个通过用例（4 个 skip），并完成 contracts/server/web build；相关增量测试另行记录在最终 manifest。每个代码切片先运行相关 Vitest，再运行 `pnpm quick`；代码交付和阶段关闭运行 `pnpm full`。按照 owner 决定，不默认运行 Python Quick、Python Full 或全量 unittest。

## 完成与授权边界

T064 只有在 T001–T063 的依赖、产物、直接测试、生产对象图和文档全部闭合后才能完成。计划允许在合成副本上实现和演练升级、回滚与安装流程；真实 Provider、真实站点、用户 Catalog/Profile、生产发布和切换需要独立明确授权。没有授权不会阻断软件工程任务，但必须保留 `not-authorized/not-run`，不得声称现场效果或生产切换已经通过。
