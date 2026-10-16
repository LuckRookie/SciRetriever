# 三端业务能力覆盖矩阵

范围为当前正式 Web 的业务能力；CLI 与 MCP 分别核对，不用两者的并集代替覆盖。以下入口已实现且 Full 验收通过，结果见[实施计划](README.md)。不包含纯 UI 偏好、未实现的自动提取执行器、笔记批注与新持久化业务。

| Web 业务能力 | CLI 入口 | MCP 入口 | 边界与验证 |
| --- | --- | --- | --- |
| 文献搜索、完整筛选、排序、分页、详情 | `literature search/read` | `search_library/read_literature` | 共用 LibraryQuery；query parity 验证三端相同筛选结果 |
| 引用/被引与来源详情 | `literature references/reference` | `read_references/read_reference` | 共用既有关系查询与分页 |
| 文档描述、目录、片段、切片、资源、证据、材料 | `document default/describe/outline/segments/slice/resources/resource/evidence/material` | `document_read` | 共用固定文档合同；资源支持 continuation，不暗中解析 |
| 原始 PDF / Markdown 字节 | `export pdf/content`、`literature artifact-chunk` | `read_artifact_chunk` | owner 校验目录引用和字节，固定 hash 与有界块；transfer parity 比较 MCP、CLI、Web 原始 PDF |
| 知识列表/默认值/读取 | `knowledge list/default/read` | `list_knowledge/default_knowledge/read_knowledge` | 固定产物；query parity 验证默认值与读取结果 |
| 综合准备/列表/来源/读取 | `synthesis prepare/list/source/read` | `prepare_synthesis/list_syntheses/read_synthesis_source/read_knowledge(kind=synthesis)` | 固定输入与来源合同 |
| 原文/知识上下文检索 | `context search/knowledge` | `search_context` | 原有只读检索合同，缺口不扩库 |
| 书目导入、主题/引用发现 | `import bibliography`、`discover request` 及既有高级发现命令 | `import_bibliography/discover_metadata/discover_citations` | 共用元数据 owner；maintenance parity 验证导入后 CLI/Web 可见 |
| PDF 接纳 | `import pdf ID SOURCE` | `begin_pdf_upload/append_pdf_upload/commit_pdf_upload/discard_pdf_upload` | 同一接纳 owner；16 MiB 文件上限、无覆盖；transfer parity 验证未完成/错误 hash/跨连接/只读拒绝 |
| 获取 PDF 范围与任务策略 | `jobs create-request`，随后 `jobs run` | `create_task`，随后 `control_task` | 创建只保存；selector/policy 与 Web 相同；原有 acquire_pdf 保留 |
| 解析、身份核验、单篇/长文分析、综合 | `jobs submit/run` | `submit_processing` | 共同 ProcessingTaskRequest 与 owner；固定输入准备不执行加工 |
| 任务列表、结果、活动、策略、干预和控制 | `jobs list/inspect/resolve`，既有 `jobs run/pause/resume/cancel/retry` | `list_tasks/inspect_task/read_task/resolve_intervention/control_task` | 共用任务投影；只读不恢复，任务 create/control 保留明确启动语义 |
| 在现有 Web 进程中执行/控制任务 | `jobs runtime --workbench-url URL` | `runtime_list_tasks/read_task/create_task/control_task` | 显式连接 owner，后台任务随 Web 服务寿命；browser parity 验证不新建执行 Application |
| 原文/知识索引重建 | `maintenance rebuild-index/rebuild-knowledge-index` | `rebuild_index/rebuild_knowledge_index` | 显式维护，既有索引 owner |
| 提取准备、创建、提交、回执、关闭/取消/清理 | `extraction prepare/create/read/submit/receipt/close/cancel/cleanup` | `prepare_extraction/create_extraction/read_extraction/submit_extraction/read_extraction_receipt/close_extraction/cancel_extraction/cleanup_extractions` | 共用提取 owner；maintenance parity 验证跨端幂等回执与关闭后拒绝 |
| 普通配置读取、预览、发布、凭据状态/设置/移除与显式测试 | `config read/status/preview/publish/credential/probe` | `configuration_read/status/preview/publish/credential/probe` | CAS、权限与生效时机不变；目录探测只返回已有 owner 的诊断与计数，不虚构完整模型目录接口 |
| Browser 会话、观察、标签、指导、控制/交还与候选操作 | `browser session --workbench-url URL` | `browser_view/select/tabs/frame/control/action/activate_tab/guidance/cancel_guidance/accept_candidate/abandon_candidate/disconnect` | 同一活会话与 epoch；browser parity 验证观看、双客户端争用、过期动作拒绝和退出撤销租约 |
| 洞察/引用图底层数据 | 文献搜索与关系读取 | 文献搜索与关系读取 | UI 的有界统计由同一查询数据组合；不新增统计事实 |
| 书目/知识/综合/上下文导出 | `export metadata`、`literature bibliography` 及结构化读取输出 | `export_bibliography` 及知识/综合/上下文读取工具 | 书目同一编码 owner；结构化结果保留证据和稳定引用；展示 Markdown 为调用方呈现 |

## 适用条件

- 独立 CLI/MCP 与 Web 使用相同普通配置和逻辑库。显式 runtime 操作以被连接服务的实际启动快照和库为准；机器入口不自动猜测或迁移路径。
- MCP 默认只读，写入/probe/Browser 操作需 `--maintenance`；活会话还需 `--workbench-url`。CLI 的 runtime/session 连接同样默认只读，普通维护命令本身即显式操作。
- 使用合成临时 home、fake Provider/模型/页面和 loopback HTTP 验证；不承诺真实站点获取率、外部服务可用性或机构授权。
- 上传缓冲、Browser 客户端 grant 与控制租约不持久化、不跨连接复用。明确交还与断开不同，连接丢失遵守现有暂停规则。
- 完整查询、固定产物和材料可以通过分页/分块读完；MCP 超预算报错要求缩小范围，不隐式丢弃内容。CLI 与 MCP 不必复制 Web 的剪贴板、标签页、主题或本地保存视图。

[实施计划](README.md) · [当前调用指南](../../guides/agent-interface.md)
