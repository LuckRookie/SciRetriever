# 命令行入口

将人类或自动化调用的命令行参数转换成统一应用操作，并呈现结果、退出码与配置交互。

## 内容入口

- [main.ts](main.ts)：命令树、参数解析和入口分派。
- [web-supervisor.ts](web-supervisor.ts)：前台父进程、双锁交接、同端口换代与有限异常退避。
- [web-worker.ts](web-worker.ts)、[web-worker-runtime.ts](web-worker-runtime.ts)：私有 IPC 子进程入口与生产生命周期；不是用户子命令。
- [web-access.ts](web-access.ts)：统一 Web 启动参数与可选密码环境变量；默认对外监听，无密码时由 HTTP access owner 生成 API key，成功启动后显示。
- [browser-session.ts](browser-session.ts)：持续机器连接的有界 NDJSON 适配；按行返回结果，退出时撤销会话。
- [config-center.ts](config-center.ts)：配置中心操作。
- [config-ui.ts](config-ui.ts)：终端配置界面。

新增的文档、知识、综合、上下文、提取、任务观察与非交互配置命令使用 `--request FILE|-` 输入封闭业务请求；结果为 `{protocol_version:1,result}`。`jobs runtime` 操作显式连接的 Web 执行器，`browser session` 可持续观察和控制其 Browser。既有命令保持兼容。

## 放置边界

业务流程复用 Application/Entry，配置规则归 configuration；不要在命令分支中复制下载或解析实现。

`jobs run` 收到 `SIGTERM` 或 `SIGINT` 后请求中断，等待在途任务结算及应用关闭。收尾期间收到更多信号会提示并继续收尾。引用任务结算后可用 `jobs resume JOB_ID` 重新排队，再用 `jobs run JOB_ID` 从检查点继续。

`storage schema-inspect --catalog PATH` 列出增补集、回填进度和额外对象。缺少本版本需要的增补集时返回 `catalog-addition-required` 和 `addition`。`storage schema-apply --catalog PATH --addition NAME` 只接受本版本声明的增补集。首个增补集 `library-scale-04-07` 遵循首次停服切换规则。

`import metadata` 在本进程同步完成自己的书目入库，不恢复或过期其它批次。`import pdf` 直接流式读取显式路径或 stdin，委托公共入库文件通道，归入 CLI 当天的“补充文件”开放批次；保留 receipt 结果，没有 16 MiB 上限。

`literature search --request FILE|-` 接受完整 LibraryQuery 及排序，包括主 PDF 默认初稿的事实筛选和四种降序；查询范围可以直接交给显式任务。`literature read` 的 PDF 资产带默认文本版本与事实，`archive status` 按部分返回同样的事实；读取不启动校订。

`literature search --sort collected-desc` 按首次选用时间列文献，`--sort intake-desc` 按入库时间列文献。超过一万篇时，收进来范围用 `collected-desc`，文件夹与批次等范围用 `intake-desc`，文本搜索用 `relevance`。超出范围的排序返回 `library-sort-scope-limit`。

文本搜索带 `scan_incomplete` 时，`scan_side` 表明窗口按原始命中（`hits`）或工作集成员（`members`）划定。保留同一检索词，用 `--window-cursor` 或 JSON 的 `window_cursor` 传入 `next_window_cursor` 可查更早一窗。成员窗须保留同一工作集。同一窗口可调整筛选，JSON 计数和分面也接受该窗口游标。`next_cursor` 用于当前窗口内翻页。

`literature collect --request FILE|-` 接受 `{selector}`，按文献 ID 或完整查询范围收进来。`result` 含 `target_count` 和 `newly_collected`。重新收进来保留第一次选用时间。搜索页中只被发现的项带 `discovery_origin`，没有发现记录时值为 `null`。

`literature counts --request FILE|-` 共用只读文献库计数：full_text 按论文，statuses、with_primary_pdf 按版本。计数忽略 statuses 与 needs_manual_pdf 的选择，保留其它范围条件；has_primary_pdf 按版本筛选。筛选计数超过一万个版本时带 `count_truncated`。`literature exact-count --request FILE|-` 接受 `kind`、`query`，分面还要求 `limit`。结果来自单个可取消的只读快照，返回 `snapshot_at`。

[上级目录](../README.md)

`processors` 命令族提供 list/submit/run、结果与集合查询、字段证据、导出、rebuild 和 retain。

`folders export --request FILE|-` 只读分页导出分组，文件内为 `{cursor, limit}`，首次 cursor 为 null，limit 为 1–1,000；跟随 `next_cursor` 收齐成员。`filters export` 一次返回保存筛选的名称、条件和排序；两者都不创建操作记录或修改阅读历史。
