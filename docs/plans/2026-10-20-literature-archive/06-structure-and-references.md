# 06 结构与参考文献

状态：In progress（9/10；角色、图表、引用支持及 CLI/MCP 已有实现与离线证据；6.9 按第二版调整）。执行者：worker。

**Outcome**：

1. 每个部分的校订稿都有一份**结构注释**，内容包括：
   - 每个章节的角色及其来源（规则或模型）；
   - 图表清单：编号、类型、图注片段、所在页。
2. 正文部分的参考文献被解析成有序列表。每一条都指向校订稿中的片段；能够对应到库内文献时，建立关联。
3. 结构注释是否满足就绪条件，可以按“满足或不满足”来判断。

**进入条件**：05 的 5.1、5.2、5.5 已完成。

**责任边界**：
- 本块负责：
  - 结构注释的合同与存储；
  - 角色识别；
  - 图表清单；
  - 参考文献的解析与关联。
- 关联时复用 `literature/` 中的身份规则，本块不新增合并逻辑。
- 本块不负责：标签（08）。

## 版本决定

章节角色**不写入文档表示**，单独保存为**结构注释**，以 `document_version_id` 和注释方法版本为键。

原因是：角色可能由模型识别，识别方法变化时，不应改变文档表示的 hash，也不应让证据引用失效。

09 中的**内容版本**定义为 hash(文档版本 ID, 结构注释 ID)。

## Tasks

- [x] **6.1 角色枚举**（contracts）

  **正文部分**的角色：

  | 角色 | 含义 |
  | --- | --- |
  | `front-matter` | 题名、作者、单位、期刊信息 |
  | `abstract` | 摘要 |
  | `keywords` | 关键词 |
  | `introduction` | 引言 |
  | `methods` | 实验、方法、计算细节 |
  | `results` | 结果 |
  | `discussion` | 讨论 |
  | `results-discussion` | 结果与讨论合并的章节 |
  | `conclusion` | 结论 |
  | `acknowledgements` | 致谢 |
  | `references` | 参考文献 |
  | `appendix` | 附录 |
  | `body` | 不属于以上类别的正文章节，例如“理论模型” |

  **补充材料部分**的角色：

  | 角色 | 含义 |
  | --- | --- |
  | `si-methods` | 补充实验细节 |
  | `si-characterization` | 表征数据与谱图 |
  | `si-computation` | 计算细节 |
  | `si-tables` | 补充表格 |
  | `si-figures` | 补充图 |
  | `si-references` | 补充材料的参考文献 |
  | `body` | 其他章节 |

  `body` 是结构上的通用正文，不代表“无法判断”。每个章节都必须有角色。

- [x] **6.2 规则识别**

  - 维护一份标题词典，覆盖中英文常见写法和编号前缀，例如“0 引言”“1 实验部分”“2.1”“Experimental Section”“Results and Discussion”“结论”“参考文献”“Supporting Information”。
  - 子章节继承父章节的角色，除非自身标题命中了词典。
  - 首个标题之前的区块归入 `front-matter`。如果 `front-matter` 中出现“摘要”或“Abstract”开头的区块，就拆出 `abstract`；“关键词”或“Keywords”开头的区块拆出 `keywords`。
  - 规则版本为 `roles-rules-v1`。

- [x] **6.3 模型补充识别**

  - 规则没有命中、标题又不在词典中的顶层章节，交给模型判断角色。
  - 输入只包括：章节标题、章节首段的前若干字（上限可配置），以及前后章节的角色。
  - 输出必须是 6.1 中的枚举值。
  - 结果记录 `role_source = model`、模型配置和方法版本。
  - 模型调用失败时，该章节使用 `body`，`role_source = fallback`，在注释中记录失败原因。这一处理不阻塞就绪，因为 `body` 本身是合法角色。

- [x] **6.4 图表清单**

  - 从 `image`、`table` 类型的片段以及相邻的 `caption` 片段生成图表清单。
  - 解析图注中的编号，例如“图 2”“Fig. 2”“Table S1”“Scheme 1”。
  - 每一项记录：类型、编号文本、图注片段 ID、对象片段 ID、页码。
  - 无法解析出编号时，只记录片段 ID，不编造编号。

- [x] **6.5 结构注释发布**

  - 新增 `structure_annotations` 表和不可变 JSON 产物。
  - 同一文档版本、同一方法版本，只生成一份注释。
  - 人工可以修正章节角色。修正结果被锁定，并写入新的注释版本。重新识别时，保留人工修正的角色。

