# Web 文献库查询、详情与正式文件下载

2026-09-10。阶段 05-04 的 Web 入口，接入已有 Library Query 与正式 artifact reader。

## 已实现的界面

实时工作台增加“文献库”视图，桌面侧栏与窄屏顶部按钮均可进入。用户可按文本搜索，选择五种既有排序，
每页 25 条并使用原有 cursor 加载更多。搜索与详情有独立请求序号，迟到响应不能覆盖用户后来选择的结果。
“加载更多”绑定已提交的查询条件，编辑搜索框但尚未提交时不会把旧 cursor 用在新查询上。

选择文献后展示真实当前状态、标题、作者、出版信息、标识符、摘要、关键词、内容章节、引用/被引和版本计数；
可展开参考文献、被引文献及其它版本，相关文献可继续打开详情，引用条目可查看支持它的来源类型和定位索引。
已有正式 PDF 或 content Markdown 时提供下载按钮，并可从当前统一 metadata 导出确定性的 BibTeX 或 RIS。所有文献/内容字段用 DOM textContent 呈现，包含 HTML
字符的标题不会创建元素或执行脚本。390px 下结果与详情顺序排列，不横向溢出。

文献库的详情选择与 Browser 的会话目标分别管理。当前合成会话对应的文献可返回该 Browser 会话；选择其它
文献会先取得当前 operator 控制权，再通过受控 `/api/target` 切换同一 Browser Host 的 Literature 目标，
切换要求没有进行中的 Candidate、Agent 或发布操作，避免跨文献归属。目标切换仍使用同一合成 loopback 页面，
真实站点目标选择不在本轮授权范围内。

## HTTP 边界

合成 Workbench 的 HTTP server 注入实际 Application.library 与 literatureArtifacts，新增 POST：

- `/api/library/search`：消费闭合 LibrarySearchRequest，返回 `{page}`。
- `/api/library/detail`：仅接受 `{literature_id}`，返回 `{detail}`。
- `/api/library/references`：消费既有正/反向引用分页合同，返回 `{page}`；当前 UI 展示计数，分页展开后续接入。
- `/api/library/reference`：仅接受 `{reference_id}`，返回引用两端及保留的 Provider/元数据/正文支持证据。
- `/api/library/bibliography`：仅接受 `{literature_id, format}`，format 为 bibtex 或 ris；服务端只从当前 Detail 生成附件。
- `/api/library/artifact`：仅接受 `{literature_id, kind}`，kind 为 primary-pdf 或 content-markdown。

以上入口全部经过现有精确 Host/Origin、loopback 地址、HttpOnly SameSite Cookie、客户端 grant 和 CSRF 校验，
不是浏览器画面控制命令，不要求抢占 operator 权限。未注入 Library 时明确 503；不存在文献或文件返回 404。
非法命令沿用 Workbench 的 409，错误响应不反射输入或文件路径。

同一鉴权边界新增 `/api/configuration/status`，只调用 Python owner bridge 的脱敏 readiness，并保持
`network_performed=false`、`browser_launched=false`；页面顶部只展示 ready/blocked 数量，不接收或显示凭据值。

下载只从当前 Detail 选择正式 descriptor，不接受用户文件路径、任意 URL 或自报 hash。reader 在发送前完整
校验 hash、大小和文件身份；逐块发送时遵循 backpressure，结束复核成功才完成 chunked 响应，不提前发送
Content-Length。断开连接取消读取；流中失败断开响应，发送前失败返回稳定错误。文件固定为 attachment，
文件名仅由 Literature UUID 与 pdf/md 扩展名形成，不采信来源文件名。

## 验证

`workbench-library.test.ts` 4 项真实 Application/HTTP 测试：搜索分页、详情与引用、缺失文献、严格命令边界；
Cookie/CSRF/Origin 拒绝；当前 PDF/Markdown 下载与原始字节一致；损坏文件在成功下载前被拒绝。
`workbench-http.test.ts` 原有控制面安全测试继续通过。

既有实际 Cloak + 两个 Chromium viewer 测试增加：28 条真实入库文献分页（25 + 3）、选中详情、恶意 HTML
字符仅显示为文本、真实下载 PDF 的 SHA256 与已发布 Candidate 相同、桌面与 390px 文献库操作和无页面异常。
截图 `/tmp/sciretriever-library-desktop.png`、`/tmp/sciretriever-library-mobile.png` 已人工查看。

`live.html` 是实际源码，原先被通用 `*.html` 忽略；本次为它补充精确例外规则，避免交付缺少页面入口。
没有新增依赖、schema、网络授权、生产数据或 Git 提交。仅访问合成 loopback，未运行 Python Quick/Full/unittest。

## 剩余范围

后续真实 Cloak UI 已补充 Candidate 发布/放弃、取消、SSE 重连和 Browser→Literature 流程，
[Browser→MinerU→Analysis 联合旅程](browser-mineru-analysis-journey.md)覆盖 Library relevance query。更完整筛选 UI、
后台进度队列和 npm 包自含 Python/Cloak runtime 的安装后联合旅程明确 Deferred；本切片不宣称生产发布或真实
Provider 效果已经验收。

## 全量验收与预览

TS Full 成功退出：78 个测试文件、341 项测试通过；Quick、源码/测试 strict 类型检查、实际 Cloak/Chromium UI、
离线安装与最终 build 均通过。日志 `/tmp/sciretriever-library-web-full.log`。`git diff --check` 通过。
已重新启动当前源码的 4174 合成预览，并实际 GET 确认页面包含文献库入口。启动日志确认
`Live synthetic Browser workbench: http://127.0.0.1:4174`，使用新的合成临时 home，不读用户文献库。
