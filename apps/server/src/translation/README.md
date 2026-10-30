# 阅读页翻译

本目录按 [ADR 0049](../../../../docs/architecture/decisions/0049-reader-translation.md) 为 Web 阅读页翻译选中的文字，不进入 CLI 与 MCP。

- `service.ts`：内置提示词 `translationSystem`（版本 `TRANSLATION_PROMPT_VERSION`）、原文规范化与缓存键、`TranslationService`。每次翻译一次结构化请求，返回 `{translation}`；模型取请求所带的、服务启动时已登记的模型，未指定时用 `analyze.model`。
- `cache.ts`：`TranslationCache`，一个独立的 SQLite 文件 `~/.sciretriever/cache/translations.sqlite`，最多 1000 条，满了删除最久没有用到的一条。键为“提示词版本、目标语言、规范化原文”的 SHA-256，不含模型；每条记录所用模型。

规范化为 Unicode NFKC、连续空白合为一个空格、去掉首尾空白，命中只看规范化后的原文完全相同。翻译运行时按模型分别建立，不带 Agent 追踪，原文与译文不写进文献库，也不进入操作记录。“重新翻译”跳过缓存，新结果覆盖旧条目。

## 全文对照翻译

`fulltext.ts` 按 [ADR 0051](../../../../docs/architecture/decisions/0051-fulltext-translation-in-place.md) 翻译一篇文献的 PDF 全文：

- 来源是主 PDF 当前校订稿里整理后保留的叶块（页码、区域、类型、章节角色、校订后文字）。只翻译类型为正文、标题、图注、列表、脚注的叶块，章节角色为参考文献、作者的不翻译。
- 每页一次请求：`translationBatchSystem` 是在划词提示词上加“逐条翻译、不合并不拆分、`$…$` 原样保留、每个编号返回一次”的说明，输入为 `[{id: "b1", text}…]`，结构化返回 `{translations: [{id, translation}]}`。句子缓存已有的块不发送；回答漏掉的编号再请求一次，仍缺的块返回 `translation: null`。每块结果同时写入句子缓存。
- 定位提示：叶块区域与同页任一图片区域的重叠超过该叶块面积一半，或没有区域时，`placement` 为 `text-layer`，由阅读页按 PDF 文字层定位；否则为 `region`。
- 保存：每个“文献 + 目标语言”一个文件 `~/.sciretriever/cache/fulltext/<SHA-256>.json`，按页记录输入散列（提示词版本、语言、各叶块 ID 与文字）和译文。散列不变的页直接返回，变了就重翻这一页；有块缺译文的页不保存。读取时更新文件时间，文件超过 50 个时按文件时间删除最久未用的。写入按文件排队，整文件先写临时文件再改名。
- 接口：`GET /api/translation/fulltext?literature_id&target_language` 返回页数与每页的块数、是否已保存；`POST /api/translation/fulltext/page` 接收 `{literature_id, page_index, target_language, model, force}`，返回该页每块的区域、定位提示、原文与译文。未建档返回 409 `translation-not-archived`。

HTTP 由 `workbench/http.ts` 提供：`GET /api/translation` 返回可选模型、默认模型、语言列表与单次字数上限（4000 个字符）；`POST /api/translation` 接收 `{text, target_language, model, force}`。所选模型不可用返回 409 `translation-model-unavailable`，模型调用失败返回 502 `translation-failed`，输入不合法按工作台通用的 `invalid-command` 返回。

[上级目录](../README.md)
