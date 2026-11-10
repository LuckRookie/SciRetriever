# 统一业务操作入口

组织主题/种子发现、PDF 获取、批量补全、导入导出、加工与维护操作，统一范围、结果和取消。

## 内容入口

- [query-operations.ts](query-operations.ts)：CLI/MCP/Web 共用的封闭只读操作与固定输入准备。
- [task-read.ts](task-read.ts)、[task-operations.ts](task-operations.ts)：共享任务列表、详情、创建与控制投影；只读路径不恢复任务。
- [metadata-operations.ts](metadata-operations.ts)：显式发现/引用扩展和书目导入适配。
- [maintenance-operations.ts](maintenance-operations.ts)：受控维护与提取交付，复用既有业务 owner。
- [configuration-operations.ts](configuration-operations.ts)：非交互配置预览、CAS 发布、凭据设置/移除和显式 probe；不初始化 catalog。

- [import-sessions.ts](import-sessions.ts)：持久导入会话、可独立组装的 ImportSessionReadService、只读预览、逐条接纳检查点、来源对应、文件上传与七天清理；旧三端书目入口也委托此服务；无库号文件通过 library:null 建立独立 adhoc 会话，公共数据输入不接受内部预解码载荷。身份、文件夹与 PDF 发布分别调用既有 owner。
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
