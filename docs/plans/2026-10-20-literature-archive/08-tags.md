# 08 标签词表与打标

状态：Partial（9/10；8.3 输入覆盖记录尚未实现，现有标签路径已通过离线定向测试）。执行者：Codex，单独实施。

**Outcome**：

1. 文献库拥有一份**自然增长**的标签词表。每个标签包含：稳定 ID、中英文名、同义词、定义、最多两层的上级、类别和示例。词表的每次变更都会产生新版本，并写入日志。
2. 建档的标签步骤：
   - Agent 先写出主题，系统从词表中检索候选标签，Agent 优先吸附已有标签，确实没有合适的才创建新标签，并必须说明理由；
   - 每篇文献的标签按重要性排序，数量为 1 到上限（配置项，初值为 6）；
   - 每个标签都附有理由和片段证据。
3. 每批文献建档后，整理 Agent 自动执行合并、补上级、归类、修正定义。每次操作都可以撤销。
4. 回溯手动执行。执行前显示候选文献数，执行时合并调用模型。
5. 筛选分两种：按主标签，或按任一标签。上级标签包含其所有下级。如果某个标签创建后还未回溯，筛选时会提示结果可能不全。

**进入条件**：
- 06：打标需要 `abstract`、`introduction`、`conclusion` 等角色；
- 07：打标需要作者关键词。

**责任边界**：
- 本块负责新目录 `apps/server/src/tags/`（含 README），以及：
  - contracts；
  - 存储与迁移；
  - 打标、整理、回溯的 Agent 任务定义；
  - 查询接入（`library-page.ts`）；
  - CLI/MCP。
- 本块不负责：Web 界面，由 11 负责。

## 与现有 `labels` 处理器的区别

- 现有的 `labels` 处理器（`analysis/processor-labels.ts`）的作用是对文献逐篇回答一个给定问题，例如布尔值、字符串或枚举。它产出的是单篇算子的记录，不是标签词表。
- 它继续作为单篇算子保留，只在界面和文档里改称“问答标注”，避免和标签混淆。这项改名在 11 和 12 中完成。

## Tasks

- [x] **8.1 contracts**

  **`Tag`** 的字段：

  | 字段 | 说明 |
  | --- | --- |
  | `tag_id` | 稳定 ID |
  | `name_zh`、`name_en` | 至少一个非空 |
  | `aliases[]` | 同义词 |
  | `definition` | `{includes, excludes}` |
  | `parent_id` | 可空；上级标签不能再有上级 |
  | `category` | 可空，只用于浏览 |
  | `kind` | `topic` 或 `compound` |
  | `status` | `active`，或 `merged`（附 `merged_into`） |
  | `created_vocab_version` | 创建时的词表版本 |
  | `backfilled_vocab_version` | 可空，上次回溯时的词表版本 |
  | `examples[]` | `{literature_id, evidence}` |

  **`TagAssignment`** 的字段：

  | 字段 | 说明 |
  | --- | --- |
  | `literature_id` | 文献 |
  | `items[]` | 每项为 `{tag_id, rank, reason, evidence[], origin: auto \| manual \| backfill, locked}` |
  | `vocab_version` | 打标时的词表版本 |
  | `model` | 模型配置 hash |
  | `assignment_sha256` | 分配结果的 hash |

  **`VocabularyChange`** 的字段：

  | 字段 | 说明 |
  | --- | --- |
  | `version` | 变更后的版本 |
  | `op` | `create`、`merge`、`set-parent`、`set-category`、`edit-definition`、`rename`、`undo` |
  | `payload` | 变更内容 |
  | `inverse` | 撤销所需的数据 |
  | `actor` | `tagging`、`consolidation`、`manual` 或 `backfill` |
  | `reason` | 理由 |
  | `affected_literatures` | 受影响的文献数 |

  不变量：
  - 同一词表中，启用状态的标签不能和其他标签的名称或同义词规范化后相同；
  - 层级深度不超过 2；
  - `merged` 状态的标签不能再被分配。

