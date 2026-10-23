# 07 元数据：出版形式、文章性质与字段来源

状态：Completed（9/9；当前 schema、字段、接口与一次性转换的合成验证完成；真实库操作留在 12/GR）。执行者：Codex，单独实施。

**Outcome**：

1. `LiteratureMetadata` 不再使用 `document_type`，改为两个封闭枚举字段：`publication_form`（出版形式）和 `article_kind`（文章性质）。
   - 数据源原始的类型字符串保留在 observation 中。
   - 现有库数据通过确定性映射完成迁移。
2. 已接纳元数据的每个字段都能说明来源：权威来源、校订稿或人工。来源之间不一致时，标记为冲突；人工确认的字段被锁定。
3. 建档的元数据步骤：Agent 阅读正文部分的 `front-matter`、`abstract`、`keywords` 片段，给出逐字段提议并附片段证据，再由确定性规则按字段优先级裁决。
4. 文献库查询、CLI、MCP 都改用新字段筛选。

**进入条件**：

- GA；
- 7.5 需要 05 和 06（读取 `front-matter` 片段）；
- 7.1–7.4、7.6、7.7 可以与 03–06 并行。

**责任边界**：

- 本块负责：
  - `packages/contracts` 的元数据与查询类型；
  - `literature/metadata-rules.ts`；
  - `providers/*/metadata.ts` 中的类型映射；
  - catalog schema 迁移；
  - `storage/sqlite/library-page.ts`；
  - CLI/MCP 的查询参数；
  - 建档的元数据步骤。
- 本块不负责：Web 筛选界面，由 11 负责。

## 现状

- `LiteratureMetadata.document_type: string | null`。各数据源写入的值来自不同体系：
  - OpenAlex 的 `type`；
  - arXiv 固定为 `preprint`；
  - RIS 映射为 Crossref 风格；
  - Semantic Scholar 与部分 Europe PMC 接口为空。
- `metadata_observations` 保存各个来源的观测；`projectMetadata` 把观测投影为已接纳元数据；用户观测（user observation）已经存在。
- 旧的分析流程中，`mergeMetadataProposal` 的规则是：只要初始值非空，就优先采用初始值。LLM 的提议只用来补齐空字段。
- `version_role` 已经区分 published、accepted-manuscript、preprint。

## Tasks

- [x] **7.1 contracts**
  - `LiteratureMetadata`：
    - 删除 `document_type`；
    - 新增 `publication_form`：`journal-article | conference-paper | book-or-chapter | thesis | patent | report-or-standard | dataset | null`；
    - 新增 `article_kind`：`research-article | review | letter-or-communication | perspective-or-commentary | correction-or-editorial | null`。
      - 其中 `perspective-or-commentary` 和 `correction-or-editorial` 两类不作为文献处理，由 9.2 判定为 `EXCLUDED`（Owner，2026-10-20）；
      - 保留这两个枚举值，是为了记录排除的原因，并允许人工改判。
  - `LibraryQuery`：`document_types` 改为 `publication_forms` 与 `article_kinds`。
  - 中文显示名集中定义在 contracts 中的一张映射表里，Web 和 CLI 共用。
  - 观测（provider observation）保留原始字符串字段 `source_type`，并新增映射后的两个字段，可以为空。

