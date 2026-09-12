# 全量迁移范围决策

更新时间：2026-09-10。

当前结论：**原“关闭第二阶段扩展”的裁剪决定已被取代；恢复原始 `original-bundle` 的 M0–M6 全量 TypeScript 迁移范围。**

首阶段本地单用户闭环已经完成：配置 projection → Browser → Candidate → Literature → loopback MinerU → Analysis → Library。该结果作为 M2 和部分 M3/M4 证据保留，不再用来关闭原计划的后续任务。

当前必须继续完成：

- 全部活动 Python 模块、公开入口、测试语义、Metadata Provider 和 Acquisition source 的迁移映射与 TypeScript 实现；
- Configuration/Credential、MinerU、Analysis 和 CLI 从 Python bridge/入口切到唯一 TS Application；
- 原始 M5 要求的最小持久任务、恢复、Candidate 对账、单端口服务和工作台；
- 原始 M6 要求的安装、备份/回滚、性能安全、文档、Python 退役和发布审查。

为避免过度工程化，M5 只实现单机、单 operator、模块化单体所需的最小运行事实和恢复能力。不增加 Redis、微服务、分布式调度、多租户、远程集群、完整 event sourcing 或多 Agent 平台。多个 Browser workspace 只有在原始任务的验收确实需要时才以独立 Profile 实现，不扩展成通用平台。

真实 Provider/MinerU/LLM、真实站点、用户数据迁移和生产切换仍需独立授权。未获授权时完成离线实现和副本演练，并如实记录 `not-authorized/not-run`。