- [x] **8.2 存储**

  新增标签子系统的 schema 与迁移，包括以下表：
  - `tags`、`tag_aliases`
  - `vocabulary_state`：当前版本号
  - `vocabulary_changes`
  - `literature_tag_assignments`、`literature_tag_items`
  - `tag_search`：基于 FTS，覆盖名称、同义词和定义

  写入要求：
  - 所有修改词表的写入都串行执行，可以通过单一写入事务或队列实现，每次写入版本号加一；
  - 并发打标时，后提交的一方如果遇到名称冲突，返回 `tag-name-conflict`，由 8.3 重新检索后改为吸附。

- [ ] **8.3 打标流程**

  1. **准备输入**：
     - 正文部分的题名；
     - 作者关键词（07）；
     - `abstract`、`introduction`、`conclusion` 章节片段。章节长度有上限，按片段截断，并在结果中记录覆盖情况。
  2. **写出主题**（模型调用 1）：
     - 输出不超过上限的有序主题，每条包含：一句话描述、建议名称、理由、片段 ID；
     - 规则写在系统提示中：
       - 粒度取文章自己会用作主要关键词的那一层，作者关键词是首要参考；
       - 细分主题只有在它是全文主导主题时才可以单独作为标签；
       - 化合物只限主要化合物；
       - 不能用数值、实验条件、试剂、溶剂作为标签；
       - 不能用出版形式、文章性质作为标签。
  3. **检索候选**：对每个主题，用 `tag_search` 按名称、同义词和定义检索前 K 个启用状态的标签（K 是配置项），附带定义和上级。
  4. **吸附或创建**（模型调用 2）：
     - 对每个主题，选出一个候选标签，或者提出新建；
     - 提出新建时，必须逐个说明每个候选为什么不合适，并给出新标签的全部字段：中英文名、同义词、定义、上级（从候选中选或为空）、kind。
  5. **确定性校验**：
     - 数量为 1 到上限；
     - 没有重复；
     - 同时出现某标签及其上级时，只保留下级；
     - 新标签不得与现有名称或同义词重复，重复时改为吸附到现有标签；
     - 上级必须存在，且层级不超过 2；
     - `kind = compound` 的标签，名称或某个同义词必须出现在题名或摘要文本中，否则拒绝；
     - 每个片段 ID 都必须属于本文的校订稿。
  6. **写入**：
     - 新标签写入词表，记为 `create` 变更；
     - 写入分配；
     - 第一个标签为主标签。

  任何一步失败（例如校验后没有剩下任何标签），标签步骤失败，原因代码为 `tags-empty` 或 `tags-invalid`，交给 09 的问题队列。

- [x] **8.4 主要化合物命名规则**

  - 拒绝形如“化合物 2”“compound 3a”的文内编号名称，用正则表达式判断。
  - 化合物代号（例如由大写字母、短横线和数字组成的代号）只能放进同义词，不能作为主名称；主名称必须是正式名称或通用名称。
  - 系列化合物用类别标签，不逐个列出。这条规则写在提示中，没有确定性的判断方法，因此不做校验。

- [x] **8.5 自动整理**

  - **触发**：09 每批建档完成时，调用一次整理。也可以手动触发。
  - **范围**：上次整理之后新建或变更的标签，再加上它们在 `tag_search` 中的近邻。
  - **流程**：整理 Agent 给出操作列表，每项操作都附理由。

  | 操作 | 执行方式 |
  | --- | --- |
  | `merge A → B` | 程序把 A 的名称和同义词并入 B 的同义词，所有分配中的 A 替换为 B（排序保留，重复时去重），A 的状态改为 `merged` |
  | `set-parent` | 校验层级深度后写入，不重新打标 |
  | `set-category` | 直接写入 |
  | `edit-definition` | 写入新定义，然后对带有该标签的文献重新判断是否仍然适用；判断方式见 8.7 第 3 步的合并调用 |

  - 遇到人工锁定的分配或标签时，跳过该操作，并在日志中记为 `skipped-locked`。
  - 每项操作单独记一条变更，并记录 `inverse`。

- [x] **8.6 撤销**

  - 按变更 ID 撤销：执行 `inverse`，并写入一条 `undo` 变更。
  - 如果后续的变更依赖于这次变更（例如合并之后又改了 B 的定义），撤销前必须列出依赖链，由人决定一起撤销还是放弃。
  - 撤销 `merge` 时，恢复 A 的状态，并把合并时替换掉的分配逐条改回。为此，合并时要在 `inverse` 中记录被替换的分配行。

