# 阅读层

建档的 `layers` 一步：为主 PDF 的校订稿按段写出阅读层（每段一条批语、每节一句节旨、全篇的提要、主干、段与段的关系与关键数据），由程序核对后存进文献库；以及按固定版本读取它们（ADR 0073，修订 ADR 0069、0070；规格见技术篇“文档与证据”第 10 节）。批语与提要是机器写的，不是证据；它们的依据是原文里的位置。

- `prompt.ts`：五种调用的固定提示词与结构化返回的 schema：分节 `LAYERS_SECTION_SYSTEM`、节旨 `LAYERS_SECTION_LINE_SYSTEM`（版本都记 `READING_LAYERS_SECTION_PROMPT_VERSION`）、全篇 `LAYERS_DOCUMENT_SYSTEM`（`READING_LAYERS_PROMPT_VERSION`）、译文部分的分节与全篇 `layersTranslationSectionSystem(language)`、`layersTranslationDocumentSystem(language)`（`READING_LAYERS_TRANSLATION_PROMPT_VERSION`）。写法规则取自 ADR 0073 第 2 节；没有按资料类型或学科的补丁；中日韩文字与其他文字的限度都写在同一份提示词里。
- `check.ts`：纯函数。`layersPlan` 排出输入（段 `pN`、标题 `sN`、图表 `fN`、按节分组与分份），`sectionInput`、`sectionLineInput`、`documentInput`、`translationSectionInput`、`translationDocumentInput` 写出各次调用的输入，`checkSectionAnswer`、`checkLineAnswer`、`checkDocumentAnswer`、`checkTranslationSectionAnswer`、`checkTranslationDocumentAnswer` 核对回答，`numberedPoints` 按全文顺序编号并加上主干、关系与 `basis`。
- `document.ts`：登记与文件（`DocumentLayersStore`）和这一步（`DocumentLayersService`）。
- `read.ts`：`LayersReader` 把存下的文件对着固定文档读成概览、脉络、节旨与三种文本，`layersMarkdown*` 排出 Markdown 导出。

## 这一步

- **范围**：只在主 PDF 上执行，排在 `translate` 之后。长文档记 `long-document`，正文可译单元（不含标题）合计不足 `LAYERS_MIN_CODE_POINTS`（3,000 码点）的记 `too-short`：两者都直接完成、不调用模型，登记一行 `not-applicable`，没有文件。
- **输入键**：`archiveStepKey(…, "layers", …, language, translation_sha256)` 加文件版本 `LAYERS_FILE_SCHEMA_VERSION`（现为 3），只由主 PDF、校订稿内容版本、译文语言、当前内容版本的译文文件 sha256 与文件版本决定；上次完成且相同则跳过。提示词与模型变化不触发重做。`from_step: layers` 强制全部重做。
- **模型**：经 `TranslationService.structured` 发请求，沿用翻译一步的模型选择，不新增配置键，不读写翻译缓存；各节并行，与其他步骤共用全进程的模型名额。不合 schema 的回答在模型层与请求失败同为 `failed`。
- **段与节**：段是 `translation/document.ts` 的 `documentUnits` 里不是标题的单元；种类按首个片段记 `paragraph`、`list item`、`caption`（属于图组时 `caption of fN`）、`footnote`。比一句批语长的段（多于 40 个中日韩字或 20 个词）是“可批的段”。段按 `section_id` 归节；一节超过 `LAYERS_PART_UNITS`（40）段或 `LAYERS_PART_CODE_POINTS`（12,000 码点）时按 `layersParts` 分成大致相等的几份。摘要取角色 `abstract` 的段，没有时取标题像摘要的那一节。
- **分节调用**：纯文本输入（题名、摘要、目录与 `▶`、这一节的段与编号的句子、这一节的图表），回答 `{section, units}`。核对与丢弃按规格 10.2、10.3；不合格（不是结构或认得出的段不到一半）再请求一次；被截断的对半拆开、各作一份再请求，直到一段。分过份或拆开过的节，节旨另用一次节旨调用（两次）。
- **全篇调用**：只送题名、摘要、各节标题与节旨、各段的类别与批语、图表与图注；回答 `{digest, primary, relations, data}`，两次。各节写完后有批语的可批段不足三分之二时不做这一次。
- **结果**：有批语的可批段不少于三分之二、主干不少于 3 条、`summary` 有文字时 `done`，写出文件并登记；否则 `failed`、`layers-incomplete`，不发布。没有配置模型或各节一次合格回答也没有为 `layers-unavailable`（原始失败码在 `output.failure_code`）。失败不中断后面的步骤，问题的 `affects_readiness` 为 false；恢复建档时这一步重做。回执的字段见规格 10.3。
- **译文部分**（规格 10.5）：当前内容版本有译文、且不是 `same-language` 时，逐节用 JSON 输入请求（库里这一节各段的译文分句编号、类别、原文依据句 `e1`…），分份、拆开与节旨同原文版本；然后全篇一次（各节译文版本的节旨与批语，以及要逐项写的原文提要、局限 `L1`…、去处 `P1`…、数据的量 `Q1`…）。核对同原文版本；依据的句号存在且连续才换成单元译文里的 UTF-8 字节范围，否则为 null。什么也没写成时不做这一部分，阅读层照常发布，这一步 `failed`、`layers-translation-incomplete`。
- **只有译文变了**：这一内容版本已有完整的阅读层、而它的译文部分所依据的译文文件与当前的不同（或没有译文部分而现在有译文）时，只重做译文部分的调用，发布一份新文件；`output.layers.redone` 为 `translation`。两者一致时为 `none`，不调用模型。

## 存放

一份阅读层是 ArtifactStore 里的一个不可变 JSON 文件（`parsed/layers/`），内容为 contracts 的 `DocumentLayersFile`（版本 3）：`digest`、`sections`（留下的节旨）、`points`（每段至多一条：`unit_id`、`statement`、`reason`、`label`、`kind`、`key_terms`、`evidence`、`relations`、`primary`、`basis`、`section_id`）、`data`、`dropped` 与 `translation`（没有译文部分为 null；有则按节旨与批语的下标对齐，没有写成的为 null）。重点词只存词，不存位置。库表 `document_layers` 每个“文献、主 PDF、校订稿内容版本”一行，只记文件的引用、sha256、大小、批语数、状态、不适用的原因、译文语言与译文文件的 sha256 和时间；表结构与版本 2 相同。阅读层不进全文索引。

## 读取

`DocumentLayersStore.lookup`：初稿或没有结构注释的版本为 `none`；该内容版本有登记时取其状态；登记的文件不是当前的文件版本时为 `stale`，不迁移旧文件（版本 2 的文件因此读作 `stale`，下次建档重做）；没有而这篇文献有别的内容版本的完整阅读层时也为 `stale`，否则 `none`。读取合同见规格 10.7 与 `document/README.md`；`overview.sections` 的次序与 Markdown 的排法见规格 10.7 的“实现时定下的细节”。

[上级目录](../README.md)