- [x] **6.6 参考文献解析**

  1. 从正文部分中角色为 `references` 的章节内，取出 `reference-item` 片段和列表片段。
  2. 切分条目：
     - 优先按编号模式切分，例如 `[1]`、`1.`、`(1)`；
     - 没有编号时按区块边界切分。
  3. 每一条记录：
     - 顺序号；
     - 原文文字；
     - 片段 ID（可以有多个）；
     - 用正则提取出的 DOI（如果有）。
  4. 补充材料中 `si-references` 章节的参考文献单独列出，并标明所属部分。

- [x] **6.7 库内关联**

  对每条参考文献，按以下顺序匹配库内文献：
  1. DOI 精确匹配；
  2. 复用 `literature/identity-rules.ts` 中的现有规则匹配，不新增模糊匹配。

  - 匹配成功的，记录关联和匹配依据；
  - 未匹配的，只保留文本。

- [x] **6.8 参考文献的支持类型**

  ADR 0007 中的 `ContentReferenceTextSupport` 依赖 `LiteratureContent`。本任务新增一种支持类型：`ArchiveReferenceTextSupport`，内容为 `{document_version_id, segment_ids, reference_index}`。
  - 由参考文献产生的引用关系使用这个新类型；
  - 旧类型的数据在 12 中随旧路径一起退役。

  需要在 01 的 ADR 0037 中同时修订 ADR 0007。

> ADR 0037 第二版（2026-10-20）：校订改为“部署 profile 初稿 → 文字层找疑点 → DSH 看原图矫正 → 存疑不阻断就绪”。本块受影响的 Task 已取消勾选并写明调整内容；其余已完成项保留。

- [x] **6.9 就绪判断函数**（第二版调整）

  `structureSatisfied(annotation)` 是一个纯函数。满足以下条件时返回真：

  - 正文部分至少有一个 `body`、`introduction`、`methods`、`results`、`results-discussion` 或 `discussion` 章节；

  参考文献不再是就绪条件：缺失或解析失败时记入问题队列（原因 `references-missing`），不影响就绪（ADR 0037 第二版第 5 节）。真值表测试同步删除参考文献相关组合。勘误、社论、观点或评论类文章不作为文献处理，由 9.2 判定为 `EXCLUDED`，不会走到这一判断（Owner，2026-10-20）。

- [x] **6.10 CLI/MCP**

  | 命令 | 内容 |
  | --- | --- |
  | `document outline` | 输出章节角色与来源 |
  | `document figures` | 图表清单 |
  | `literature references` | 参考文献列表与关联 |
  | 角色修正 | 设置或解除某个章节的角色锁定 |

## 集成与影响

- 新增结构注释表和参考文献表。
- 引用关系的来源从 `LiteratureContent` 迁移到建档。
- 模型调用很少，只用于规则没有命中的标题。

## 验证

- 词典测试：中英文标题和编号格式的正例与反例。
- 模型识别：使用 fake 模型，覆盖合法枚举、非法输出和调用失败。
- 图表编号解析表格测试。
- 参考文献切分：覆盖带编号、不带编号、跨页续接、带 DOI、补充材料参考文献。
- 关联：覆盖 DOI 命中、规则命中和不命中。
- `structureSatisfied` 的真值表测试。
- 运行 `pnpm quick` 及相关 Vitest 用例。

## 退出条件

- 任何 `complete` 状态的校订稿都能得到结构注释与参考文献列表；
- 结构是否满足就绪条件可以直接判定。

## 恢复与交接

- 6.8 依赖 ADR 0007 的修订。如果 GA 时没有包含这一项，先停在 6.7，回到 01 补充。
- 交给 08：`abstract`、`introduction`、`conclusion`、`keywords` 等章节角色，作为打标依据。
- 交给 09：
  - `structureSatisfied`；
  - 结构注释 ID。
- 交给 10：按角色过滤读取。

[计划入口](README.md)

## 2026-10-20 实施证据

执行 patch：HEAD `2ccf2c2` + 当前未提交工作树；不委派、不提交、不访问真实数据/服务。

