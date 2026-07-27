# 产品决策追踪

本文是 2026-07-23 产品讨论及后续 owner 决策的非规范性追踪表，用于证明 owner 的细粒度选择已经进入活动真相源。accepted ADR 保存决策授权和边界，[需求规格](../../architecture/requirements.md)、[系统设计](../../architecture/system-design.md)和[技术架构](../../architecture/technical-architecture.md)从不同侧面定义理想产品；[产品提案](literature-library-product.md)只提供方向背景，[实施进度](implementation-progress.md)只记录实现覆盖。当时的实施顺序由 OMO 执行计划管理，该计划不作为项目文档保留。本文不独立定义行为、重复授权能力或描述当前实现。

初始来源是本地会话导出 `lit.json`，session `ses_077a0787affespmLO6Unc3oh5I`。导出包含凭据无关但体量较大的完整对话和工具记录，不进入仓库。下面的 `message` 是该导出 `messages` 数组的稳定索引；问答工具结果也按其所属 assistant message 索引记录。导出后的决定使用日期和会话主题记录，不虚构旧导出中的 message 索引。

## 决策映射

| message | 主题 | owner 确认或最终处置 | 权威位置 |
|---:|---|---|---|
| 400 | 产品中心与总流程 | 文献库为中心；metadata 清洗去重入库，再按需 download、fulltext LLM、原子更新 metadata/Markdown/references/tags；引用扩展复用同一流水线 | requirements FR-1、FR-10、FR-15、FR-17；system design B.2-B.6 |
| 403 | 文献与版本 | 一个 Work 多个书目版本；主记录使用内部规范 Publisher/Venue，不把 metadata provider 当权威命名 | requirements FR-1、FR-5、FR-6 |
| 404 | 来源保存 | 日常使用 canonical 值，后台保留 observations；LLM 只从允许名称/ID 中选择 | requirements FR-5、FR-6 |
| 405 | light Markdown | 固定核心 section，加受控可选/灵活内部结构 | requirements FR-14 |
| 406 | 输出语言 | 跟随论文原文，尽量沿用原文术语，不自由发挥或自动翻译 | requirements FR-13、FR-14 |
| 407 | 引用方向 | 默认 references，可切换 cited-by 或 both | requirements FR-17 |
| 408 | fulltext 更新 | 不增加置信度工作流；当前 fulltext LLM 结果按结构直接更新 | requirements FR-4、FR-15 |
| 409 | 标签来源 | LLM 标签和人工标签并存；LLM 优先复用已有标签 | requirements FR-8、FR-15 |
| 410 | 标签结构 | 扁平、自增长、用于检索，不建主观层级 | requirements FR-8 |
| 411-412 | 处理层级与补全 | 普通 search 有 metadata/download/analyze；download 与 analyze 是独立 backfill | requirements FR-10、FR-18 |
| 413 | preferred version | 正式出版版优先 | requirements FR-1 |
| 414、417 | 作者 | 采用独立 Author/Authorship 渐进方案；ORCID/明确证据合并，歧义保持分离 | requirements FR-7 |
| 418 | 核心对象 | Work、WorkVersion、Asset、Author/Authorship、Publisher/Venue、observations、references、LightDocument、tags | requirements FR-1-FR-8、FR-13-FR-16 |
| 419 | metadata providers | 查询多个启用来源并合并 | requirements FR-9 |
| 420 | 去重 | 不使用 LLM；有 DOI/稳定 ID 按标识符，无 DOI 按 exact normalized title | requirements FR-2 |
| 421 | 本地搜索 | 首版关键词搜索加字段过滤，vector semantic search 延后 | requirements FR-18 |
| 422 | 三组流程 | 常规发现、引用扩展、数据库维护为首版核心操作 | product proposal sections 3、4、6 |
| 423-424 | Abstract | 优先完整抽取全文原始 Abstract；全文没有时才按原语言生成 | requirements FR-13 |
| 425 | Data/Materials | 不强制表格；LLM 按内容尽量结构化 | requirements FR-14 |
| 426 | reference export | light Markdown 默认不含完整 references，显式选项追加/导出 | requirements FR-14、FR-18 |
| 427-428 | 重新分析 | 不保留历史；旁路构建完整新 payload，成功后整体原子覆盖 | requirements FR-15 |
| 429 | 全文资产（后续修正） | 原回答确认 PDF 优先、XML/HTML 可选；随后形成的 XML-first 分析解释已被 owner 后续修正取代。当前决策是 PDF 为 analyze 必需且权威的基准，XML/HTML 只补充，不能覆盖 PDF 或独立完成分析 | requirements FR-3、FR-10、FR-13；system design B.5；execution plan WP4 |
| 430 | Markdown metadata | metadata 是正文 section，不使用 YAML front matter | requirements FR-14 |
| 431 | 运行方式 | 前台 CLI，Ctrl+C 合作停止，重跑幂等补全 | ADR 0002 decision 5；requirements FR-18 |
| 432 | 多轮 expansion | 所有层包括最后一层都完成 metadata、download、analyze | requirements FR-17 |
| 433 | expansion 限制 | 只限制 depth，不设 product-level 文献数量上限 | requirements FR-17 |
| 434 | 出版状态 | 首版 canonical metadata 只增加 open-access status，不建 license/retraction/correction 模型 | requirements FR-4 |
| 435 | placeholder 合并 | configured provider precedence，后续来源只补缺失字段 | requirements FR-5、FR-9 |
| 436、438 | 全文来源 | 官方/出版社/OA/配置 Sci-Hub 同层进程内竞速 | requirements FR-11 |
| 439 | 网页回退 | translator 后再 browser | requirements FR-11 |
| 440 | 失败展示 | 一个 overall reason/action，加可展开脱敏 per-source details | requirements FR-12 |
| 441 | 标签语言 | 英文 canonical name，加多语言 aliases | requirements FR-8 |
| 442-443 | unresolved reference | 不创建猜测 Work；保留原始引用等待后续匹配 | requirements FR-16 |
| 444-445 | CLI | `search/expand/download/analyze/library/failures/config check`；download/analyze 支持 ID/query/filter/tag/all selectors，无选择器时不隐式处理全库；export 只有显式选项才追加 references | requirements FR-18 |
| 446 | TOML 与 secret | 统一 strict TOML 管理 catalog/assets、defaults、metadata/acquisition、LLM、formats 和 browser profile；secret 可直写或引用环境变量；CLI 只覆盖当前 invocation；`config check` 检查未知字段、目录权限及已启用能力所需配置 | requirements FR-19 |
| 447 | search limit 与进度 | limit 内置默认 100，TOML 可配置，CLI 可覆盖；前台统一报告 provider、去重、新建/复用、下载和分析的适用计数 | requirements FR-9、FR-18、FR-19 |
| 448 | 实施入口 | 先只读盘点当前代码，再按保留/简化/删除/缺失分类 | execution plan WP0 |

