# 阅读层

建档的 `layers` 一步：为主 PDF 的校订稿写出“概览与脉络”（提要、关键数据与按全文顺序的要点，要点另有主干、短标签、类别与关系），由程序核对后存进文献库；以及按固定版本读取它们（ADR 0069 与 0070，规格见技术篇“文档与证据”第 10 节与 10.2.1）。要点与提要是机器写的，不是证据；它们的依据是原文里的位置。

- `prompt.ts`：两次调用的固定提示词与结构化返回的 schema。第一次 `LAYERS_SYSTEM`（版本 `READING_LAYERS_PROMPT_VERSION`），第二次 `layersTranslationSystem(language)`（版本 `READING_LAYERS_TRANSLATION_PROMPT_VERSION`）。没有按资料类型或学科的补丁；模型用文献自己的语言写。
- `check.ts`：输入的排法（`layersInput`）与第一次回答的核对（`checkLayersAnswer`），都是纯函数。
- `document.ts`：登记与文件（`DocumentLayersStore`）和这一步（`DocumentLayersService`）。
- `read.ts`：`LayersReader` 把存下的文件对着固定文档读成概览、脉络与三种文本，`layersMarkdown*` 排出 Markdown 导出。

## 这一步

- **范围**：只在主 PDF 上执行，排在 `translate` 之后。长文档（结构里有 `long_document`）记 `long-document`，正文可译单元（不含标题）合计不足 `LAYERS_MIN_CODE_POINTS`（3,000 码点）的记 `too-short`：两者都直接完成、不调用模型，登记一行 `not-applicable`，没有文件。
- **输入键**：`archiveStepKey(…, "layers", …, language, translation_sha256)`，只由主 PDF、校订稿内容版本、译文语言与当前内容版本的译文文件 sha256 决定；上次完成且相同则跳过。提示词与模型变化不触发重做。`from_step: layers` 强制全部重做；更早的 `from_step` 不强制。
- **模型**：经 `TranslationService.structured` 发请求，沿用翻译一步的模型选择（默认模型、角色 `translation`），不新增配置键，不读写翻译缓存；与其他步骤共用全进程的模型名额。
- **第一次调用**：纯文本输入，首行 `Maximum number of points: N`，然后 `Title:`、各章节标题（`## [sN] 标题`）、每段 `[pN] <1> 句子 <2> 句子…`、每个图组一行 `[fN] figure|scheme|table: 图注`。段是译文的单元（`translation/document.ts` 的 `documentUnits`，作者、参考文献、首页文章信息不在内）；图组的图注随图组出现，不另作段。句子按 contracts 的 `sentence-split-v1` 切分，图注整段一句。回答 `{digest: {summary, limits[], advice}, data[], points[]}`（见 `prompt.ts` 的 `LAYERS_SCHEMA`），依据写成 `pN.S`、`pN.S-T`、`pN.S,T` 或 `fN`；要点之间用回答里的次序 `kN` 互指，去处用 `sN`（章节）或 `fN`。
- **核对**：依据的段号、句号存在，句子连续且不超过 4 句、图组存在才保留，换成真实的单元编号与 UTF-8 字节范围（或图组第一个对象的片段编号）；同一要点里重复的、超过 3 条的丢掉。没有依据留下、`statement` 为空或超过 300 码点的要点丢掉。留下的按第一条依据（依据先按位置排好）的位置排序、从 1 重新编号，`section_id` 取那个位置所在片段的章节（全文没有任何章节标题时为 null），超过 40 个只留前 40 个。重点词按 `key-term-match-v1` 在所属文字里找得到、不超过 40 码点、不重复才保留，最多两个。提要的 `units` 只认段号，最多 6 个。ADR 0070 的内容逐项核对，不过的那一项丢掉、要点本身保留，各计入 `dropped` 的一项：`kind` 不在七种里（`kinds`，这个要点没有类别）；`label` 超过 6 个词或 12 个中日韩字（`labels`）；关系的 `word` 不在六种里、`targets` 指向不存在或已丢掉的要点、指向自己、或 `see` 指向要点（`relations`，整条丢掉，按重新编号后的号数存）；`basis` 不是这个主干要点自己的某条依据之内、或 `quote` 在那几句里找不到（`basis`；非主干带的也丢）；`data` 的 `value` 没有数字、它的数字在 `source`（段或表，不能是图）的文字里逐字找不到（前后不连着别的数字）（`data`）；`places` 的文字不在 `advice` 里或所指的章节、图表不存在（`places`）；`limits` 的文字为空、超过 200 码点或超过 5 条（`limits`）；主干多于 5 个时按号数只留前 5 个（`primary`）。`advice` 超过 300 码点记为空。
- **重试**：回答不是所要的结构时再请求一次；被输出上限截断时再请求一次，首行的上限减半（40 → 20）。两次都没有任何回答（请求失败）为 `layers-unavailable`。
- **结果**：留下的要点不少于 3 个、不少于模型给出的一半、主干不少于 3 个、`summary` 有文字（不超过 400 码点）时 `done`，写出文件并登记；否则 `failed`、`layers-incomplete`，不发布。模型不可用为 `layers-unavailable`（原始失败码在 `output.failure_code`）。失败不中断后面的步骤，问题的 `affects_readiness` 为 false，不影响就绪；恢复建档时这一步重做。
- **译文部分**（规格 10.5）：当前内容版本有译文、且不是 `same-language` 时做第二次调用。输入是 JSON：`items`（`d-summary`、`d-limit-N`、`d-advice`（带 `places` 的文字）、`q-N`（数据的 `quantity`；`value` 不送、不译）与 `k1…` 各要点的文字、重点词、`label`；要点另带依据 `{id: "e<要点>-<序>", unit, original}`）与 `units`（依据所在单元的库里译文，按 `sentence-split-v1` 切句编号）。回答每项的译文、各重点词的对应词与各依据对应的译文句号。对应词在这项译文里按 `key-term-match-v1` 找得到才保留，去处的译文文字在精读建议的译文里逐字找得到才保留；句号存在且连续才换成单元译文里的 UTF-8 字节范围，否则这条依据的译文位置为 null；单元缺译的依据不送出，位置为 null。每项译文为空则为 null；全部为 null 时不做这一部分，阅读层照常发布，这一步 `failed`、`layers-translation-incomplete`。
- **只有译文变了**：这一内容版本已有完整的阅读层、而它的译文部分所依据的译文文件与当前的不同（或没有译文部分而现在有译文）时，只重做第二次调用，发布一份新文件；`output.layers.redone` 为 `translation`。两者一致时为 `none`，不调用模型。
- **回执**：`output.layers` 为 `{status: complete|not-applicable|failed, reason, redone: all|translation|none, given, points, dropped, sha256, translation}`，`translation` 为 `{status: done|incomplete|not-needed, target_language, translation_sha256, items, translated, key_terms_dropped, evidence, aligned, evidence_dropped}`（跳过时只有前两项）；`stats` 另有 `pages`、`units`、`figures`、`body_code_points` 与 `requested`（这次是否请求过模型；用量估算只取请求过的历史）。

