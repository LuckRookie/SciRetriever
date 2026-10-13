# 生产对象图组装

把固定身份的用户配置、存储、网络和业务服务连接为 Application、QueryApplication 与工作台。本目录负责接线和生命周期，不维护第二套供应商规则、文献事实或任务状态。

## 内容入口

- [application.ts](application.ts)：正式 Application 与独立只读 QueryApplication；统一构造业务 owner、共享运行时和资源关闭顺序。
- [workbench.ts](workbench.ts)：正式工作台、独立阅读/维护页与 synthetic Browser 预览的组装；把 HTTP 意图交给既有 owner。

## 工作台启动

`startProductionWorkbench({home, port?, literature_id?})` 可在不选择文章时启动。它读取启动配置、要求已有受支持的 catalog、建立一个 Application 和绑定相同 catalog/资产根的只读 QueryApplication，并在一个 loopback HTTP origin 下提供任务、Browser、文献阅读、维护和设置。`home` 是内部组装/隔离测试入口；普通 CLI `sciretriever web` 使用固定用户 home，不提供第二配置身份。

- 启动页面本身不触发发现、获取、Parser、模型调用或 Browser 页面。
- 没有初始 Literature 时，Browser 投影明确为未选择；随后真实任务内部的文章会话通过同一 `browserCollaboration` 连接工作台。
- PDF Completion Job 和解析/分析/综合等加工任务复用同一 `ProcessingTaskService` 与 ExecutionRepository；`taskHttpAdapters` 仅完成协议适配。
- 查询和维护路由由 HTTP 层共享，不增加另一监听端口，也不让普通查询触发加工。
- catalog 和资产根由启动快照固定；保存 `[paths]` 或其他普通配置后，页面报告需要重启，当前对象图不会自动迁移、创建或切换数据。
- 缺库、旧 schema 或不安全目标继续通过现有初始化/迁移门拒绝；工作台不自动初始化或升级真实库。
- 关闭时先停止并排空 HTTP 请求，再停止 Browser/任务运行时、查询 reader 和 Application；各入口返回的 `close()` 应由调用方释放。

`startQueryOnlyWorkbench` 仍只构造只读应用；`startMaintenanceWorkbench` 保留独立维护入口；`startSyntheticWorkbench` 使用合成预览和临时 home，其示例数据不能代表正式文献库。

相关说明：[任务与协作控制](../../../../docs/architecture/technical/02-task-coordination.md) · [工作台 HTTP](../workbench/README.md)。

[项目 README](../../../../README.md)
