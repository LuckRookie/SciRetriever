# 工作台服务端适配

提供默认对外监听、所有连接统一登录的 HTTP、页面资产、Browser 会话观看与控制，以及统一任务、文献阅读、配置和维护操作的传输边界。页面交互代码在 Web 前端源码，生产接线在 [bootstrap/workbench.ts](../bootstrap/workbench.ts)。

## 内容入口

- [access.ts](access.ts)：单用户 IP 直连的地址准入、scrypt 密码验证、有界临时登录与撤销；不持久化或拥有文献事实。
- [machine-client.ts](machine-client.ts)：CLI/MCP 到显式 IPv4 runtime 的受控适配；所有连接采用同一登录边界，内部持有客户端授权材料，复用会话/epoch 和任务 owner。
- [http.ts](http.ts)：工作台认证、任务与配置接口，以及正式工作台和独立阅读入口共享的查询/维护路由。
- [production-session.ts](production-session.ts)：正式 Browser 会话投影与人工协作；无初始文章时 `article_id` 为 `null`，选择和执行真实文章操作时仍验证 Literature ID。
- [session.ts](session.ts)：单个文章页面的观看、接管、交还、指导与动作边界。
- [assets.ts](assets.ts)：随 server 发布的 Web 静态资源清单。
- [synthetic-fixture.ts](synthetic-fixture.ts)：离线合成预览数据与站点。

## 正式工作台接口

正式工作台与独立查询入口对资源清单中 `/assets/` 下带八位内容 hash 的 JS、CSS、WOFF/WOFF2 成功响应使用 `Cache-Control: private, max-age=31536000, immutable`。登录页另外通过 `auth-fonts.json` 登记同源 `/auth-fonts/` 下带八位内容 hash 的 WOFF2，允许未登录 GET 访问并采用相同缓存策略；清单以外的字体、工作台资源及业务数据不因此公开。HTML、登录 JS/CSS、API、阅读材料、不带 hash 的资源和拒绝响应均保持 `no-store`；CSP 保持不变。

正式主页面使用 `live.html` / `workspace.css` 和库中心 UI bundle；静态入口允许经校验的 `view`、`reader`、查询条件和固定产物/任务参数。Browser 的 `GET /api/view` 直接返回 WorkbenchView，命令回执仍以 `view` 字段封装。

正式工作台绑定启动配置选中的同一组 catalog 与资产根目录。所有业务调用复用 Application、Entry 或只读 QueryApplication，不在 HTTP 内另建业务库或任务事实。

| 路径                                            | 当前用途                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/workspace`                            | 实际启动绑定、schema、配置 revision 与已组装能力；配置保存后不自动切换正在使用的库。                                                                                                                                                                                                                                                                    |
| `GET /api/tasks`、`GET /api/tasks/:id`          | 最近任务、目标、结果、失败、人工介入、预算和活动。列表按创建时间新到旧截取，`ended` 组按已保存的结束时间排序（历史缺值时回退创建时间），以 `cursor` / `next_cursor` 翻阅历史；`status_group=active/attention/ended` 在 SQL 截取前筛选现有状态，避免旧活动任务被新完成任务挤出首页。详情活动保留最近 1000 项并用 `events_truncated` 标记省略的早期记录。 |
| `POST /api/tasks`                               | 提交 PDF 获取范围与可选策略，或已有 `ProcessingTaskRequest`；只提交，不自动运行。                                                                                                                                                                                                                                                                       |
| `POST /api/tasks/:id/start`                     | 明确启动或排队，返回 202；执行归同一 ProcessingTaskService。                                                                                                                                                                                                                                                                                            |
| `POST /api/tasks/:id/pause/cancel/resume/retry` | 路径最后一级选一个动作；恢复与重试会明确重新启动，取消不删除已提交材料。                                                                                                                                                                                                                                                                                |
| `/api/jobs/*`                                   | 保留既有任务兼容接口、事件分页与人工介入处理，运行同样交统一任务 owner。                                                                                                                                                                                                                                                                                |
| `/api/v1/query/*`                               | 文献、文档、证据、知识、综合与检索上下文的既有只读合同。                                                                                                                                                                                                                                                                                                |
| `/api/v1/maintenance/*`                         | 手动 PDF、解析、知识分析、综合、索引与提取交付的既有维护合同。新 UI 的长时间加工优先提交 durable task。                                                                                                                                                                                                                                                 |
| `POST /api/discovery`                           | 显式主题发现或引用扩展；`kind: "citation"` 固定种子、方向与扫描上限，复用 CitationDiscovery，其余主题请求复用 Discovery；只接纳元数据并返回原 owner 报告。                                                                                                                                                                                              |
| `POST /api/import`                              | 显式导入 BibTeX、BibLaTeX、RIS 或 CSL JSON 文本；复用 Bibliography Entry 与 Identity 接纳。                                                                                                                                                                                                                                                             |
| `/api/configuration/*`                          | 配置、凭据状态、显式保存与 probe；连接测试仅由用户明确操作触发。                                                                                                                                                                                                                                                                                        |

工作台先通过同源 `POST /api/clients` 取得 tab grant，后续请求携带 `client_id`；POST 同时携带 `x-workbench-csrf`。所有连接先经 `/auth/login` 取得 HttpOnly 会话，tab grant 绑定该会话；不提供本机免登录。Host 接受 IPv4 字面地址或 localhost，Origin 按当前 Host 校验，无需公开 origin 配置。Host、Origin、cookie 与 grant 在调用共享路由前验证；共享 query handler 继承已验证的请求 origin，不再次要求 loopback。`/auth/status` 固定声明需要认证，并显示是否已登录；`/auth/logout` 撤销当前登录及其 tab grants。正式工作台的 `/api/v1/maintenance/session` 返回同一 tab 的 CSRF；独立阅读/维护 HTTP 入口继续使用自己的原有本机安全边界。

Browser 指导、接管/交还和人工动作继续经过当前文章的控制 epoch。有效事件由 Browser owner 记录到该文章的临时 Agent 历史；切换前台所选文章不改变后台会话归属，也不授予旧工具调用新的动作资格。工作台不展示或持久化模型的私有续接数据。

HTTP 关闭先取消并排空正在处理的请求；生产组装随后停止 durable runtime 与 Browser owner，再释放数据库资源。关闭浏览器标签不等于关闭 server，也不承诺进程退出后继续执行。重启读取持久任务与已提交事实，不恢复外部 Browser 页面或自动重新执行旧任务。

[上级目录](../README.md)

机器连接使用现有 HTTP 授权边界，`POST /api/clients/disconnect` 需要当前 Cookie、client_id 与 CSRF，显式撤销连接；仍控制页面时按既有 detach/pause 政策处理。该客户端的事件流随撤销结束。

会话摘要带获取 operation、冻结标题、排队/结束时间与结束结果；所选会话的 `actions` 保留最近 100 条动作。生产与合成会话复用 Browser 的内存投影，点击坐标绑定执行时画面，不把输入内容或 URL 查询参数送入动作记录。

正式会话的结束状态按文章 owner 的 outcome 投影；清理使用的 abort 不覆盖已发布或失败结果，只有明确取消才显示 cancelled。
