# 独立文献库阅读

类型：指南
负责：文献搜索、详情阅读与上下文检索操作
状态：现行

本指南说明已保存材料的读取；页面布局与阅读操作见[Web 指南](web-workbench.md)。查询不启动发现、获取、解析、建档、模型或任务，缺口由调用方另行处理。

## 启动

TypeScript 的独立只读入口使用与 CLI 相同的用户配置身份：

```ts
import { homedir } from "node:os";
import { startQueryOnlyWorkbench } from "@sciretriever/server";

const reader = await startQueryOnlyWorkbench({ home: homedir() });
console.log(`SciRetriever 文献库：${reader.origin}`);

// 保持当前进程提供服务，收到 Ctrl+C 或终止信号后关闭只读资源。
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await reader.close();
```

独立入口监听本机 loopback，返回实际 `origin`，使用随包 React 资源与受限查询能力；它不是正式对外 Web 服务的替代启动模式。正式 Web 的启动和认证见[Web 指南](web-workbench.md)。

## 就绪与只读边界

`GET /api/v1/query/status` 返回 `ready`、`not-initialized` 或 `unavailable`。查询只读打开当前受支持的 catalog，不创建库、不升级结构、不恢复任务、不修复索引；可能存在 SQLite 的 WAL/SHM 协调文件，但业务事实不因此改变。当前布局及恢复方法见[初始化指南](upgrade.md)。

`POST /api/v1/query/search|read|references|reference|artifact` 使用 `protocol_version:1` 封套。缺 PDF 或全文返回明确 gap；索引错误不伪装为零命中。`query.discovery_run_ids` 可限定已有发现批次中的具体 Literature，普通查询不会顺便纳入同一 Meta 的其它版本。

无需 HTTP 时可调用 `createQueryApplication(home)`，先检查 readiness，再使用 `query.search/counts/detail/references/referenceDetail`、`documentRead`、`literatureArtifacts`、`context`、`knowledgeContext`、`processorRead` 及其它只读端口；结束时 `await close()`。关闭失败仍尝试关闭其余资源。实际端口与失败语义见[查询技术合同](../architecture/technical/06-retrieval-context.md)。

## 固定版本阅读与证据

`documentRead.default/describe/outline/segments/resources/slice/resource/materialEvidence/resolveEvidence` 提供固定版本的有界读取。通过 `literatureArtifacts.withArtifact` 取得校验后的原始文件。完整章节、片段或资源需要按返回的 continuation 续读，不能把第一页当作全文。

例如读取固定章节，发送至 `/api/v1/query/document-slice`：

```json
{
  "protocol_version": 1,
  "request": {
    "document_version_id": "00000000-0000-0000-0000-000000000001",
    "selector": { "kind": "section", "section_id": "s1" },
    "max_bytes": 8192,
    "continuation": null
  }
}
```

