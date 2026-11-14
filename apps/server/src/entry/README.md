# 统一业务操作入口

组织主题/种子发现、PDF 获取、批量补全、导入导出、加工与维护操作，统一范围、结果和取消。

## 内容入口

- [query-operations.ts](query-operations.ts)：CLI/MCP/Web 共用的封闭只读操作与固定输入准备。
- [task-read.ts](task-read.ts)、[task-operations.ts](task-operations.ts)：共享任务列表、详情、创建与控制投影；只读路径不恢复任务。
- [metadata-operations.ts](metadata-operations.ts)：显式发现/引用扩展和书目导入适配。
- [maintenance-operations.ts](maintenance-operations.ts)：受控维护与提取交付，复用既有业务 owner。
- [configuration-operations.ts](configuration-operations.ts)：非交互配置预览、CAS 发布、凭据设置/移除和显式 probe；不初始化 catalog。

- [import-sessions.ts](import-sessions.ts)：持久入库批次、可独立组装的 ImportSessionReadService、只读预览、逐条接纳检查点与公共文件通道。HTTP 确认先固定 running，再在后台接纳；CLI/stdio 书目包装同步完成。恢复与七天过期维护只由服务组装显式启用，存储失败间隔一分钟重试、连续三次记 failed。补 PDF 按网页/CLI/MCP 与系统时区日期归入开放批次；身份、文件夹与 PDF 发布仍分别调用既有 owner。
- [manual-pdf.ts](manual-pdf.ts)：旧 PDF 维护入口的 receipt 适配；显式字节和流都委托入库文件通道，不另做发布。旧入口保留已有主 PDF 的冲突响应，新补 PDF 接口用文件状态返回 existing/conflict。
- [capture.ts](capture.ts)：设备限定的单篇网页入库、只读身份预览、按日开放批次、幂等接纳及已有元数据任务补全；不接收浏览器 Cookie、URL 或自定义 provenance。文件清单统一保存在批次下，[import-files.ts](import-files.ts) 拥有流式接收、哈希重放、磁盘保护、PDF 验收、metadata CAS 与不可变发布。
- [library-transfer.ts](library-transfer.ts)：目录所有的原始材料有界读取与书目导出；调用既有文件校验和编码 owner，不接受任意服务器路径。
- [discovery.ts](discovery.ts)：主题和引用扩展操作。
- [pdf-acquisition.ts](pdf-acquisition.ts)：单目标 PDF 获取入口。
- [database-completion.ts](database-completion.ts)：数据库范围冻结与批次补全。
- [browser-scheduler.ts](browser-scheduler.ts)：浏览器获取调度。

## 放置边界

CLI/MCP/HTTP 只适配请求；供应商协议、材料验收和事实写入仍由各自业务模块承担。

[上级目录](../README.md)

- `processor-operations.ts`：CLI/MCP 共用的处理器查询、证据展开和便携导出边界。

`proofread-save.ts` 在显式保存后重建文档、无模型结构规则与参考文献；后续失败保留人工版本并返回已保存状态。`query-operations.ts` 同时提供过程、任务运行、历史预估、运行列表、文献结果和操作历史的三端公共读取。

`metadata-task.ts` 在准入时冻结来源并保存/运行现有加工任务；`metadata-task-runtime.ts` 编排主题、引用与逐篇补全，只由身份 owner 接纳观察，来源计数不成为另一份文献事实。

入库批次读取（intake-batches）、批次改名（intake-batch-rename）、范围词频（library-facets）与 PDF 预览（acquire-pdf-preview）复用 Literature/SQLite owner。PDF 任务创建在 catalog admission 内固定成员：query 按筛选、排序排除已有/无法获取项并应用 limit；literatures 保留全部显式 ID，包括已有 PDF 和无法获取项，并在执行时允许清除无法获取标记后重试。scope 保存原选择器与 disjoint 计数；任务详情和列表读取同一 scope。

library-facets 返回全部命中的标签、作者关键词、主题词，以及各层覆盖篇数。标签主次均计，只列 active 的直接标注；父标签不累计子标签。返回的作者关键词至多 30 个，按规范化名称精确查询 active 标签别名，并附当前标签 ID/名称；词频、覆盖和别名从同一读取快照产生。HTTP、CLI、MCP 共用此投影。
