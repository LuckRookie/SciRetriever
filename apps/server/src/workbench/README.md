# 工作台服务端适配

提供默认对外监听、Web 统一登录与设备按用途认证的 HTTP、页面资产、Browser 会话观看与控制，以及统一任务、文献阅读、配置和维护操作的传输边界。页面交互代码在 Web 前端源码，生产接线在 [bootstrap/workbench.ts](../bootstrap/workbench.ts)。

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

`GET /api/v1/query/material-bytes/:literature_id/:asset_id/:asset_sha256` 读取固定 PDF。正式工作台使用登录和工作台 Cookie、同源及当前登录会话的 `X-Sciretriever-Client-Id`，带查询参数返回 `invalid-query`。设备用途沿用 POST 的准入。单段返回 206，多段使用整份 200。成功响应以 SHA-256 为 ETag 支持浏览器私有长期缓存，整份流在全文校验结束后交付最后一块。HTTP 选择与头部见 [material-bytes.ts](material-bytes.ts)。

`POST /api/v1/query/folders-export` 接受协议版本 1 和空 request，在单个只读快照中流式输出 `sciretriever-folders` JSON 附件，成员嵌在各自文件夹下；按 HTTP 背压逐批读取书目，连接中断后释放快照。`POST /api/v1/query/filters` 的 `export` 一次返回 `sciretriever-filters`。两者走现有 Web 登录、client/Origin/CSRF 校验；设备通过 HTTP MCP 的对应查询工具读取。

`POST /api/v1/maintenance/library-collect` 走现有维护授权。协议版本 1 的 `request` 为 `{selector}`，`result` 为 `{target_count, newly_collected}`。`POST /api/v1/maintenance/library-uncollect` 授权与请求相同，`result` 为 `{target_count, removed, folder_members_removed}`；库还在回填时返回 409 `library-collection-pending`。`POST /api/v1/maintenance/library-trash` 同样走维护授权，`request` 为 `{operation, selector}`；`POST /api/v1/query/library-trash` 接受 `{operation: list|count, request}`。`POST /api/v1/query/search` 给候选附上 `discovery_origin`。

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
| `POST /api/import`                              | 显式导入 BibTeX、BibLaTeX、RIS 或 CSL JSON 文本；委托入库批次，保留原请求和结果。                                                                                                                                                                                                                                                                       |
| `/api/configuration/*`                          | 配置、凭据状态、显式保存与 probe；连接测试仅由用户明确操作触发。                                                                                                                                                                                                                                                                                        |

工作台先通过同源 `POST /api/clients` 取得 tab grant，后续请求携带 `client_id`；POST 同时携带 `x-workbench-csrf`。所有连接先经 `/auth/login` 取得 HttpOnly 会话，tab grant 绑定该会话；不提供本机免登录。Host 接受 IPv4 字面地址或 localhost，Origin 按当前 Host 校验，无需公开 origin 配置。Host、Origin、cookie 与 grant 在调用共享路由前验证；共享 query handler 继承已验证的请求 origin，不再次要求 loopback。`/auth/status` 固定声明需要认证，并显示是否已登录；`/auth/logout` 撤销当前登录及其 tab grants。正式工作台的 `/api/v1/maintenance/session` 返回同一 tab 的 CSRF；独立阅读/维护 HTTP 入口继续使用自己的原有本机安全边界。

Browser 指导、接管/交还和人工动作继续经过当前文章的控制 epoch。有效事件由 Browser owner 记录到该文章的临时 Agent 历史；切换前台所选文章不改变后台会话归属，也不授予旧工具调用新的动作资格。工作台不展示或持久化模型的私有续接数据。

HTTP 关闭先取消并排空正在处理的请求；生产组装随后停止 durable runtime 与 Browser owner，再释放数据库资源。关闭浏览器标签不等于关闭 server，也不承诺进程退出后继续执行。重启读取持久任务与已提交事实，不恢复外部 Browser 页面或自动重新执行旧任务。

[上级目录](../README.md)

机器连接使用现有 HTTP 授权边界，`POST /api/clients/disconnect` 需要当前 Cookie、client_id 与 CSRF，显式撤销连接；仍控制页面时按既有 detach/pause 政策处理。该客户端的事件流随撤销结束。客户端达到 16 个上限时，注册返回 `429 / viewer-limit`，不代表工作台关闭；只有实际关闭才返回 `409 / session-closed`。意外断开仍保留原有的 grant 过期回收与事件流重连行为。

会话摘要带获取 operation、冻结标题、排队/结束时间与结束结果；所选会话的 `actions` 保留最近 100 条动作。生产与合成会话复用 Browser 的内存投影，点击坐标绑定执行时画面，不把输入内容或 URL 查询参数送入动作记录。

