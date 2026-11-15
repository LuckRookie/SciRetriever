# 可读文档与证据

提供初稿与校订稿固定版本的正文、片段、资源与证据读取。解析操作先提交原始解析，再独立形成初稿；complete 校订稿仍显式发布为校订文档。文本等级按固定版本的 schema 判定，不随默认关系变化；初稿形成与公开读取须一起部署。建档编排在 archive 模块。

## 内容入口

- [limits.ts](limits.ts)：发布和读取共享的正文、结构字节上限。
- [draft-builder.ts](draft-builder.ts)：独立的初稿纯构建器；从调用方给定的 raw reader、PDF 页面检查与固定资产声明形成 Markdown、结构、核对依据、差异与表示身份。只读取输入，不写库、发布或调用模型。`rebuildDraftDocument` 仅凭固定引用与初稿内容重建，不访问页面工具或原始区块文件。
- [draft-publication.ts](draft-publication.ts)：核验指定原始解析与固定 PDF，复用逐页校订的页面工具，调用纯构建器，以 create-if-absent 发布不可变内容、正文、结构并沿用原始图片。同事务登记版本、事实、当前指针及默认关系；相同身份复用。每个资产串行，取消保留已提交事实，关闭中断并等在途清理；索引请求失败只记录警告。
- [proofread-builder.ts](proofread-builder.ts)：历史 complete 校订版本到 v2 结构的确定性构建，保存区块 ID、页码与区域。
- [service.ts](service.ts)：`document parse` 的操作边界。本次部署 profile 发布或复用成功后形成初稿；其它 profile 或本次失败不回退旧原始解析。逐 profile 的回执之外返回独立 `draft`，初稿失败不改变解析结果。
- [read.ts](read.ts)：统一文档与证据读取、部分分页、校订对照和初稿保存差异的有界读取。describe 给出等级和初稿计数；初稿 outline 没有角色，按角色读 segments 时返回整篇与固定覆盖说明。
- [proofread-publication.ts](proofread-publication.ts)：完整校订版本到固定文档的显式发布与默认版本 CAS；索引刷新失败单独报告，不撤销有效文档。
- [location.ts](location.ts)：统一存储页码到公开页码的转换。
- [storage.ts](storage.ts)：文档存储协作接口。
- [verification-cache.ts](verification-cache.ts)：有界校验证明、LRU 淘汰与同版本首次核验合并。

`storage.ts` 的 `commitDraftVersion` 校验固定初稿内容与产物字节，worker 在同一事务登记版本、资源闭包、计数、当前指针与默认关系，复检原始解析仍为当前并按两个独立 CAS（初稿当前、文档默认）更新。`sqlite/document-defaults.ts` 由原始解析当前切换、初稿登记与校订发布各自在自己的事务里调用：有效完整校订稿优先，其次有效当前初稿，两者都没有则删除默认关系。重新解析会先失去旧默认，新的初稿失败时返回 `document-missing`。旧固定版本的字节与证据不变。

`application/jobs/drafts.ts` 提供显式补形成：预览只读候选元数据，创建时固定文献、PDF 部分与原始解析；执行复用本模块的初稿发布，不调用解析、模型或网络。`currentDraftMethod` 与 `currentDraftMethodHash` 为 builder 和旧方法筛选提供同一份方法定义，不为预览构建文本。HTTP 预览 `/api/v1/query/form-drafts-preview` 与创建 `/api/v1/maintenance/form-drafts` 只走 Web/维护认证；CLI 为 `form-drafts preview|start`，MCP 为 `form_drafts_preview`（read）和 `form_drafts`（operate），设备经 `/mcp`。CLI start 等待本进程内的持久任务结束；HTTP/MCP 返回已创建任务，由原运行时继续执行。任务读取返回逐部分回执，取消保留已提交版本。

显式校订稿发布先读默认关系：HTTP `POST /api/v1/query/document-default`、CLI `document default` 或 MCP `document_read/default` 返回当前 revision。发布请求的 `expected_default_revision` 填这个值，当前默认是初稿时也一样；只有没有默认关系时才用 null。HTTP `POST /api/v1/maintenance/document-publish-proofread`、CLI `document publish-proofread` 与 MCP `document_publish_proofread` 共用发布 owner；`publication-conflict`（HTTP 409）要求重读默认关系、确认当前校订输入后重试。默认 CAS 失败保留已经登记的固定版本，不把登记成功当作默认更新成功。建档自己的发布在写入范围内读当前 revision，不复用解析前的旧值。

`draft-leaves-v1` 的可读性核验使用 `rebuildDraftDocument`，只从固定初稿内容重建，不调用 PDF 页面工具；核验初稿计数、正文、结构和原始解析 ID/hash/part 绑定。初稿证明的文件指纹包含 PDF、全部图片、正文、结构和初稿内容；缓存命中仍比对 SQLite 原始解析声明与版本事实，并计入相同逻辑字节预算。缓存只略过未变化文件的字节重算，不放松单独交付资源时的实际字节核验。`draftDifferences` 再核验所交付的初稿内容字节，按合并片段中叶块的保存顺序组织差异，返回规范 JSON 的 UTF-8 字节分页；游标绑定固定版本、表示 hash、片段与位置，不重算对比。校订稿不提供初稿差异，初稿不提供 corrections。

本模块的公开 describe、outline、segments、slice、resources、resource-bytes 和 evidence 支持初稿。内部 `withVerifiedTextVersion` 为全文索引、查找、身份核验与外部提取显式开放两级固定文本，使用相同的整篇核验与预算。`withVerifiedVersion` 仍只接纳校订稿，包括同一读取范围已缓存初稿的情形；加工输入与逐值核对不会隐式取得初稿准入。结构注释对初稿返回 `document-unsupported`，不会读取正文或调用模型。

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

`storage.ts` 按 builder_version 分派 proofread-blocks-v1、arranged-leaves-v2、source-order-leaves-v3、source-order-leaves-v4 与 source-order-leaves-v5；固定文档从 V2 文本清单重新生成并核对结构/正文和实际渲染的资源闭包，不能将历史 hash 交给新 parser，也不能省略仍被正文引用的图片或声明未使用的截图。v5 长文档的等级仍为 proofread，segments、slice、evidence 可返回未校订页的三种比较依据；核验证明容纳同篇混合依据，加工用的旧三取值守卫不变。校订稿不提供 draft-differences。`read.ts` 同时提供有界 JSON 资源分页与经过整篇核验的完整图片字节流。
