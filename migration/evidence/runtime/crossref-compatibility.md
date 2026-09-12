# Crossref 代表性兼容切片

2026-09-10。TypeScript 侧新增离线 `parseCrossrefRecord`，只消费已取得的 Crossref JSON 记录；网络请求、分页和
Provider 访问预算仍由现有 Python owner 管理。适配器把 DOI、作者/机构、JATS 摘要、日期优先级、文献类型、引用原文、
统计计数和公开全文链接映射到统一 `MetadataObservation`，并在合同入口拒绝不完整身份或不安全链接。

直接测试 `apps/server/test/crossref-fixture.test.ts` 使用仓库内固定 fixture，验证人物/机构作者、ORCID、摘要脱标记、
出版日期优先级、引用保留、敏感签名 URL 丢弃以及 subject 不被误当作关键词。测试只读合成 fixture，不连接 Crossref，
不运行 Python 测试。

这是一项代表性差分切片，不声明其它 Metadata Provider 已迁移，也不改变生产 Provider 组装或网络授权。