正式会话的结束状态按文章 owner 的 outcome 投影；清理使用的 abort 不覆盖已发布或失败结果，只有明确取消才显示 cancelled。

`source-presentation.ts` 只处理公开错误投影：平台错误显示 error，稳定原因码只进技术详情；Agent 停止说明与内部发布/取消事实不改写。任务与 task-run 返回 source_results，来源统计经 `/api/v1/query/source-statistics` 只读聚合。

实时观看由 `screencast-relay.ts` 管理认证 WebSocket、二进制帧与有限背压，`screencast-port.ts` 定义进程内会话端口；`session.ts` 拥有控制权与活动页重绑定。`synthetic-screencast.ts` 提供明确注入的离线合成源，不是生产截图回退。

`device-connections.ts` 拥有一次性配对、仅派生值持久化和设备认证；创建时保存只用于显示的 `kind`（extension、agent 或 null，旧创建请求省略时为 null），之后不提供修改入口。`device-http.ts` 在 Web 会话之前分流设备请求，统一按登记的用途准入，拒绝令牌进入 Web/配置/管理路径。设备管理继续经过原 Web client/CSRF；提交撤销后通知同进程协议连接立即失效。设备与通过原 client/同源准入的登录 Web 用户共用安装后的 agent-access 只读下载，缺失有明确错误；不在认证层生成 skill 内容。业务接口登记在源码树内的 `bootstrap/device-routes.ts`。`/mcp` 由相邻的 `mcp/http.ts` 处理 GET/POST/DELETE，工具级用途由共用 MCP server 再核对；工作台关闭先释放该 registry 的协议连接。

`POST /api/v1/query/document-draft-differences` 返回固定初稿片段中已保存差异的有界 JSON UTF-8 分片，经原 Web 登录、Cookie、client、Origin 与 CSRF 准入后读取。这条查询路径不登记于设备路由表，设备令牌直接访问被拒绝；设备通过 HTTP MCP 的 `document_read` / `draft-differences` 读取，要求 read 用途，operate 和 intake 不能代替。文档与证据的 JSON 读取结果按固定版本给出 text_level，初稿 describe 另带 draft_summary。

[import-http.ts](import-http.ts) 提供 `/api/v1/intake/` 下的接口说明、批次、预览/确认、文件清单/流式上传与报告。设备分支要求 intake 用途并在读正文前检查批次归属；列表与游标也限本连接。Web 经既有 Cookie、client_id、Origin 和 POST CSRF 后共用处理函数，可操作全部批次。确认只固定 running 并返回进度，接纳在后台继续。设备文件上传订阅撤销，撤销时先尽可能发出 401 device-revoked 并关闭连接；未接纳的候选清理，已接纳事实保留。data 为 8 MiB，其余批次 JSON 为 64 KiB。

`POST /api/v1/query/intake-batches` 的 `list-summary` 操作为工作台提供批次摘要页，使用现有版本 1 查询封套和 `list` 游标。每项是省去 `full_text` 与 `estimates` 的 `IntakeBatch`。`list` 和 `get` 继续返回完整字段。

`POST /api/v1/intake/literatures/:literature_id/pdf` 只接受登录 Web，注册表没有为它授予设备用途。正文为 PDF/八位字节流，文件名头 X-Sciretriever-File-Name 是百分号编码 UTF-8 的 basename；回应 result 包含 batch_id 和 file。它复用同一流式文件通道与按入口每日开放批次，没有 16 MiB 限制。原维护 PDF 地址保留 receipt 响应，生产组装同样传入流式接纳方法。

`POST /api/v1/intake/folders` 通过入库用途或原网页登录准入后只读调用文件夹服务的 list，返回完整文件夹树，不受批次归属限制；read/operate 不能代替 intake。批次、报告含按论文的 full_text；批次 estimates 对应按批次筛选创建获取 PDF/解析任务的预估。既有 `/api/tasks` 接受 acquire-pdf 与 parse-documents 两种范围任务，创建不启动执行。

[capture-http.ts](capture-http.ts) 登记 `/api/v1/intake/pages/preview|save`。保存暂收扩展已解读的书目字段，有标题即可入库；设备当天的开放批次始终 running，文件经相同的 batches 文件通道交付。单篇保存限定有真实设备身份；Web 可预览与操作全部已建批次。扩展、Agent 指南与 skill 下载由 device-http 的显式 intake GET 路由读取固定构建产物，允许登录 Web，原 import/capture 与 device-connections 下载路由已移除。

正文时限由 http.ts 统一接收守卫管理：数据分段、批次文件字节、补 PDF、MCP 与原维护 PDF 输入使用 60 秒空闲时限，其他正文为 5 秒总时限，头部为 5 秒。提前响应后的未收完正文最多再排空 5 秒，持续发送不续期；及时收完仍可复用 socket。