占位 ID 必须替换为库中固定版本。证据绑定文档、表示和片段 hash；资源只从已登记的资源闭包读取。校订稿可以提供页码/区域，具体材料缺少定位时返回能力缺口，不推测坐标。各字段、大小上限和校验规则见[文档读取合同](../architecture/technical/04-document-evidence.md#3-可读表示与有界读取)。校订对照与原始解析使用[文档处理指南](document-processing.md)的独立入口。

## 上下文检索

`context.search` 检索已有元数据和文档；`knowledgeContext.search` 合并材料与处理器结果。对应 HTTP 为 `/api/v1/query/context` 与 `/api/v1/query/knowledge-context`，CLI/MCP 入口见[Agent 接口](agent-interface.md)。请求固定 scope、kinds、versions、budget，续页原样带回 continuation；无 tokenizer 时不接受 token_limit。

材料索引缺失、过时或损坏会分别报告 `index-unavailable`、`index-stale`、`index-corrupt`。材料与混合知识上下文在索引过时时都继续返回可核实的命中和续页，混合结果也保留已核验的算子结果；部分最新内容可能暂时搜不到，来源已变化的命中在 gaps 说明后跳过。长驻工作台自动追赶，只读 CLI/MCP 本身不刷新；CLI 文本模式会提示落后，`--json` 保持机器回执。损坏回执给出 rebuild-index 维护提示。搜索前只做轻量身份和版本检查，不做全库健康扫描。用 `sciretriever maintenance verify-index --json` 显式核验全部索引文字、倒排和来源，或执行 `sciretriever maintenance rebuild-index --json` 完整重建材料投影；结果索引维护由[处理器入口](knowledge-processors.md)提供。查询不会调用修复。水位、游标与刷新触发见[材料合同](../architecture/technical/06-retrieval-context.md#49-材料-context-的实现边界)，混合覆盖与分页见[知识上下文](../architecture/technical/06-retrieval-context.md#410-处理器结果与混合-context)。

建档发布会将全文索引按篇增量刷新排队，元数据仍在全文检索范围内，固定全文与建档完成无需等待。`sciretriever maintenance index-status` 可查看索引是否存在/已知损坏、队列状态、当前或最近操作，以及重建的来源进度。需要手动追赶时运行 `sciretriever maintenance refresh-index --json`，它等待增量刷新结算；需要完整重建时使用上述重建命令。Web/MCP 可将重建放到后台，接纳后关闭页面仍继续；同步命令的行为保留。各字段含义、HTTP/MCP 请求与进度边界统一见[后台调度与状态](../architecture/technical/06-retrieval-context.md#49-材料-context-的实现边界)。

## 读取知识与准备外部提取

总结和综合通过 `processorRead` 读取固定结果、记录、证据及导出；没有单独的旧 KnowledgeArtifact 分析/默认指针接口。操作示例见[知识加工指南](knowledge-processors.md)。

`extractionPreparation.prepare({spec,inputs})` 只读准备调用方规范及输入，不创建提取任务。显式候选交付与长期保留是维护操作，规范与请求见[知识加工合同](../architecture/technical/05-knowledge-processing.md#4-调用方规范与提取交付)和[Agent 接口](agent-interface.md)。读取不能为补齐材料调用维护。

## 文本等级与校订范围

文献库条目带主 PDF 默认文本的 `text_level`；默认文本是初稿时另有 `draft_facts`（差异片段数、差异条数、扫描页数、被结果引用数、找不到的引用数）。`LibraryQuery` 可按 `text_levels`、`has_draft_differences`、`has_image_only_pages`、`cited_by_results`、`has_unfound_citations` 筛选，`LibrarySort` 增加 `draft-differences-desc`、`image-only-pages-desc`、`citing-results-desc`、`unfound-citations-desc`。没有值的文献排在最后。后两项事实在加工能读取初稿之前恒为 0。筛选结果可以作为建档或补形成初稿的范围。语义见[查询技术篇 2.1.7](../architecture/technical/06-retrieval-context.md#217-文本等级与选择校订范围的事实)。

## CLI 查询与导出

`literature search/show/references/cited-by` 和 `export metadata/pdf/content` 使用查询组装。未初始化或不可用库返回明确错误；需要新增事实时另行导入或维护。导出按显式目标写出副本，不修改库内原件。查询结果、任务完成标志与模型科学质量是不同事实。

入库批次与范围词频也走 JSON 请求：`library batches` 列出批次或读取单个批次，`library batch-rename` 改名或恢复默认名，`library facets` 统计一组筛选结果里最常见的作者关键词和主题词。MCP 对应 `intake_batches`、`intake_batch_rename`、`library_facets`；改名需要维护模式，其余在默认只读模式即可用。筛选条件 `intake_batch_ids`、`subject_terms` 与其它 `LibraryQuery` 字段一起使用，见 [technical/06 §2.1.1](../architecture/technical/06-retrieval-context.md#211-libraryquery)。
