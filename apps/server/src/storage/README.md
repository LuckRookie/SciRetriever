# 持久化实现

提供不可变文件、单一当前结构的 SQLite catalog、执行记录以及写入准入和锁。

## 下级目录

| 目录                              | 职责                            |
| --------------------------------- | ------------------------------- |
| [execution/](execution/README.md) | 执行记录存储                    |
| [files/](files/README.md)         | 不可变文件存储                  |
| [sqlite/](sqlite/README.md)       | SQLite catalog 初始化与结构检查 |

## 内容入口

- [artifact-layout.ts](artifact-layout.ts)：原始文件、解析与知识产物的分类目录、hash 分桶和真实扩展名；已有 catalog 路径优先复用。

初稿内容与 Markdown 的新对象目录分别为 `parsed/draft/content`、`parsed/draft/markdown`；结构继续使用 `parsed/structure`，图片只引用原始解析已经登记的资源对象。固定文档的初稿读写通过相邻 document 模块与 sqlite/draft-text-engine 协作。

- [locking.ts](locking.ts)：文件锁与写入协作。
- [write-admission.ts](write-admission.ts)：写入准入。
- [retrieval-refresh.ts](retrieval-refresh.ts)：catalog 旁的非秘密索引刷新队列状态，严格读取、原子替换和写入串行化；不保存文献正文或配置。
- [processor-results.ts](processor-results.ts)：不可变算子结果/集合、固定依赖与可重建查询投影，负责 summary 引用固定范围与真实缺失的发布/回读核验；指定结果重建时同时覆盖其快照 map 依赖，避免逐篇结果缺少投影使检索过期。

## 放置边界

保存业务模块已经确认的事实。源码目录不存真实 catalog、PDF、配置或用户语料，也不替业务模块决定合并与接纳。

[上级目录](../README.md)

- [raw-parsing.ts](raw-parsing.ts)：原始解析不可变字节发布、读取校验、逐 profile 状态与引用保护；大型产物不进入 SQLite。

- [proofread.ts](proofread.ts)：校订产物与人工决定的不可变文件，读取校验与 SQLite worker 发布；与 raw 的引用保护在同一事务登记。

`structure-annotations.ts` 保存与验证固定文档的结构注释，文件保存 JSON 字节，catalog 保存版本关系和人工角色审计；识别规则与业务决定属于 Document，存储不判断章节语义。

`archive-text.ts` 保存 schema 2 文本清单、页处置与人工锁的不可变 artifact，复用校订表与 raw pin；发布在同一事务内检查 current/manual/raw 身份。发布及加载共用配对校验：长文档的三种比较依据只允许位于 unreviewed 页的保留叶块，人工锁仍用 manual；历史文本与页记录保持可读。`proofread.ts` 继续解码历史版本与共享页缓存。

`raw-parsing.ts` 在原始解析提交并释放字节写入锁后调用可选的认篇钩子，交给文献 owner 使用原有解析文字与区块。钩子失败保留已提交解析；索引刷新机制不变。
