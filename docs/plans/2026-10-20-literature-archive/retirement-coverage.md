# 旧路径退役与测试迁移

状态：In progress；此记录不代表最终验收通过。

旧实现专属协议与业务政策退役；通用安全、证据、取消、复用及恢复断言迁入当前路径。六个原测试文件的本轮版本已在本机临时目录保留，供逐项复核。没有以跳过测试或恢复兼容执行器处理错误。

| 原测试文件 | 被替代的行为 | 当前覆盖与剩余工作 |
| --- | --- | --- |
| `knowledge-analysis.test.ts` | 单篇总结由 summary@2 生成，删除旧 artifact/default CAS 协议；DSH 阅读不变量保留。 | processor-reliability、processor-workflow、processor-archive、dsh-document-session；长文 DSH 用例迁移中 |

## knowledge-analysis.test.ts

- keeps the committed artifact when cancellation arrives after publication
- reports default-write failure without losing the committed artifact or leaking the cause
- settles an already committed default write from its SQL result after cancellation
- classifies a default write cancelled before SQLite admission without starting it
- preserves safe AgentFailure reasons and rejects malformed not-applicable responses
- keeps Document, Extraction, Retrieval and legacy cleanup protection usable on the current catalog
- publishes from the maintenance page and reads statements and evidence by ID in the query page
- continues a long evidence segment to its end and rejects a misbound continuation
- uses the Application maintenance and query HTTP boundaries with strict request and response binding
- publishes an exact artifact, reads it through query-only, reuses by method and preserves historical input
- preserves published knowledge across reopening and publishes a fixed partial synthesis
- treats default update as optional CAS and separates method identity
- preserves more than eight valid citations and coalesces repeated segment IDs
- rejects nonexistent evidence even when historical budgets are present
- processes more than 256 short segments without truncating the source
- lets an in-flight query reader settle before its owner closes, then rejects new reads
- uses production Application model binding and adapter identity for reuse
- returns the winner's stored bytes and provenance for concurrent identical methods
- reads every range in one DSH conversation, retains tail/negation and reuses immutable results
- reads the complete tail after 8192 segments
- cancels a DSH continuation before publication and releases the session
- binds a distant condition and result to two original evidence references
- preserves English and Chinese negation without deterministic rewriting

| `knowledge-retrieval.test.ts` | 旧知识表及旧 statement 索引被处理结果投影取代；检索不得读后触发模型。 | result-context-current、processor-workflow、processor-reliability、material-context；损坏来源继续读取用例待补 |

## knowledge-retrieval.test.ts

- counts independent sources per statement across two published Literature records
- keeps healthy knowledge hits when one indexed source loses its published bytes
- pages past more than 32 unavailable indexed sources without losing a healthy hit
- reports a missing document source while paging to a healthy document
- reserves a mixed knowledge and document read budget before opening another file
- rejects a generation changed during source verification and waits for an active read on close
- serves explicit knowledge maintenance and mixed Context through the production graph and HTTP
- pages compact mixed references without losing fixed hits and rejects an unfit first reference
- merges material and generated knowledge with one cursor and preserves the healthy branch
- explicitly indexes verified artifact statements while preserving the prior generation
- preserves populated material, Document, Knowledge and Synthesis facts in a consistent current-format backup
- retains ready generations, rejects malformed entry batches and leaves active unchanged on failed CAS
- repairs corrupt derived knowledge FTS without changing source facts or material Context

| `synthesis-service.test.ts` | 删除知识 artifact 链式综合；多篇输入改为冻结快照加逐篇 map/reduce，不再支持缺失旧 artifact 降级输入。 | processor-snapshot-synthesis、snapshots-service、processor-freshness、processor-interface-parity |

## synthesis-service.test.ts

- parses a complete 128-document preparation result above the old wrapper node cap
- records actual usage without enforcing historical output reservations
- continues past a processed irrelevant document and distinguishes all irrelevant from bad output
- counts two versions and their summary as one Literature independently of model relationship labels
- blocks require-all, publishes an honest 80/100 partial coverage, and reuses the winner
- publishes model paraphrases and reuses them when only deprecated budgets change
- cancels before publication and rejects work after close
- uses a source-only knowledge artifact while reporting the degraded input
- synthesizes 80 distinct literatures and counts only actual independent support
- keeps model-produced dry and wet results with actual source counts and ignores obsolete call limits
- connects fixed selection, CSRF maintenance, and read-only Web
- uses the production Application synthesis binding and closes cleanly

| `literature-content.test.ts` | 删除 LiteratureContent 的生产及与元数据一起提交的流程；事实写入分别由元数据、校订稿和算子拥有。 | metadata-fields、archive-metadata、proofread-document-publication、processor-reliability |

## literature-content.test.ts

- atomically accepts final metadata, content and FTS with frozen revision, canonical bytes and lineage
- rolls back metadata, keywords, content and FTS on transaction failure, and rejects corrupt, stale or cancelled inputs
- preserves reference supports for the same manifest and removes only replaced content support while keeping other evidence
- rejects misbound proposals and protects the immutable input snapshot during asynchronous acceptance
- retains immutable summary input hashes after a metadata edit and does not report stale content as ready

| `literature-cleanup.test.ts` | 删除没有可用总结就清除 PDF/解析的业务政策；失败不撤销原始材料。 | archive-orchestration、archive-recovery、artifact-reclamation、artifact-recovery |

## literature-cleanup.test.ts

- rejects invalid decisions, stale identity, cancelled cleanup and corrupted FTS before any deletion
- preserves shared files and other reference evidence while removing supports belonging to the retired content
- rejects an incomplete outgoing reference closure and concurrent cleanup admits only one transaction
- refuses to retire an Asset-scoped Parser that supports another Literature's current content

| `no-usable-content.test.ts` | 删除分析失败驱动的文献及 Candidate 删除策略；Candidate 与原始材料的保护检查保留。 | artifact-reclamation、artifact-recovery、candidate-publication、write-admission |

## no-usable-content.test.ts

- atomically removes published/pending receipts and candidate, reclaims bytes, and cannot replay after restart
- refuses a no-usable-content cleanup while an exhaustion fact exists and commits the same command after it is cleared
- refuses the lower-level catalog-only cleanup when execution associations need a coordinated decision
- CAS includes execution records and rejects a candidate added after owner preparation
- rejects corrupted execution identity before any current fact or file changes
- preserves candidates and pending receipts for another article sharing the same PDF bytes
- reports committed catalog cleanup separately when physical reclamation fails, and permits exact retry
- finishes committed cleanup when cancellation arrives after the SQL commit
- rejects an owner command that omits or adds execution removals

## 必须完成的迁移核查

- [x] 回收与崩溃恢复：改用独立合成孤儿文件，不再借用已删除的无可用内容流程。定向 6 项通过。
- [x] DSH 图文阅读、伪造引用纠正：改用真正的校订稿，持续会话 8 次调用测试通过。
- [x] 新知识检索：范围、固定结果哈希、证据、跨页插入、只读查询对象图、混合检索；定向 1 个集成场景通过。
- [ ] 长文连续读取、UTF-8、尾部和否定语义、取消、错误用量的独立断言完成迁移。
- [ ] 检索的来源损坏、总读取预算、健康分支与关闭生命周期断言完成迁移。
- [ ] 安装、CLI/MCP/HTTP 和 Web 的旧操作调用全部改为当前合同。
- [ ] 测试 strict 类型检查、最终集中 Full 通过。

[计划入口](README.md)
