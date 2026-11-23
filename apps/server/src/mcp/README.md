# MCP 入口适配

把项目公开能力提供为 MCP stdio 与同一工作台地址上的 Streamable HTTP；两种传输共用工具定义、验证和 Application/Entry 处理。

## 内容入口

- [server.ts](server.ts)：共用 MCP 服务、工具调用、设备用途检查与对象生命周期；HTTP 连接借用 Web owner，关闭连接不关闭它。
- [http.ts](http.ts)：设备认证后的 HTTP 协议会话、资源上限、撤销通知与关闭；不保存认证原值。
- [transport.ts](transport.ts)：SDK 1.27.1 的 exact-optional 类型适配，透传会话 ID、消息和生命周期，不实现第二套协议。
- [tools.ts](tools.ts)：唯一工具声明、封闭请求 schema 与 HTTP 用途映射；列出和调用共用同一规则。
- [pdf-upload.ts](pdf-upload.ts)：当前连接的 PDF 磁盘暂存，按块增量 hash，无整文件内存分配或 16 MiB 上限；最多四个在途句柄、每块 192 KiB、十分钟过期，关闭/丢弃/提交后回收自身暂存。

查询、任务投影、书目导入、提取交付与配置操作复用 `entry/*-operations.ts`。普通配置状态/预览可只读调用；配置发布、凭据变更、probe 与维护工具要求 `--maintenance`。PDF 提交以受控流交给入库公共文件通道，结果保留 receipt 格式；它归入 MCP 当天的补充文件批次。文件读取使用固定 hash 与有界块；`--workbench-url` 显式连接活 Web owner，提供 Browser 协作与服务任务调用。stdio 的书目导入同步完成，不启动其它批次的恢复/过期维护。

`search_library` 接受完整的 LibraryQuery，包括主 PDF 默认文本的等级和初稿事实筛选、四种事实降序及分页；`read_literature` 返回主 PDF 事实与各 PDF 的 `default_text`，`archive_query` 在各部分返回同一默认版本的事实。读取这些计数只查 catalog，不形成初稿或启动校订。

文本搜索在 `scan_incomplete` 时返回当前窗口的计数下界，零条也可能有更早命中。`scan_side` 表明窗口按原始命中（`hits`）或工作集成员（`members`）划定。保留同一检索词，把 `next_window_cursor` 作为 `window_cursor` 传给 `search_library`、`library_counts` 或 `library_facets` 可查更早一窗。成员窗须保留同一工作集。调用可各自设置筛选。

`library_counts` 的 full_text 按论文统计取得、未取得与其中已试完的数量；statuses、with_primary_pdf 按版本。它忽略 statuses、needs_manual_pdf 的当前选择，保留其它条件；has_primary_pdf 按版本筛选。全部数字来自同一只读快照。筛选计数超过一万个版本时带 `count_truncated`。用 `library_exact_count` 在长请求道计算精确聚合、分面或列表总数，响应带 `snapshot_at`。

HTTP `/mcp` 每次请求重新验证设备连接，协议 session ID 绑定 connection_id。read 与 operate 不互相隐含；配置、凭据、设备管理、Browser/runtime 控制以及书目/PDF 输入不经此传输。入库输入走相邻的 `workbench/import-http.ts`，`intake_batch_status` 和 `intake_batch_report` 两端共用只读批次服务。HTTP 请求上下文在交 SDK 前移除认证与非协议头；操作身份为 `mcp:device:<connection_id>`。

会话有数量/空闲上限，Web 撤销立即中断连接并取消在途调用，已提交任务仍由原 owner 管理。工作台关闭先排空 MCP，再关闭共享查询和业务服务。

## 放置边界

复用已有 Application/Entry 操作，不在工具处理函数中实现平行的检索、下载或加工链。

[上级目录](../README.md)

`processor_query` 提供纯读取；`submit_processor`、`rebuild_processor_index`、`retain_extraction` 只在 maintenance 模式暴露。共享行为在 `entry/processor-operations.ts` 和 Application，任务控制复用既有工具。

`filters_query` 只读列出或导出保存的筛选，`filters_manage` 管理与导入筛选；HTTP MCP 分别要求 `read`、`operate`，不登记直接 HTTP 设备查询或维护路由。`folders_query` 的 `export` 按 `{cursor, limit}` 读取树与成员，第一页带完整树，成员按文件夹和文献 ID 排序，每页最多 1,000 项；同样要求 `read`。

`collect_literatures` 在 maintenance 模式接受 `{selector}`，返回 `target_count` 和 `newly_collected`，HTTP MCP 要求 `operate`。`search_library` 在只被发现的项上返回 `discovery_origin`。

`marks_manage` 的 `place` 记录同部分材料上的位置（`target`、`similarity`、`method`），HTTP MCP 要求 `operate`；`marks_query` 的列表和 JSON 导出包含当前方法的 `places`。原锚点和 Markdown 导出保持。
