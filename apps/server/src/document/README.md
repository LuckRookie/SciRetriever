# 可读文档与证据

提供固定版本的正文、片段、资源与证据读取。文档来源是 complete 校订稿，显式发布为默认全文；原始解析入口不发布全文。建档编排在 archive 模块。

## 内容入口

- [limits.ts](limits.ts)：发布和读取共享的正文、结构字节上限。
- [proofread-builder.ts](proofread-builder.ts)：历史 complete 校订版本到 v2 结构的确定性构建，保存区块 ID、页码与区域。
- [service.ts](service.ts)：`document parse` 的 raw 操作边界，不生成 Document，不更新默认全文。
- [read.ts](read.ts)：统一文档与证据读取、部分分页、用于人工核对的有界对照。
- [proofread-publication.ts](proofread-publication.ts)：完整校订版本到固定文档的显式发布与默认版本 CAS；索引刷新失败单独报告，不撤销有效文档。
- [location.ts](location.ts)：统一存储页码到公开页码的转换。
- [storage.ts](storage.ts)：文档存储协作接口。
- [verification-cache.ts](verification-cache.ts)：有界校验证明、LRU 淘汰与同版本首次核验合并。

`read.ts` 的内部 `withReadScope` 供知识／结果读取在一次逻辑操作内复用已核验文档；最多保留 16 份、32 MiB 的正文与序列化结构计量，结束即清空。带独立预算计量的检索不走此复用。

`storage.ts` 在同一实例与 FileStore 内跨请求缓存整篇校验证明，键绑定 document_version_id 与 representation_sha256。每次仍核对版本声明、builder、限额及表示 hash，并通过索引查询校对稿的 complete 状态、content hash、part 绑定及 manifest/blocks 描述。正常校对稿写入只追加版本，派生资源只能补登记且不能覆盖；缓存仍比较上述 SQLite 绑定，不仅依赖这一写入约定。

证明记录 PDF、全部资源、正文、结构、校对稿 manifest 与 blocks 的 bigint dev/ino/size/mtimeNs/ctimeNs。每次命中通过文件 owner 的无符号链接路径与单硬链接检查，逐个比对指纹；变化或核验失败清除旧证明，完整校验通过后才能重新写入。首次完整核验前后也比较全部指纹和校对稿绑定，拒绝核验中变化。命中不读 PDF/图片字节，也不重建结构；正文和结构从受限缓存复制交付，调用方修改返回值不会污染证明。独立交付 PDF/图片等字节时仍用 verified artifact reader 做 hash 及读中/结束校验。

缓存默认最多 16 条、32 MiB，按正文、序列化结构、声明和指纹的字节计量淘汰 LRU；JavaScript 对象有额外开销，但数量和内容规模均有界，超大条目不保留。预算回调在冷读和命中时都提前计入相同的逻辑闭包与校对源字节，不因避免磁盘读取而绕过调用方预算。同版本、同声明的首次核验共享一次；取消一位等待者不会取消其他人，最后一人取消会终止并等待核验清理。FileStore 关闭后证明不能继续使用。完整核验和指纹检查都采用有界并发，并等待全部 reader/指纹操作结束。

指纹检查提供检查时点的一致性，不是跨进程文件锁。保持 dev/ino/size/mtime/ctime 全不变的篡改（例如更高权限或异常存储行为）不在此证明的检测范围内；检查完成后的并发改写由下一次请求的指纹比较发现。实际字节交付仍独立核验，不把此证明当作资源流的校验替代。

## 放置边界

第三方 parser 协议留在 parsing/backends；通用文件/SQLite 实现留在 storage；知识解释留在 analysis。

[上级目录](../README.md)

- `section-rules.ts`、`structure-extract.ts`：结构注释的规则识别、模型边界、继承、前置信息角色、图表与参考文献的纯提取逻辑；由 annotations.ts 接入持久化与正式命令。

新建档的结构注释由相邻 archive/render 的整理结果派生；`annotations.ts`、`section-rules.ts` 与 `section-classifier.ts` 保留历史生成/测试辅助，公开旧写请求已停用，历史 schema 1 注释仍可读。`annotation-read.ts` 提供固定注释有界续读，outline/segments 经同一注释存储返回角色和过滤结果。引用关系仍由后续 Literature 接入负责，注释不拥有文献身份或关系合并。

`storage.ts` 按 builder_version 分派 proofread-blocks-v1、arranged-leaves-v2、source-order-leaves-v3 与 source-order-leaves-v4；新固定文档从 V2 文本清单重新生成并核对结构/正文和实际渲染的资源闭包，不能将历史 hash 交给新 parser，也不能省略仍被正文引用的图片或声明未使用的截图。`read.ts` 同时提供有界 JSON 资源分页与经过整篇核验的完整图片字节流。