- [x] **7.2 来源类型映射**

  在 `literature/metadata-rules.ts` 中实现 `mapSourceType(provider, raw) → {publication_form, article_kind_hint, version_role_hint}`，用表格测试覆盖下列来源：

  | 来源           | 原始值示例                                        | 映射                                                    |
  | -------------- | ------------------------------------------------- | ------------------------------------------------------- |
  | Crossref / RIS | `journal-article`                                 | 期刊论文                                                |
  | Crossref / RIS | `proceedings-article`                             | 会议论文                                                |
  | Crossref / RIS | `book`、`book-chapter`                            | 书籍或书籍章节                                          |
  | Crossref / RIS | `dissertation`                                    | 学位论文                                                |
  | Crossref / RIS | `report`、`standard`                              | 技术报告或标准                                          |
  | Crossref / RIS | `dataset`                                         | 数据集                                                  |
  | Crossref / RIS | `posted-content`                                  | 不确定，出版形式为空；`version_role_hint = preprint`    |
  | OpenAlex       | `article`                                         | 期刊论文                                                |
  | OpenAlex       | `review`                                          | 期刊论文；`article_kind_hint = review`                  |
  | OpenAlex       | `letter`                                          | 期刊论文；`article_kind_hint = letter-or-communication` |
  | OpenAlex       | `editorial`、`erratum`                            | 期刊论文；`article_kind_hint = correction-or-editorial` |
  | OpenAlex       | `book-chapter`、`dissertation`、`dataset`         | 对应形式                                                |
  | OpenAlex       | `preprint`                                        | 出版形式为空；`version_role_hint = preprint`            |
  | arXiv          | `preprint`                                        | 出版形式为空；`version_role_hint = preprint`            |
  | Europe PMC     | `pubType` 中的 journal article、review、letter 等 | 对应形式与提示                                          |
  | DataCite       | `resourceTypeGeneral`                             | Dataset、Text 等对应形式                                |

  无法映射的值，映射结果为空，原始值保留。映射表本身带版本号。

- [x] **7.3 一次性 catalog 副本转换**
  - 修改 `literature_metadata`、`metadata_observations` 及相关表的列：删除 `document_type`，新增两个枚举列，并加 CHECK 约束。
  - 迁移时对现有数据执行 7.2 的映射：
    - 已接纳元数据：出版形式取映射结果，文章性质只取映射提示，最终以建档为准。
    - 观测：原始值写入 `source_type`。
  - 遵守 Owner 的单一 schema 决定：不恢复迁移阶梯；一次性工具先备份，再向唯一当前 schema 转换，拒绝覆盖目标。
  - 必须做合成库迁移测试，覆盖各种原始值和空值。
  - 真实库迁移只能在 GR 后，在隔离副本上执行（12.3）。

- [x] **7.4 字段来源、冲突与锁定**

  新增 `literature_metadata_field_states` 表，按字段记录：
  - `source`：`authority`、`proofread` 或 `manual`；
  - 来源的 provenance 或片段证据；
  - `conflict`：布尔值，并附冲突双方的值；
  - `locked`：布尔值。

  字段优先级写成规则表：

  | 字段                                                                            | 优先级                                 |
  | ------------------------------------------------------------------------------- | -------------------------------------- |
  | 题名、作者、期刊（venue）、出版者、卷、期、页、标识符、出版日期与年份、出版形式 | 人工 > 权威来源 > 校订稿               |
  | 文章性质                                                                        | 人工 > 校订稿 > 来源提示               |
  | 作者关键词                                                                      | 人工 > 校订稿（文中关键词） > 权威来源 |
  | 摘要                                                                            | 人工 > 校订稿 > 权威来源               |
  | 语言                                                                            | 人工 > 校订稿（由正文判断） > 权威来源 |

  冲突的判定：
  - 两个非空来源的值在规范化后不相等，就标为冲突；
  - 规范化规则沿用 `metadata-rules.ts` 中已有的题名、作者等比较方法；
  - 冲突不影响取值，取值仍按优先级决定。

  人工修改沿用现有的用户观测机制，额外写入 `locked = true`。重新建档时，锁定字段不变。

- [x] **7.5 建档元数据步骤**
  1. 读取正文部分中角色为 `front-matter`、`abstract`、`keywords` 的片段（来自 06），以及第一页的其余片段。
  2. Agent 根据这些片段，为下列字段给出提议，每个字段都附上片段 ID：
     - 题名、作者（含单位）、期刊、卷、期、页、DOI、出版日期；
     - 语言；
     - 文章性质；
     - 作者关键词；
     - 摘要。

     提议使用 JSON schema 约束，不允许出现枚举以外的值。

  3. 按 7.4 的规则裁决，写入新的元数据 revision 和字段状态。
  4. 校验提议中的 DOI 格式，以及它是否出现在所引用的片段文本中。不满足时丢弃该字段的提议，并记录原因。

  必填条件为：题名、作者（至少 1 位）、出版年份、出版形式、文章性质。如果这几项无法确定，元数据步骤失败，原因代码为 `metadata-missing:<field>`，交给 09 的问题队列处理。

