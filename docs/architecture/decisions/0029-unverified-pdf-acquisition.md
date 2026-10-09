# ADR 0029：PDF 下载不执行文章身份验收

- Status: Accepted
- Date: 2026-10-04
- Amends: [ADR 0015](0015-publisher-aware-tiered-pdf-acquisition.md)、[ADR 0023](0023-generic-browser-agent-executor.md)
- Related: [产品需求](../requirements.md)、[材料获取技术文档](../technical/03-literature-materials.md)、[PDF 获取指南](../../guides/pdf-acquisition.md)

> 后续实现：2026-10-08 的显式解析身份核验及 v9 存储合同见[文档与证据技术文档](../technical/04-document-evidence.md#解析后的文章身份核验2026-10-08-实现合同)。本 ADR 保留当时范围和下载非阻断原则；不把后续实现另立为新的产品决策。

## 背景

真实 Browser 测试中，Science、ACM、Annual Reviews 已经交付完整且可读取的 PDF，但首页 DOI
缺失、排版空格和文本提取的去连字符行为使旧文章身份门返回 uncertain，候选被丢弃并最终报告下载超时。
按出版社增加规则不能实现通用下载。Owner 于本日确认：下载阶段取消文章身份校验，PDF 标记为
“文章身份未验证”；后续可在解析阶段检验，不能妨碍当前阶段的下载和运行。

## 决策

1. Public、API、Browser 和人工接纳使用同一下载验收原则：验证实际文件为非空、标准 reader
   可读取且至少一页的 PDF。取消下载阶段的 DOI、arXiv、标题、作者、版本或正文内容身份门槛，
   不提取 PDF 文字进行文章匹配，不因缺少文献标识符、扫描件或排版差异拒绝有效 PDF。
2. Browser Agent 仍依据目标元数据访问文章并选择正文 PDF；API/Public 仍使用本次任务的获取线索。
   文件必须关联本次文献任务。任务归属、当前 metadata snapshot/CAS、取消、字节/hash、大小限制、
   不可变发布、唯一 primary-pdf 和 provenance 约束保留。任务绑定不声称内容身份已验证。
3. 有效文件通过正常 Candidate → publication → primary-pdf 路径入库，形成 `ASSET_READY`。
   新的持久 publication intent 使用 `identity: "unverified"`。`LiteratureAssetView` 新增
   `article_identity_status`：PDF 为 `"unverified"`，非 PDF 为 `null`；工作台明确展示
   “文章身份未验证”。Workbench candidate 的 accepted 只表示文件检查通过，不表示文章/版本身份确认。
4. 文章身份检验属于后续解析阶段可以增加的独立能力。本次不实现新的 DOI 规则、全文/OCR 或模型
   校验器，不提前增加 verified/mismatch 状态或写入入口。解析完成本身不代表身份检验完成，标签
   继续保持 unverified；标签不阻断解析等现有后续处理，也不触发自动重新下载或删除已提交材料。
5. 将来增加解析阶段检验时，由 Parsing 形成与原始 asset hash、目标文献及元数据版本绑定的证据，
   Literature 接纳文章关联判断；不能修改原始 PDF 字节或通过 Storage 自行决定身份。

## 兼容性与事实所有权

现阶段没有独立的解析身份检验事实，因此详情标签是“尚无该项检验”的读取投影，不增加第二套
文献状态或数据库列。新 acquisition 回执明确持久化 unverified。旧快照缺少详情标签时正常读取，
保守补为 unverified；旧回执的 `identity: "accepted"` 保留读取和幂等恢复能力，不把旧首页规则的
结论宣称为解析阶段已经验证。已导出的 `judgeIdentity` 仅保留为 deprecated 旧工具，不参与下载。

无需 catalog schema 迁移，不改写历史回执或资产。`primary_pdf_status: "verified"` 等已有文件读取
完整性反馈仍只表示字节/hash 可验证，与新的文章身份标签含义不同。今后实际实现解析身份检验时，
再定义其持久事实和更新合同，不提前引入空状态机。

## 代价与验收

下载阶段不再阻止 Agent 误选的补充材料或其它文章；目标选择依赖获取流程，来源与任务绑定提供追溯。
这是明确接受的取舍，不能用新的隐式身份规则恢复旧门槛。

验收须覆盖无 DOI、无可提取文字、排版差异、不同内容标识符等有效 PDF 正常入库并保留未验证标签；
非 PDF、损坏文件、任务混入、CAS 冲突和覆盖冲突仍拒绝；重启、回执重放与后续解析不丢失标签或
伪造已验证状态。真实文献验证独立于仅使用合成材料的 Harness。