- [x] **8.7 手动回溯**

  - **命令**：对一个或多个标签执行回溯，执行前先做 dry-run。
  - **候选**：在 `created_vocab_version` 之前打标、且尚未对照过该标签的文献中检索：
    - 匹配名称、同义词或定义中的词与题名、摘要、作者关键词；
    - 或带有该标签的上级标签或同类近邻标签的文献。

    `kind = compound` 时，只做名称和同义词的字面匹配。检索不调用模型。
  - **dry-run**：显示候选文献数、预计的模型调用次数和每次调用的批量。
  - **执行**：
    - 按文献分组；
    - 一次调用判断一篇文献与本轮全部相关标签的关系，多篇文献可以合并到同一次调用中，批量是配置项；
    - 输入只包含题名、摘要、作者关键词和现有标签。
  - **写入**：
    - 新分配的 `origin` 为 `backfill`；
    - 标签数超过上限时，由模型对全部标签重新排序，删去排在最后、且未锁定的标签；
    - 写入 `backfilled_vocab_version`。

- [x] **8.8 筛选**

  - `LibraryQuery` 新增 `tags: {ids, mode: "primary" | "any"}`：
    - 同义词解析到标签 ID；
    - `merged` 状态的标签按 `merged_into` 解析；
    - 上级标签展开到所有下级。
  - 结果中附带回溯提示：统计结果集外、在该标签创建之前打标、且尚未被回溯覆盖的文献数。这些文献可能也符合条件，但没有对照过该标签。

- [x] **8.9 人工操作**

  人工可以：
  - 为文献设置有序标签：锁定，`origin` 为 `manual`；
  - 锁定或解锁单个标签；
  - 新建标签；
  - 编辑名称、同义词和定义；
  - 手动合并标签。

  所有人工操作都写入变更日志，`actor` 为 `manual`。

- [x] **8.10 CLI/MCP**

  | 命令 | 功能 |
  | --- | --- |
  | `tags list`、`tags search` | 浏览与搜索，可按类别或层级 |
  | `tags show <id>` | 定义、同义词、示例、使用数、回溯状态 |
  | `tags changes [--since]` | 变更日志 |
  | `tags undo <change>` | 撤销 |
  | `tags consolidate` | 手动触发整理 |
  | `tags backfill <ids> [--dry-run]` | 回溯 |
  | `literature tags <id>`、`literature tags set/lock` | 文献的标签 |

  文献库查询增加 `--tag` 与 `--tag-mode` 参数。MCP 提供对等的工具，说明中写明打标规则与回溯语义。

## 集成与影响

- 新增模型调用：每篇 2 次打标调用；整理和回溯按批次调用。
- 配置项：
  - `tags.max_per_literature`，默认 6；
  - `tags.candidate_k`；
  - `tags.backfill_batch`；
  - 打标、整理、回溯各自的模型任务绑定。
- 词表属于库数据，可以导出为 JSON。仓库只提供格式说明和合成示例。

## 验证

使用 fake 模型的定向测试：

| 场景 | 预期 |
| --- | --- |
| 吸附 | 使用已有标签 |
| 创建 | 词表新增标签 |
| 新建标签与已有同义词重复 | 改为吸附 |
| 化合物标签名不在题名或摘要中 | 拒绝 |
| 文内编号作为名称 | 拒绝 |
| 标签数超过上限 | 截断，或步骤失败 |
| 同时选中上级与下级 | 去重 |
| 层级超过 2 | 拒绝 |
| 两篇文献并发创建同名标签 | 第二篇改为吸附 |

此外还要测试：

- 整理的合并、设置上级、修正定义，以及遇到锁定标签时跳过；
- 撤销，包括依赖链的检查；
- 回溯：dry-run 的计数、合并调用的批量、超过上限时的重排、`backfilled_vocab_version`；
- 筛选：主标签与任一标签、上级展开、`merged` 标签的解析、回溯提示的计数。

最后运行 `pnpm quick` 和相关的 Vitest 测试。

## 退出条件

- 合成文献集可以完成打标；
- 词表能够自然增长；
- 整理、撤销、回溯和筛选全部可用；
- 标签步骤的成功或失败可以交给 09。