- [x] **7.6 人工编辑与锁定**

  CLI/MCP 支持：
  - 设置字段值（自动锁定）；
  - 解除锁定；
  - 查看字段状态与冲突。

  Web 界面在 11 中实现。

- [x] **7.7 查询与接口**
  - `library-page.ts`：按 `publication_forms` 与 `article_kinds` 筛选和计数。
  - CLI：
    - 新增 `--publication-form` 与 `--article-kind` 参数；
    - 删除 `--document-type`。传入 `--document-type` 时报错，并提示改用新参数。按 Owner 的决定，不保留兼容。
  - MCP：更新 `LibraryQuery` 的说明文字（`mcp/tools.ts`）。
  - Browser 决策中使用的 `document_type`（`browser/boundary.ts`、`browser/decision.ts`）改为传递出版形式。
  - 检查所有引用 `document_type` 的生产代码与测试，确保没有遗留。

- [x] **7.8 旧分析路径退役**
  - 按 Owner 不保留两套逻辑的决定，删除 `analysis/service.ts` 及其两阶段生产调用；元数据由建档与 Literature 字段 owner 接纳，summary 作为算子运行。
  - 不恢复已被撤销的兼容阶段。

- [x] **7.9 身份后备匹配**

  ADR 0037 修订了 ADR 0002 第 6 条：
  - `literature/identity-rules.ts` 中的严格后备匹配键，由 `document_type` 改为出版形式；
  - 后备身份索引表 `literature_fallback_identity_indexes` 在 7.3 的迁移中重算；
  - 迁移前后都要对合成库做身份收敛测试，确保不会产生新的错误合并；出版形式为空的记录，不参加后备匹配。

## 集成与影响

- 共享合同、SQLite schema、CLI 参数与 MCP 说明都会变化，属于公开接口的破坏性变更。Owner 已决定不保留兼容；README 与指南在 12 中同步更新。
- Browser 获取决策的输入字段名会变化。

## 验证

- 映射表测试：覆盖每个来源的每个已知值，以及未知值。
- 合成库迁移测试：迁移前后的行数、取值和 CHECK 约束。
- 字段优先级与冲突：真值表测试，覆盖人工锁定。
- 7.5：使用 fake 模型，覆盖合法提议、非法枚举、DOI 不在片段中，以及必填字段缺失。
- 查询：按新字段筛选和计数，验证分页游标。
- 回归：provider、literature、library、CLI 和 MCP 相关测试。
- `pnpm quick`。

## 退出条件

- 全仓库不再有 `document_type` 的生产引用；
- 新字段可以查询；
- 合成库迁移通过；
- 建档元数据步骤可以产出带来源与冲突标记的元数据。

## 恢复与交接

- 某个来源的原始值无法确定映射时，先映射为空，并在本块记录，不要猜测。
- 交给 08：作者关键词，作为打标签时判断粒度的依据。
- 交给 09：
  - 元数据步骤的成功或失败；
  - 描述版本中的元数据 hash。
- 交给 11：字段状态读取接口。

[计划入口](README.md)

## 本轮实现与证据（2026-10-20）

基线 `2ccf2c2` + 当前未提交代码。`packages/contracts/src/metadata-types.ts` 已提供两组封闭枚举、解析函数和统一中文名称；`literature/metadata-types.ts` 的 `mapSourceType` 经 `metadata-rules.ts` 导出，规则版本为 `source-type-v1`。

- Crossref/RIS、OpenAlex、arXiv、Europe PMC、DataCite 和 OpenCitations 的已列明类型采用确定性映射。
- 普通 journal-article 不自动推断为 research-article；DataCite Text 保守为空；未知 provider/type 保守为空。原始字符串不会被映射函数改写，持久保留由后续 observation 接入负责。
- `pnpm exec vitest run apps/server/test/metadata-types.test.ts`：48 项通过，包括未知值、原型属性名、空值、预印本角色提示和两组枚举不能混用。与 04 合并回归为 3 文件 / 94 项通过，日志 `/tmp/sciretriever-archive-implementation-yzz1ycub/rules-final.log`。
- TypeScript 检查通过；最终 Full 已通过当前切片（293 文件 / 2,152 项，零跳过）。

