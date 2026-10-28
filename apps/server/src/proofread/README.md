# 原始解析校订

读取一份原始解析，以 PDF 页面为依据完成抄录矫正；不启动解析服务，也不生成总结。文字层用于找疑点，原图用于判断，存疑保留在结构记录中。

- `contract.ts`、`draft.ts`、`markdown-draft.ts`：单一初稿、稳定区块地址、固定初稿 hash；旧 Markdown 必须有唯一且顺序一致的页归属。
- `clean.ts`、`normalize.ts`、`suspects.ts`：记录规则移除内容，比较词和数字的多重集，识别缺失、多出、数值/单位差异与页归属疑点。
- `pdf-pages.ts`：核验 PDF 字节，复用 [页面工具](../browser/pdf-region.ts) 的分类、可见文字提取、页面渲染和局部放大，并缓存固定图像。
- `correction.ts`、`engine.ts`：历史整篇校订格式的构造与回放工具；生产建档不组装旧 corrector 或调用旧 engine，旧调用上限不进入新的页会话。
- `apply.ts`、`render.ts`：验证编辑范围与冲突，确定性生成区块、Markdown、UTF-8 区间和资源闭包。表格编辑必须提供 HTML 表格结构；保留已登记的原表图以支持化学结构等非文字内容核对。格式校验不代表科学内容正确。
- `manual-document.ts`：整份 Markdown 人工保存的区块匹配、拆合历史与锁定快照；未改内容保留身份和来源，页归属显式绑定，原始输入变化拒绝覆盖。
- `service.ts`：按固定格式分派历史稿与整理后 V2 的全文、页图及阅读状态；生产写入由相邻 archive 模块的文本管线和人工编辑边界承担。
- `leaf-corrections.ts`：整理后保留叶块的页内改字、原始坐标映射及本页疑点处置校验。
- `page-service.ts`：每页独立 DSH 会话、本页读取和看图证明、成功页缓存与失败页重跑；只读取整理服务的已接纳快照。
- `page-concurrency.ts`：一份文献内的有界页调度和模型请求准入；限流降低页/请求额度，按服务提示等待；不共享页内容或 DSH 历史。

历史持久化适配见 [校订存储](../storage/proofread.ts)，V2 接纳清单见 [整理文本存储](../storage/archive-text.ts)。章节角色、就绪判断和文献算子不由本目录决定。不存在双解析对齐、候选 A/B 或仲裁兼容入口。

[上级目录](../README.md)

校订块的 basis 仅有 text-layer、image-only、manual，不保存 uncertainty 或片段存疑标记。无法确定保留为疑点处置及其理由；文字页保留初稿，图像页不能转写出的文字如实为空。人工替换与文档编辑仍受锁定和版本检查保护。`service.ts` 提供读取来源计数、文字层页数与最后人工修改的状态投影。

`page-service.ts` 与 `leaf-corrections.ts` 是生产叶块校订路径；新页记录通过现有 ProofreadCache 保存成功检查点，由相邻 archive 文本管线接纳并发布 V2 清单。旧格式只用于历史读取与回放验证，旧写请求不作为新合同别名。两种记录分别解码，不混用。