## 恢复与交接

- 如果候选检索的质量不足，例如测试中同义标签频繁被重复创建，先在 8.5 的整理中加强合并，并在本块记录现象。不要引入向量库，这超出了 ADR 0034 的范围，需要另立决定。
- 交给 09：
  - 标签步骤入口；
  - 批次结束时的整理入口；
  - 描述版本中的标签 hash（`assignment_sha256`）。
- 交给 10：筛选条件。
- 交给 11：所有读写接口。

[计划入口](README.md)

## 实施证据（2026-10-20）

执行基线：`2ccf2c2` 加当前未提交实现；未执行 Git 提交。

- 8.1、8.4：`contracts/src/tags.ts` 的封闭解析与标签 hash，`tags/rules.ts` 的命名、化合物字面证据、层级、排序和锁定。
- 8.2、8.6：唯一 `schema.ts` 的标签表；`tag-engine.ts` 与 `vocabulary.ts` 事务端口实现版本、别名唯一性、合并分配、逐条逆操作、依赖链与人工修改冲突。没有新增数据库版本或迁移。
- 8.3：`TagService.build` 与共享 DSH 的 topics/select 两步；候选逐项拒绝、新标签同名并发吸附、校订片段校验，提交检查元数据/主 PDF/默认文档/注释是否仍匹配。
- 8.5、8.7：有界分页整理，按模型实际用量统计；定义改变复核已分配文献；先预览后显式回溯，按文献合并候选标签，保留人工锁定，新增回溯证据定位到校订稿中的元数据文本。
- 8.8–8.10：`LibraryQuery.tags`、主标签/任一标签、别名/merged/上级展开、批量 selector 与回溯缺口计数；共享 query/maintenance 边界，CLI `tags` / `literature tags` 与 MCP `tags_query` / `tags_manage`。独立任务绑定及数量配置已接入；用户说明见标签指南。

直接测试：`tags-storage.test.ts` 1 项、`tags-service.test.ts` 8 项、`tags-rules.test.ts` 3 项、`tags-dsh.test.ts` 1 项，分切片共 13 项通过。失败只按名称定向复验，没有重复整组或运行 Full。日志位于本机 `/tmp/sciretriever-archive-implementation-yzz1ycub/`，包括 `tags-storage-check.log`、`tags-service-check.log`、`tags-filter-retest.log`、`tags-rules-check.log`、`tags-concurrency-undo.log`、`tags-dsh-consolidation-check.log`、`tags-dsh-retest.log`、`tags-freshness-check.log`。

静态收口：`pnpm exec eslint`（本块新增文件）、`pnpm exec tsc -b --pretty false`、`pnpm exec tsc -p tsconfig.tests.json --pretty false` 均退出 0；日志分别为 `tags-final-lint.log`、`tags-final-source-types.log`、`tags-final-tests-types.log`。未运行 Quick/Full，遵守 Owner 将耗时整体验收集中在最终的要求。

残余限制：真实标签质量未验证，不以 fake 模型结果推断真实模型效果；自动整理的建档结束钩子交由 09 接入，Web 交由 11。未访问用户配置、真实模型、MinerU 或本地库，4174 服务不动。

## 本轮测试收敛台账核对（2026-10-20）

依据 Owner 本轮仅修 A/B、保留 C 的授权核对；不把第一版实现或历史 Full 当成第二版验收。本轮证据目录：`/tmp/sciretriever-test-convergence-ndZSeC`。

- 8.3：取消勾选。两步 DSH 打标、候选吸附、锁定、证据及并发校验已有实现且 tests 通过；但 Task 要求按片段截断并记录输入覆盖情况，当前 TagService.build 超过 262144 字节直接报 tag-input-limit，且 fallback slice(0,8) 未记录覆盖信息。这部分缺少实现，故整项取消勾选；本轮不新增该功能。

### 本轮结束 Full 证据

结束 Full 中标签服务 8 项、存储 1 项、DSH 1 项及规则 3 项通过；8.3 的覆盖记录缺口仍在。 完整命令、失败分类和收尾后定向结果见[测试收敛记录](test-convergence.md)。本块勾选数不因旧流程测试通过而增加。