**尚未完成**：7.1 中 LiteratureMetadata/LibraryQuery/observation 的实际字段替换；7.3 catalog 迁移；7.4 字段状态与锁定；7.5 建档 Agent；7.6–7.9 入口、旧分析和身份后备匹配。当前程序仍使用旧元数据字段，不能宣称 Web/CLI 已支持新筛选。

**下一安全动作**：按 7.1→7.3 同步修改生产者、序列化、worker、迁移与消费者；冻结历史 schema 不直接改写。7.5 等待 05/06，不能为等它而阻塞 04→05→06。

### 最终验证快照

当前未提交切片已完成 `pnpm full`：**293 文件 / 2,152 项通过，零跳过，退出 0**，包含 Quick、全部 Vitest 和生产构建。命令使用 `VITEST_MAX_FORKS=3 VITEST_MIN_FORKS=1` 及已有测试 Chromium/Cloak bundle；所有业务数据、Provider、MinerU 和模型响应仍为合成或 fake/loopback。

证据位于 `/tmp/sciretriever-archive-implementation-yzz1ycub/`：`full-current-final.log`、`full-current-final.exit`、`verification.json`、`current-code-manifest.json`。最后一轮期间 70 个源码/测试及目录说明文件的 hash 未变化。定稿 Web 原型 hash 未变化，依赖/lockfile 未变，没有 Git commit，没有真实 catalog 迁移。

该结果只证明本块**已实现切片**的离线验收，不将尚未接入的入口、存储或真实质量验证改写为完成。未勾选 Task 仍需继续执行。

### 主合同与字段所有者接入（2026-10-20）

基线为 03 最终通过的工作树（`2ccf2c2` + 未提交 patch）。先在隔离源码副本实施，按 104 个文件的前后 hash 核对后合回工作区；随后在主工作区完成字段所有者和 DSH 元数据步骤。无子代理、无依赖/lockfile 修改，无真实 Provider、MinerU、模型、catalog 或凭据访问，无 Git 写操作。

- **7.1 / 7.2 / 7.7**：统一元数据与查询只接受 publication_form/article_kind；Provider/书目导入保存原始 source_type 和 source_type_mapping_version；CLI 移除 --document-type 并提示新参数；MCP/Browser/SQL 查询已同步。BibTeX/RIS/CSL 导出按各自格式明确映射，不直接输出内部枚举。
- **7.3 / 7.9**：catalog v15 指纹 `cdfd18c1eaa05dc9a5d992df7fb6e64d17d5262f9a90e3865f5ff3fb346c9be4`；新建库直接使用当前 schema。v14 迁移保留原始观测、文献 ID 和依赖外键，重算 hash 与后备/用户观测索引，不合并已有记录。未知类型保守为空；有旧 LiteratureContent 依赖则明确拒绝，等待 12 的授权退役，不改写旧总结输入。旧 v1/v2 迁移回归改用显式历史合成初始化器；当前库没有历史迁移回执时返回 already-initialized，不伪造迁移记录。
- **7.4 部分 / 7.6**：字段裁决复用现有元数据发布事务，记录来源、冲突与锁定；人工空值也锁定；读/编辑/解锁有 CLI、MCP 和共享产品入口，并使用 revision CAS。已验证新 observation 不能覆盖人工值。新 READY 状态的接线仍需 09，不能把当前旧 CONTENT_READY 路径当成最终状态。
- **7.5**：生产对象图使用唯一 DSH 执行器；输入仅固定校订正文的第一页及 front-matter/abstract/keywords，最多 512 片段 / 256 KiB；输出逐字段附片段。非法枚举拒绝、非法/不在证据中的 DOI 丢弃，DOI 前缀不能冒充完整标识符。提交时重查元数据 revision、当前主 PDF、默认文档 revision 与结构注释；人工锁定保留。结果报告缺失必填项及实际成功调用的 calls/tokens。完整任务编排及失败调用用量汇总由 09 接入。