## 后续 owner 决策

| 日期/来源 | 主题 | owner 确认或最终处置 | 权威位置 |
|---|---|---|---|
| 2026-07-24 / WP3 三方方案对比会话 | 第一层全文获取调度 | 采用两级调度：providers 有界竞速；每个 provider 内对去重候选按确定性顺序逐个执行和回退；不把全部候选扁平化为无界竞速 | requirements FR-11；system design Acquisition 流；technical architecture 前台运行模型；execution plan WP3 |
| 2026-07-24 / WP4 PDF parser 对比与服务模式会话 | PDF parser 与运行所有权 | 采用 pinned MinerU 3.4.4 `vlm-engine` 作为 WP4 primary parser，通过 operator-managed persistent `mineru-api` 的 local/remote connection 使用；SciRetriever 不启停或拥有服务，async task 只作 processing attempt，result 必须经过通用 schema/resource/PDF evidence validation | ADR 0003；requirements FR-13/FR-19；system design 分析流；technical architecture；execution plan WP4 |

## 覆盖规则

- 对话中的探索性建议不自动成为决策；后续 owner 选择或纠正覆盖前文。例如 message 420 的 owner 回答否决 LLM 去重，message 427-428 否决分析历史，message 436/438 撤回顺序全文 provider 建议并恢复同层竞速。
- `lit.json` 导出后的 owner correction 明确取代 message 429 后形成的 XML-first 解释：PDF 同时是保存、阅读、导出和分析基准；XML/HTML 只是补充。该修正不回写历史回答，而在本表和权威 specs 中显式记录 supersession。
- “导入/入库”在本轮讨论中指 metadata 候选规范化、去重并创建或更新 placeholder Work/WorkVersion，不等于已批准 BibTeX、RIS、Zotero library 或任意本地目录导入。新增外部导入类型需要另行确认输入契约、去重、资产验证和失败语义。
- 本表发现新的遗漏时，先更新 requirements/system design，再更新本表指向；不得把本表本身当作实现规格。