- 6.1/6.2：`contracts/section-roles.ts` 与 `document/section-rules.ts`；词典、层级继承、段落前缀、人工角色优先。`structure-rules.test.ts` 的 22 项包括非法角色、边界标题和失败 fallback。
- 6.3：`document/section-classifier.ts` 通过唯一 DSH runtime 执行，限定标题/短段落/相邻角色。方法记录可公开模型信息及非秘密配置 hash，完整模型参数/地址不出现在注释中；没有新增 Agent 后端。fake transport 已证明一次分类、重复构建不再调用、未配置模型产生显式 fallback。
- 6.4/6.6/6.9：`structure-extract.ts` 产出图表与有序引用文本（含片段 ID、DOI），以纯函数判定正文结构；补充材料角色独立。产物不声称已经完成库内关联。
- 6.5：`structure-annotation.ts` 中性合同、`document/annotations.ts`、`storage/structure-annotations.ts`、v14 schema/迁移与 worker；不可变 JSON、人工锁定/撤销审计、revision CAS。人工修改和新注释在同一事务提交，并发旧 revision 不能覆盖。不同方法保留锁定；旧注释可读。
- 6.10 部分完成：`document annotate/role/annotation/figures/references` 和 MCP 已接入同一 owner；`document outline` 返回角色/来源，segments 按 roles 过滤且可固定 annotation_id。大型注释/引用文本通过固定 annotation 的有界 UTF-8 JSON 流完整续读；figures 页码对外从 1 起计。`literature references` 的库内关联仍等待 6.7/6.8。
- 当前 Quick：`structure-quick.log` 通过（后续仅增加当前切片接口测试和模型配置 hash；以本轮 Full 为最终验证）。
- `structure-tests-4.log`：3 文件 / 31 项通过，含 Catalog 各版本升级、校订发布/读取与注释流程。
- `structure-direct-final.log`：7 文件，51 项通过/1 项失败；失败来自新迁移测试未初始化 execution/retrieval identity 的合成 fixture，已修复，不改变生产检查。
- 修复后 `structure-new-final.log`：2 文件 / 7 项通过，包括 v13→v14 中断回滚/备份、重开读取、DSH、锁定/撤销/并发、跨修改续读及 CLI/MCP 对等。
- 当前完整验证：`full-structure-v14.log`，尚未得出通过结论。源码快照 `structure-source-manifest.json` 覆盖 890 个活动代码/配置文件，测试期间只维护文档。

剩余：6.7/6.8 的保守库内身份关联、原子关系支持与过期支持清理；6.10 的文献引用列表整合。不能据上述局部测试将本块或全计划标记 Completed。

### 人工角色操作语义复核

- 复核发现手工改角色会顺带重跑未知标题的分类，已改为无模型的手工注释：保留此前自动判断、重算规则/继承，并绑定 base annotation；解除未知角色锁定可明确显示待重新识别，随后 `document annotate` 才调用 DSH。手工与自动方法身份分开，手工 fallback 不会占用后续自动识别的复用键。这是同一注释 owner 的操作来源，未引入第二套文档或 Agent 后端。
- `full-structure-v14.log` 因安装旅程遗漏 `[catalog,13]` 断言中断（退出 130），修复后 `structure-installed-retest.log`：1 文件 / 1 项通过，约 110.5 秒。
- `full-structure-v14-final.log` 已通过安装和大 PDF 场景，但为修复上述人工操作语义而主动中断（退出 130），不是通过的 Full。最新直接检查见 `structure-manual-tests.log` 与 `structure-manual-quick.log`，结果待记录。

- `structure-manual-quick.log`：Quick 通过；`structure-manual-tests.log`：3 文件 / 30 项通过。随后补充非法续读 JSON 的稳定错误转换，`structure-cursor-tests.log`：7 项通过。
- 最终重跑为 `full-structure-v14-reviewed.log`；源码快照 `structure-source-manifest-reviewed.json`，待实际结束后填入统计。此前中断轮次均不能作为通过证据。

### 图表边界待收口

邻接规则还需补测“image → Fig caption → table”：同一 Fig caption 不应再配给后面的 table。已记录并准备修复，尚未应用，6.4 保持未勾选；不把当前基础图表测试当作全部边界已完成。

### v14 已通过的完整回归（后续改动另行验证）

`full-structure-v14-reviewed.log` 退出 0：**301 文件 / 2,204 项通过，零跳过**；Quick、全部 Vitest、最终构建通过，Vitest 耗时 1,008.73 秒。`structure-source-manifest-reviewed.json` 的 890 个活动代码/配置文件复核无变化。未调用真实 Provider/MinerU/模型或真实库，未改变锁文件、定稿原型，未提交 Git。随后继续图表邻接修复及旧补全链清理；这份 Full 仅证明该快照，不等于全计划完成，也不能当作后续源码的 Full。

