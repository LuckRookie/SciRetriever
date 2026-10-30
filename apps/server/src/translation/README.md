# 阅读页翻译

本目录按 [ADR 0049](../../../../docs/architecture/decisions/0049-reader-translation.md) 为 Web 阅读页翻译选中的文字，不进入 CLI 与 MCP。

- `service.ts`：内置提示词 `translationSystem`（版本 `TRANSLATION_PROMPT_VERSION`）、原文规范化与缓存键、`TranslationService`。每次翻译一次结构化请求，返回 `{translation}`；模型取请求所带的、服务启动时已登记的模型，未指定时用 `analyze.model`。
- `cache.ts`：`TranslationCache`，一个独立的 SQLite 文件 `~/.sciretriever/cache/translations.sqlite`，最多 1000 条，满了删除最久没有用到的一条。键为“提示词版本、目标语言、规范化原文”的 SHA-256，不含模型；每条记录所用模型。

规范化为 Unicode NFKC、连续空白合为一个空格、去掉首尾空白，命中只看规范化后的原文完全相同。翻译运行时按模型分别建立，不带 Agent 追踪，原文与译文不写进文献库，也不进入操作记录。“重新翻译”跳过缓存，新结果覆盖旧条目。

HTTP 由 `workbench/http.ts` 提供：`GET /api/translation` 返回可选模型、默认模型、语言列表与单次字数上限（4000 个字符）；`POST /api/translation` 接收 `{text, target_language, model, force}`。所选模型不可用返回 409 `translation-model-unavailable`，模型调用失败返回 502 `translation-failed`，输入不合法按工作台通用的 `invalid-command` 返回。

[上级目录](../README.md)
