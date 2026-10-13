# 工作台服务端适配

提供同源本机 HTTP、页面资产、Browser 会话观看与控制，以及统一任务、文献阅读、配置和维护操作的传输边界。页面交互代码在 [apps/web](../../../web/README.md)，生产接线在 [bootstrap/workbench.ts](../bootstrap/workbench.ts)。

## 内容入口

- [http.ts](http.ts)：工作台认证、任务与配置接口，以及正式工作台和独立阅读入口共享的查询/维护路由。
- [production-session.ts](production-session.ts)：正式 Browser 会话投影与人工协作；无初始文章时 `article_id` 为 `null`，选择和执行真实文章操作时仍验证 Literature ID。
- [session.ts](session.ts)：单个文章页面的观看、接管、交还、指导与动作边界。
- [assets.ts](assets.ts)：随 server 发布的 Web 静态资源清单。
- [synthetic-fixture.ts](synthetic-fixture.ts)：离线合成预览数据与站点。

## 正式工作台接口

正式工作台绑定启动配置选中的同一组 catalog 与资产根目录。所有业务调用复用 Application、Entry 或只读 QueryApplication，不在 HTTP 内另建业务库或任务事实。

| 路径 | 当前用途 |
| --- | --- |
| `GET /api/workspace` | 实际启动绑定、schema、配置 revision 与已组装能力；配置保存后不自动切换正在使用的库。 |
| `GET /api/tasks`、`GET /api/tasks/:id` | 最近任务、目标、结果、失败、人工介入、预算和活动。列表按创建时间新到旧截取，`ended` 组按已保存的结束时间排序（历史缺值时回退创建时间），以 `cursor` / `next_cursor` 翻阅历史；`status_group=active/attention/ended` 在 SQL 截取前筛选现有状态，避免旧活动任务被新完成任务挤出首页。详情活动保留最近 1000 项并用 `events_truncated` 标记省略的早期记录。 |
| `POST /api/tasks` | 提交 PDF 获取范围与可选策略，或已有 `ProcessingTaskRequest`；只提交，不自动运行。 |
| `POST /api/tasks/:id/start` | 明确启动或排队，返回 202；执行归同一 ProcessingTaskService。 |
| `POST /api/tasks/:id/pause/cancel/resume/retry` | 路径最后一级选一个动作；恢复与重试会明确重新启动，取消不删除已提交材料。 |
| `/api/jobs/*` | 保留既有任务兼容接口、事件分页与人工介入处理，运行同样交统一任务 owner。 |
| `/api/v1/query/*` | 文献、文档、证据、知识、综合与检索上下文的既有只读合同。 |
| `/api/v1/maintenance/*` | 手动 PDF、解析、知识分析、综合、索引与提取交付的既有维护合同。新 UI 的长时间加工优先提交 durable task。 |
| `POST /api/discovery` | 显式主题发现；使用启动配置选定的来源，只接纳元数据并返回 DiscoveryReport。 |
| `POST /api/import` | 显式导入 BibTeX、BibLaTeX、RIS 或 CSL JSON 文本；复用 Bibliography Entry 与 Identity 接纳。 |
| `/api/configuration/*` | 配置、凭据状态、显式保存与 probe；连接测试仅由用户明确操作触发。 |

工作台先通过同源 `POST /api/clients` 取得 tab grant，后续请求携带 `client_id`；POST 同时携带 `x-workbench-csrf`。Host、Origin、loopback 来源、cookie 与 grant 在调用共享路由前验证。正式工作台的 `/api/v1/maintenance/session` 返回同一 tab 的 CSRF；独立阅读/维护 HTTP 入口继续使用自己的原有安全边界。

HTTP 关闭先取消并排空正在处理的请求；生产组装随后停止 durable runtime 与 Browser owner，再释放数据库资源。关闭浏览器标签不等于关闭 server，也不承诺进程退出后继续执行。重启读取持久任务与已提交事实，不恢复外部 Browser 页面或自动重新执行旧任务。

相关说明：[统一产品接口](../../../../docs/architecture/technical/01-product-interface.md) · [任务与协作控制](../../../../docs/architecture/technical/02-task-coordination.md)。

[项目 README](../../../../README.md)