## 存放

一份阅读层是 ArtifactStore 里的一个不可变 JSON 文件（`parsed/layers/`），内容为 contracts 的 `DocumentLayersFile`：`schema_version`、`literature_id`、`asset_id`、`document_version_id`、`annotation_id`、`content_version`、`sentence_rule`、`digest`（`summary`、`limits`、`advice`）、`points`（另有 `primary`、`label`、`kind`、`relations`、`basis`）、`data`、`model`、`prompt_version`、`dropped` 与 `translation`（没有译文部分为 null；有则为 `target_language`、`translation_sha256`、`model`、`prompt_version`、按提要项与按要点下标对齐的译文、对应词与依据的译文位置，以及它自己的 `dropped`）。重点词只存词，不存位置。库表 `document_layers` 每个“文献、主 PDF、校订稿内容版本”一行，只记文件的引用、sha256、大小、要点数、状态、不适用的原因、译文语言与译文文件的 sha256 和时间；同一组合再次发布时换成新的一份，旧文件仍登记为不可变对象。表来自增补集 `document-layers`。阅读层不进全文索引。

## 读取

`DocumentLayersStore.lookup`：初稿或没有结构注释的版本为 `none`；该内容版本有登记时取其状态（`complete` 或 `not-applicable`）；登记的文件不是当前的文件版本（`LAYERS_FILE_SCHEMA_VERSION`，现为 2）时为 `stale`，不迁移旧文件；没有而这篇文献有别的内容版本的完整阅读层时也为 `stale`，否则 `none`。输入键里带文件版本，所以版本上调后再次建档会整个重做。`summary` 给 `describe.layers`，有译文部分时给出它的 `target_language`；译文文件被替换不改变这一项，只使依据的译文位置在读取时退回整段译文。读取合同见 `document/README.md`。

[上级目录](../README.md)
