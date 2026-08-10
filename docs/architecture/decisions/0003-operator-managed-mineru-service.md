# ADR 0003：Operator-managed MinerU PDF parser adapter

- Status: Accepted
- Date: 2026-07-24
- Revised: 2026-08-07
- Supersedes: none
- Superseded by: none
- Amended by: [ADR 0008](0008-summarized-markdown-literature-content.md)、[ADR 0010](0010-parser-neutral-markdown-current-result.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[MinerU 注意事项](../../notes/mineru.md)

## 背景

产品需要把受支持文献资产解析为轻结构化文档。解析器是满足该需求的外部技术能力，不是产品需求的一部分，也不应决定文献数据库的通用内容合同。

当前 PDF 解析实现选择 MinerU。其模型加载和 GPU 资源适合由独立运行环境长期管理，而不是由每次 SciRetriever 调用负责启动和回收。

## 决策

1. MinerU 是当前 PDF parser adapter 使用的实现能力，不是 SciRetriever 唯一允许的解析器，也不意味着所有受支持文献资产都必须是 PDF。
2. MinerU 服务由 operator 独立部署和管理。SciRetriever 不负责启动、停止、升级、扩缩容或拥有该服务、GPU、模型和任务保留策略。
3. 外部 parser service 只是一个由 SciRetriever 调用的 capability，不是 SciRetriever 的产品服务、任务中心或工作流所有者，也不改变单机产品边界。
4. Parser adapter 负责把已验收资产提交给外部能力，并按 [ADR 0010](0010-parser-neutral-markdown-current-result.md) 把私有输出转换为以不可变 Markdown artifact 为核心的 parser-neutral `ParserResult`，不直接产生 `LiteratureContent`。
5. 外部任务 ID 只能作为一次解析尝试的恢复和诊断信息，不能成为文献状态、产品导航或通用后台任务模型。
6. MinerU 返回的 URL、归档、JSON、文本、图片和坐标均是不可信外部输入。只有经过协议、资源、路径、schema、页数、Markdown 和输入对齐验证的结果才能形成当前 ParserResult；私有 JSON、坐标和未引用文件只是过程数据。
7. 解析结果必须记录输入资产 hash、parser/service identity、模型或后端身份和必要参数，保留 Markdown 实际引用资源及其 hash，并通过 ParserResult hash 建立资产级 lineage；当前合同不建立 block/bbox/source-locator 图。
8. 解析完成只表示产生了可供 LLM 使用的有效 `ParserResult`。实际内容判断、总结型 Markdown 草稿、`LiteratureContent`、临时 `ReferenceLookup`、权威 `Reference` 和最终元数据提案均不由 MinerU 拥有。
9. 具体 MinerU 版本、API endpoint、timeout、认证和部署限制属于当前实现与外部事实，记录在配置、测试和 [MinerU 注意事项](../../notes/mineru.md)，不写成永久产品需求。

## 后果

- 更换 MinerU 版本、模型或部署方式时，需要重新验证 adapter 和代表性解析样本，但不改变核心文献工作流。
- 未来可以增加 XML、HTML 或其它格式的 parser adapter，只要它们产生 ADR 0010 定义的同一类 parser-neutral Markdown `ParserResult`。
- 外部服务失败时，已保存资产和其它文献结果保持有效，用户可以在服务恢复后重新解析。
- MinerU 的服务任务状态不能扩展成通用 SciRetriever job 系统。

## 需要新 ADR 的变化

以下变化需要新的 owner 决策：

- 让 SciRetriever 自己拥有和运维长期运行的 parser service；
- 让某个 parser 的私有输出直接成为文献数据库公共合同；
- 取消对外部 parser 输出的本地验证或 provenance；
- 把外部 parser task 变成产品级任务状态。