验证证据目录 `/tmp/sciretriever-archive-implementation-yzz1ycub/`：

- `metadata-editor-final-tests.log`：4 文件 / 18 项通过（字段、编辑、迁移和身份）。
- `metadata-archive-final-tests.log`：3 文件 / 9 项通过（真实 DSH 底座接 fake 模型、提议证据/DOI、旧总结依赖拒绝、回滚）。
- `metadata-integrated-regression.log`：35 文件 / 270 项，269 通过、1 失败，零跳过。唯一失败为旧“content ready 后接纳 observation”测试：旧 LiteratureContent 的当前 metadata revision 外键阻止新的字段状态修订。该链随 09/12 的六状态与旧总结退役处理，不增加平行兼容逻辑，不弱化断言伪造通过。
- `metadata-quick-2.log`：Quick 通过；随后增加 DOI 完整标识符验证、MCP 接线修正等，最新 Quick `metadata-quick-final.log` 已退出 0（含上述修正）；源码快照为 `metadata-current-source-manifest.json`。
- 03 的 `full-raw-retirement-final.log` 仅覆盖元数据修改前的 302 文件 / 2,211 项快照，**不代表当前 07 的 Full**。

**剩余**：7.4 中 READY 后填空/冲突与 09 接线；7.8 的旧分析最终退役；更大范围回归中的历史 schema fixture 和最终 Full。下一步完成依赖出版形式的 06 引用关联，再按 08→09→10→11→12 收口。真实删除/迁移仍遵守 GB/GR，不因合成测试通过自动操作用户库。

## 本轮测试收敛台账核对（2026-10-20）

依据 Owner 本轮仅修 A/B、保留 C 的授权核对；不把第一版实现或历史 Full 当成第二版验收。本轮证据目录：`/tmp/sciretriever-test-convergence-ndZSeC`。

- 7.3：取消勾选。当前 schema.ts 的拆分列已经实现，但 Task 仍声称已完成旧库迁移和合成迁移验证；逐级迁移已按 Owner 决定删除，一次性转换工具尚未完成。本轮不转换数据库。
- 7.9：取消勾选。当前严格后备身份键已改用出版形式，但本 Task 还要求迁移时重算旧库索引并验证迁移前后身份收敛；目前没有一次性转换实现或测试证据。
- 7.4：补勾。metadata-fields、metadata-editor、metadata-proposals 与 archive-metadata 的现有实现和本轮定向用例证明字段优先级、冲突、人工锁定和过时拒绝；原台账漏勾。

### 本轮结束 Full 证据

结束 Full 中字段边界 32 项、元数据字段 11 项及档案元数据 2 项通过；不将这些证据用于证明真实库转换完成。 完整命令、失败分类和收尾后定向结果见[测试收敛记录](test-convergence.md)。本块勾选数不因旧流程测试通过而增加。

## 一次性转换与退役核对（2026-10-21）

执行基线 `8a705d8` 加当前 patch。一次性工具位于本机 `sandbox/cases/2026-10-21-catalog-copy/`，只显式接收源 catalog、源资产根与新的副本目录；不读用户配置、不切换服务，不成为产品兼容入口。使用 SQLite backup 保留 WAL，向唯一 schema 转换；未知非空表、未知列、非旧版文档或外部提取对旧文档的依赖均拒绝并保留诊断副本。原始 Markdown 通过现有 `stageLegacyRawParse` 和存储 owner 登记；四类旧派生事实及独占文件删除，共享原始文件保留。

`node sandbox/cases/2026-10-21-catalog-copy/check.mjs` 通过。合成旧 schema 从基线 `2ccf2c2` 只在临时目录重建，没有引回生产。8 条元数据覆盖已知/未知/空类型；新 hash、revision、CHECK 约束、后备匹配、歧义拒绝、空形式不参与匹配、源文件字节不变、原始 Markdown 保留、四类删除、目标覆盖拒绝和未知事实拒绝均验证。证据 `/tmp/sciretriever-finalize-idyygvg6/catalog-copy-check.log`。这不是对真实库兼容性或 GR 的完成声明。
