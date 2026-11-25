# 已有材料与处理结果检索

只读检索已有书目、初稿与校订稿的固定版本及算子结果，并返回可核对的来源。缺少材料或索引时报告缺口，不自动发现、下载、建档或生成总结。

- [index.ts](index.ts) 实现可重建的材料索引。`build()` 强制读源。`refresh()` 按 SQLite 变更日志读取未处理的文献，按来源指纹校验后替换 active 中有变化的条目。`verify()` 显式核验全部来源文字、FTS 及哈希。
- [refresh.ts](refresh.ts)：发布后的后台合并刷新；显式增量刷新与后台重建使用同一持久队列和工作者锁，运行期间的新请求合并到最新源 revision。重建来源进度由 index 的 build 回调提供，活跃索引状态由只读探针派生，队列私有序列不暴露到公开状态。请求先持久化再返回，页面断开不取消已接纳任务；失败可读、可显式重试。进程关闭中断构建，未完成意图保留给下次启动。
- [query.ts](query.ts) 返回书目与固定文档上下文、来源证据和分页。相关度分页抵达前 1,000 条的末尾时结束。实际截断时返回 `relevance_limit: 1000`。正文命中的 `text_level` 来自已核验的固定版本。
- [knowledge-query.ts](knowledge-query.ts)：当前混合上下文（schema 3）。先保留材料检索排序，再读取算子结果；材料落后时仍交付可核实的命中、缺口与续页，混合游标贯穿两分支核对 active 状态。结果按固定 ID 顺序续读，使用结果 ID、内容哈希和记录 ID，不读取旧知识 artifact。
- [storage.ts](storage.ts)：离线检索存储适配。结果检索复用 [storage/processor-results.ts](../storage/processor-results.ts) 的投影、固定字节校验与证据解析，不维护第二份知识索引。
- [model.ts](model.ts)：共享的检索错误与评分标识；索引服务直接引用此模块，避免仅为错误类型加载离线 SQLite 适配器，使无库 CLI 查询的 JSON 错误输出保持干净。

**译文与中日韩文字（文档规格 9.7）**：主 PDF 默认校订稿在当前内容版本、配置的 `[translation].target_language` 下的已存译文，每个已译单元进一条 `document` 条目（按块分片），范围、章节与序号取原文单元的，另记 `translation_language` 与 `translation_sha256`（译文文件的 sha256）。来源指纹多一种 `translation` 印记，与条目反推的印记逐项对应；`document_translations` 与 `structure_annotation_current` 的写入由触发器记进变更日志，增量刷新据此增删条目，不依赖写入方的应用代码。命中译文时结果带 `matched: "translation"` 与 `language`，`text` 是译文，`reference` 与 `evidence` 仍是原文单元；同一单元原文与译文都命中时只留一条，按原文显示，分数取两者中较好的。译文文件换了而索引未刷新时，该命中以 `index-stale` 缺口跳过。全部索引文字由 `literature/unicode-casefold.ts` 的 `ftsIndexText` 规则 `cjk-char-v1` 写出：汉字、假名、谚文各成一个词，被标点隔开的两段之间写一个查询里不会出现的私用字符；查询里连续的这类字是一个短语（`ftsMatchQuery`）。generation 记 `text_rule` 与 `translation_language`，与当前规则或配置不同时读出为 `index-stale`（`state().rule_current`），增量刷新不改变它，只有显式重建（`maintenance rebuild-index`）才恢复。索引状态（`readIndexRefreshStatus` 与 `IndexRefreshService.status`，HTTP、CLI、MCP 同一合同）另有 `rule_current` 与 `rule_reason`（`text-rule` 或 `translation-language`，一致时为 null；旧代两项为空时按 `text-rule`，没有 active 时两项都不出现），以及 `library_search_rule_current`：书目检索行是否已按当前规则重写。

分页游标绑定查询和范围，算子结果分页冻结开始时的发布范围。读取预算限制最终 JSON 大小与核验字节；来源损坏报告缺口，已有可靠分支保留。原始事实分别归 Literature、Document 和 Analysis 所有。

索引构建使用独立 generation 锁串行化同一 catalog 的构建者。扫描与文件核验在业务写入 admission 之外进行，通过共享 worker 分批提交。锁顺序为 generation → catalog。整代重建检查 source revision。增量刷新固定本轮日志尾，按篇核对待接纳的指纹，每批同步提交索引内容和日志位置，末批同时推进来源修订。来源在批内改变时从已提交位置继续；已入索引的相同指纹可以直接略过。损坏由显式验证和重建处理。

整代发布后与下次增量刷新先分批回收非 active 的 ready/building 代；清空条目与 FTS 后才删代头，每批重读 active 并释放 catalog admission，取消后可续清，不自动 VACUUM。查询将 active 身份和 FTS 候选放在同一 SQLite 快照，结果组装后再核对身份；退役状态和旧游标返回需重新查询，不读取部分回收的旧代。

没有就绪代为 `index-unavailable`；源版本与 active 不同时以 `index-stale` 返回仍可验证的命中、缺口与续页，过时来源跳过后继续取有效项。游标固定代、水位及条目变更标记，增量接纳中也会失效。`refresh.ts` 的 Application owner 在启动、状态读取及周期监测时以标量检查发现落后，复用持久合并队列；只读查询不启动刷新。读取检查身份、ready、源版本与已知损坏标记，`data_version` 变化不重算全库哈希。完整健康检查仅在显式维护、备份/恢复和迁移边界执行。

[上级目录](../README.md)
