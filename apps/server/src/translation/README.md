# 翻译

本目录有两件事：阅读页的划词翻译（ADR 0049），以及建档时产生并存进文献库的全文译文（ADR 0068，规格见[文档与证据第 9 节](../../../../docs/architecture/technical/04-document-evidence.md#9-全文的译文)）。

- `service.ts`：内置提示词与 `TranslationService`。划词翻译用 `translationSystem`（版本 `TRANSLATION_PROMPT_VERSION`）、`normalizeTranslationText` 与 `translationKey`，每次一次结构化请求，返回 `{translation}`；模型取请求所带的、服务启动时已登记的模型，未指定时用 `analyze.model`。全文译文用 `documentTranslationSystem`（版本 `DOCUMENT_TRANSLATION_PROMPT_VERSION`）、`normalizeUnitText` 与 `documentUnitKey`，由 `translateUnits` 一批一次请求。
- `cache.ts`：`TranslationCache`，一个独立的 SQLite 文件 `~/.sciretriever/cache/translations.sqlite`，最多 `TRANSLATION_CACHE_LIMIT`（20,000）条，满了删除最久没有用到的一条。键为“提示词版本、目标语言、规范化原文”的 SHA-256，不含模型；每条记录所用模型。划词与全文共用这一个文件，提示词版本不同，键互不相交。
- `document.ts`：建档的 `translate` 一步（`DocumentTranslationService`）与译文的登记和文件（`DocumentTranslationStore`）。
- `fulltext.ts`、`source.ts`：PDF 视图的对照翻译，读库里的译文，不请求模型。

## 划词翻译

规范化为 Unicode NFKC、连续空白合为一个空格、去掉首尾空白，命中只看规范化后的原文完全相同。翻译运行时按模型分别建立，不带 Agent 追踪，原文与译文不写进文献库，也不进入操作记录。“重新翻译”跳过缓存，新结果覆盖旧条目。

HTTP 由 `workbench/http.ts` 提供：`GET /api/translation` 返回可选模型、默认模型、语言列表与单次字数上限（4000 个字符）；`POST /api/translation` 接收 `{text, target_language, model, force}`。所选模型不可用返回 409 `translation-model-unavailable`，模型调用失败返回 502 `translation-failed`，输入不合法按工作台通用的 `invalid-command` 返回。

## 全文的译文（建档的 `translate` 一步）

- **单元**（`documentUnits`）：校订稿按 `arrangeSourceLayout` 排出的一段，合并段是一个单元，原文是各叶块校订后的文字按渲染 joiner 接起来；`unit_id` 是第一个叶块的编号，`segment_ids` 是全部叶块。只译首叶块类型为 `text`、`title`、`caption`、`list`、`footnote` 的段；章节角色为作者或参考文献的、以及首页文章信息（`layout.article_info`：单位、通讯作者与作者注释、收稿与发表日期）不译；其余文末信息（end-matter，含致谢、资助、文末的作者信息）照常翻译。每个单元的原文必须与固定 Markdown 中从首叶块到末叶块的字节一致（标题段允许前面的 `#` 标记），对不上的不译，计入 `stats.unmatched_units`。`source_sha256` 对未规范化的原文计算。
- **同语言**（`alreadyInLanguage`）：书目语言字段能认出时只比主语言（`zh`、`zh-CN`、`zh-Hans`、`zh-Hant` 同为 `zh`，也认 `English`、`eng` 一类写法）；认不出或为空时，按可译单元的文字（公式除外）统计占多数的文字系统：拉丁、西里尔、谚文、汉字与假名（假名不少于汉字加假名的一成算日文，否则算中文）。与译文语言的文字相同就不译，结果为 `same-language`。
- **沿用**：取这篇文献这种语言最近一份译文，原文摘要相同的已译单元直接沿用；`from_step: translate` 不沿用、不读缓存，全部重译。更早的 `from_step` 照常沿用。
- **分批与请求**：剩下的单元按文中顺序分批，每批不超过 `TRANSLATION_BATCH_MAX_CODE_POINTS`（6,000 码点）与 `TRANSLATION_BATCH_MAX_UNITS`（60 个），单个超长单元单独一批。请求体为 `{title, sections, units: [{id: "u1", text}…]}`，`title` 取书目标题，`sections` 是这批单元所在章节的标题，两者只作上下文；结构化返回 `{translations: [{id, translation}]}`。送出的文字在公式（`$…$`、`$$…$$`）之外做 NFKC、把空格与制表符合为一个，保留换行；公式内一字不改。
- **校验与重试**：返回的译文里公式（排序后的 `$…$` 列表）与原文不同的单元算没翻好；没翻好或缺失的单元再请求一次，仍没有的记为缺译。每个通过的单元立刻写进翻译缓存，进程中断后重跑从缓存取回，不再请求模型。
- **并发与用量**：同时进行的批数取 `[proofread].max_concurrent_pages`，模型名额与其他步骤共用。每次请求计一次调用，token 取模型回报的用量；失败的请求 token 记为未知（null），不填 0。
- **结果**：全部有译文或同语言为 `done`；有缺译为 `failed`、`translation-incomplete`，模型不可用为 `failed`、`translation-unavailable`。已翻好的单元总是先发布（全部缺译时不发布）。失败不中断后面的步骤，问题不影响就绪；恢复建档时只请求缺译的单元。回执的 `output.translation` 为 `{status, units, translated, missing, reused, requested, batches, sha256}`，`stats` 另有 `pages`（用量估算按页的分母）。
- **步骤的输入键**：`archiveStepKey(…, "translate", …, language)` 只由主 PDF、校订稿内容版本与译文语言决定，提示词与模型变化不触发重翻。

**存放**：一份译文是 ArtifactStore 里的一个不可变 JSON 文件（`parsed/translations/`），内容为 `DocumentTranslationFile`：`schema_version`、`literature_id`、`asset_id`、`document_version_id`、`annotation_id`、`content_version`、`target_language`、`status` 与按文中顺序的 `units`（`unit_id`、`segment_ids`、`source_sha256`、`translation`、`model`、`prompt_version`，缺译时后三项为 null）。库表 `document_translations` 每个“文献、主 PDF、内容版本、语言”一行，只记文件的引用、sha256、大小、单元数、已译数、状态与时间；同一组合再次发布时换成新的一份，旧文件仍登记为不可变对象。

**读取**（`DocumentTranslationStore.lookup`）：初稿或没有结构注释的版本为 `none`；该版本内容版本有译文时取其状态；没有而这篇文献同语言有别的译文时为 `stale`，否则 `none`。文档读取的 `describe`、`translation`、`slice` 的 `text` 选项见 `document/README.md`。

## PDF 视图的对照翻译

`GET /api/translation/fulltext?literature_id&target_language` 与 `POST /api/translation/fulltext/page` 的请求与返回字段不变，另加 `state`。两者读主 PDF 默认版本在所请求语言下的已存译文，不请求模型；`force` 照收，不再触发翻译。

- `source.ts` 经 document 模块核验并读取主 PDF 的固定默认版本，给出各叶块的类型、角色、区域与校订后文字。默认文本是初稿时没有译文。主 PDF 没有默认文本时返回 409 `translation-not-archived`。
- 有译文文件时，页上列出的块是属于译文单元的叶块（文章信息因此不再列出）；没有时照旧按类型与角色列出，译文为 null。一个单元跨几个叶块（几个页面区域）时，`splitTranslation` 按各叶块原文的字数比例切分译文，切点落在比例位置前后最近的标点或空白处，附近没有就落在比例位置。
- `saved` 表示这一页的块都有译文；`model` 取译文中第一个有译文的单元所记的模型。
- 定位提示：叶块区域与同页任一图片区域的重叠超过该叶块面积一半，或没有区域时，`placement` 为 `text-layer`，由阅读页按 PDF 文字层定位；否则为 `region`。
- ADR 0051 的按页译文文件（`~/.sciretriever/cache/fulltext/`）不再读写，应用每次启动时删除这个目录（不存在时无事）。

[上级目录](../README.md)
