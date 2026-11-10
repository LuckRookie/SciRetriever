# 生产对象图组装

把固定身份的用户配置、存储、网络和业务服务连接为 Application、QueryApplication 与工作台。本目录负责接线和生命周期，不维护第二套供应商规则、文献事实或任务状态。

## 内容入口

- [application.ts](application.ts)：正式 Application 与独立只读 QueryApplication；统一构造业务 owner、共享运行时和资源关闭顺序。
- [workbench.ts](workbench.ts)：正式工作台、独立阅读/维护页与 synthetic Browser 预览的组装；把 HTTP 意图交给既有 owner。

## 模型与能力运行时

`createApplication()` 通过现有配置与 Network 构造唯一的 `DshAgentRuntime`，惰性组装最小进程内 DSH 基础。Browser factory 注入绑定文章身份的能力；单篇/长文 Analysis 与综合使用固定材料阅读会话，原子模型消费者共享同一底座。创建 Application 不会因此发送模型请求、读取 DSH 个人配置或打开 Browser 页面。普通推理与压缩的实际派发都使用相同模型绑定与 Network；关闭先结清 Browser/业务工作和能力会话，再关闭共享网络与底层资源。

## 工作台启动

`startProductionWorkbench({home, port?, literature_id?})` 可在不选择文章时启动。它通过 Configuration owner 补齐并保存缺失的存储路径（默认位于 `~/.sciretriever/`），目标不存在时调用 Storage 初始化完整空库；再建立一个 Application 和绑定相同 catalog/资产根的只读 QueryApplication，在同一认证 HTTP 服务下提供任务、Browser、文献阅读、维护和设置。`home` 是内部组装/隔离测试入口；普通 CLI `sciretriever web` 使用固定用户 home，不提供第二配置身份。

- 启动页面本身不触发发现、获取、Parser、模型调用或 Browser 页面。
- 没有初始 Literature 时，Browser 投影明确为未选择；随后真实任务内部的文章会话通过同一 `browserCollaboration` 连接工作台。
- PDF Completion Job 和解析/分析/综合等加工任务复用同一 `ProcessingTaskService` 与 ExecutionRepository；`taskHttpAdapters` 仅完成协议适配。
- 查询和维护路由由 HTTP 层共享，不增加另一监听端口，也不让普通查询触发加工。
- catalog 和资产根由启动快照固定；保存 `[paths]` 或其他普通配置后，页面报告需要重启，当前对象图不会自动迁移、创建或切换数据。
- 仅对不存在的目标执行 create-if-absent 初始化；已有库继续通过迁移门验证，不自动升级、替换或搬迁。自定义目标父目录须已存在。
- 关闭时先停止并排空 HTTP 请求，再停止 Browser/任务运行时、查询 reader 和 Application；各入口返回的 `close()` 应由调用方释放。

`startQueryOnlyWorkbench` 仍只构造只读应用；`startMaintenanceWorkbench` 保留独立维护入口；`startSyntheticWorkbench` 使用合成预览和临时 home，其示例数据不能代表正式文献库。合成 Browser 对象图也绑定同一临时库的 QueryApplication，使界面能通过已有固定材料查询读取已接纳 PDF；关闭时一并释放该只读应用。

相关源码：[工作台 HTTP](../workbench/README.md) · [CLI 入口](../cli/README.md)。

[上级目录](../README.md)

`agent-models.ts` 只从配置解析模型身份，供执行与预估共用；查询不因此加载凭据或创建模型传输。Application 先结清会话，再关闭过程记录清理器与数据库。

`device-routes.ts` 是设备用途与业务 HTTP 接口的唯一组装登记表；当前没有开放业务接口，后续导入、HTTP MCP 和收藏在此绑定同一 Application 的 owner，不复用 Web 管理权限。