- 图表边界修复已应用：按显式 Fig/Table/Scheme 标签类型挑选相容的邻接 caption，同一 caption 不再重复分配。`caption-tests.log`：2 文件 / 30 项通过（包含新增的 image→Fig caption→table 回归）。该修改在上面 Full 快照之后，最终集成时仍需完整回归。


### 引用关联开始实施（2026-10-20）

07 的出版形式已接入后，新增 `literature/reference-matching.ts` 的确定性匹配切片：DOI 优先；BibTeX/RIS/CSL 引用在既有解码器能给出完整身份字段时，复用 `identity-rules.ts`。普通引用文本没有 DOI 且不能确定完整标题、作者顺序、年份、出版形式时，保留文本，不能靠近似题名或作者缩写猜测关联。

共享书目解码/导入实现从 `entry/bibliography.ts` 移到 `literature/bibliography-import.ts`，所有活动调用方已改用新位置；不保留旧实现/旧路径转发。构建精确清理器同步移除旧 Entry 的增量输出。`reference-matching-tests.log`：2 文件 / 3 项通过（精确 DOI、歧义、自指、严格后备、缩写不匹配、书目往返）。原子支持存储、当前引用查询、过期支持清理尚未实施，6.7/6.8 仍未勾选。

### v16 引用支持已接入

`literature/archive-references.ts` 负责固定主文档和注释上的保守库内匹配；`storage/sqlite/archive-reference-engine.ts` 用一个事务重验默认版本、注释和目标元数据 CAS，发布首个关系支持并清理该源的旧支持。查询隐藏过期源支持；显式重建清理孤立边，保留其他来源支持。CLI `literature resolve-references --request`、MCP `archive_references` 和 HTTP 共用维护操作。

`reference-slice-tests.log`：3 文件 / 8 项通过，覆盖目标 CAS 回滚、过期支持隐藏/清理、其他来源支持保留、CLI/MCP 对等以及 v15→v16 备份/回滚。`reference-quick.log` 已通过（之后仅追加最后的测试）。对应 6.7/6.8/6.10 的引用切片已实现；按 Owner 最新要求，全计划最终再统一 Full，当前不将本块标为最终验收完成。

## 本轮测试收敛台账核对（2026-10-20）

依据 Owner 本轮仅修 A/B、保留 C 的授权核对；不把第一版实现或历史 Full 当成第二版验收。本轮证据目录：`/tmp/sciretriever-test-convergence-ndZSeC`。

- 6.7：补勾。literature/archive-references.ts、reference-matching.ts 已实现保守 DOI/身份关联；本轮 retained-evidence.json 中 archive-references 与 archive-reference-matching 测试通过。
- 6.8：补勾。archive-reference-engine.ts 与当前 schema.ts 已实现文档版本/片段/序号支持及原子更新；archive-references.test.ts 验证陈旧/伪造支持拒绝与其他来源支持保留。
- 6.10：补勾。document 结构入口及 archive_references / literature resolve-references 已接入 CLI/MCP；structure-annotation.test.ts 与 archive-references.test.ts 的机器入口测试通过。

### 本轮结束 Full 证据

结束 Full 中结构注释 7 项、结构规则 23 项、参考文献 4 项与匹配 2 项通过；第二版不强求参考文献的就绪规则尚待改造。 完整命令、失败分类和收尾后定向结果见[测试收敛记录](test-convergence.md)。本块勾选数不因旧流程测试通过而增加。

## 第二版实施证据（2026-10-21）

基线 `2ccf2c2` 加未提交工作区；本轮 patch 未提交。证据目录 `/tmp/sciretriever-proofread-v2-zgeot7n6/`。structureSatisfied 只判断正文具有正文类章节；参考文献缺失不阻断。调用方与结构测试已移除旧引用数量要求。archive-v2-readiness.log + archive-document-retest.log：结构规则、无参考文献建档、旧 Markdown 单来源及状态真值表通过。

所有 Vitest 均使用 `VITEST_MAX_FORKS=3 VITEST_MIN_FORKS=1` 与显式 1–3 workers。这里只记录受影响的定向验证；筛选未执行的用例不计为通过。本轮未运行 Full、未新增依赖或数据库版本、未转换本机库。
