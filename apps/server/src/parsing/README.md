# PDF 解析

把已接纳 PDF 交给外部 parser，转换并发布中性的解析结果。

## 下级目录

| 目录                            | 职责             |
| ------------------------------- | ---------------- |
| [backends/](backends/README.md) | 外部解析后端适配 |

## 内容入口

- [ports.ts](ports.ts)：解析服务端口。
- [raw-service.ts](raw-service.ts)：按部署 profile 或显式请求执行，逐 profile 复用/失败与取消；唯一当前 schema 组装同一 raw 执行路径，正式解析命令返回逐 profile 回执，不发布旧 ParserResult 或默认全文。
- [legacy-raw.ts](legacy-raw.ts)：从已验证的现有 ParserResult 字节构造仅 Markdown 原始解析，不调用服务、不改变旧关系。
- [artifact-rules.ts](artifact-rules.ts)：解析产物规范化与检查。
- [markdown-resources.ts](markdown-resources.ts)：归档转换与产物接纳共用的资源引用发现和路径规则，避免两套提取规则丢失合法引用。
- [article-identity.ts](article-identity.ts)：解析后文章身份检查协作。

## 放置边界

MinerU 等外部服务协议集中在 backends；文档片段与证据读取归 document；后续总结归 analysis。

[上级目录](../README.md)

旧 ParserResult 的执行器、发布器、单结果适配与 JSON 响应回退已从生产移除。`ApplicationOptions.parsing` 只接收 `{ rawParser }`，后端只实现 `RawParserBackend`。历史库读取/迁移所需的合成写入器位于测试目录，不属于产品接口。
