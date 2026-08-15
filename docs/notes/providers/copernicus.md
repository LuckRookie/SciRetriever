# Copernicus Publications

- 官方资料最后在线核对：2026-08-15
- 配置选择键：无；Copernicus Publications 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://publications.copernicus.org` 与各期刊独立的 `*.copernicus.org` 文章站点
- 当前仓库接入状态：已进入 Publisher 验证矩阵，状态为 `unsupported`；无专属 Public、授权 PDF API 或 Browser production route

## 1. 官方开放获取与入口

- [Copernicus Publications](https://publications.copernicus.org/)：出版平台与当前服务公告。
- [Open-access publishing](https://publications.copernicus.org/services/open-access_publishing.html)：官方开放获取模式与发布格式说明。
- [Licence and copyright](https://publications.copernicus.org/for_authors/licence_and_copyright.html)：作者保留版权，文章按 CC BY 4.0 分发。
- [XML harvesting and OAI-PMH](https://publications.copernicus.org/services/xml_harvesting_and_oai-pmh.html)：官方 metadata/full-text XML harvesting 合同。
- [publications.copernicus.org robots.txt](https://publications.copernicus.org/robots.txt)：当前 crawler 路径 policy。

官方资料明确说明开放期刊提供 PDF、HTML 和 XML，并按 CC BY 4.0 允许复制、分发和再利用。常见
DOI prefix `10.5194` 与 Copernicus 名称仍只作弱提示；DOI suffix 或期刊简称不能独立成为
production host allowlist。

Copernicus 文章实际分布在期刊独立子域。Profile 不用 `*.copernicus.org` 通配符扩大 origin；
只有可信来源明确给出的精确 HTTPS PDF/landing `AssetHint` 才由通用第一层逐项消费，并继续经过
URL/DNS/redirect、实际字节、PDF reader、页面树、文章身份、许可证和不可变发布检查。

## 2. OAI-PMH 不是 PDF API

官方 OAI-PMH 2.0 提供全部文章的 Dublin Core metadata，并为 2014 年 11 月以后文章提供 NLM/JATS
full-text XML。它适合 harvesting，但 XML 不是主 PDF，`GetRecord` 也不是 PDF object retrieval。
因此当前不把 OAI-PMH 注册为 Acquisition PDF route。

本轮首页仍展示 2026 年 5 月高负载导致期刊文章 PDF 临时受限、HTML/XML 继续可用的服务公告。
该公告不能证明每篇 PDF 当前永久不可用，也不能反向支持批量猜 URL；它说明独立 PDF route 还需
稳定可用性和访问政策证据。官方 robots 没有数值 crawl delay，absence 也不等于无限速。

## 3. Browser 与归属结论

开放内容正常不需要机构 Browser。当前没有官方 Browser 文章政策、数值 pacing、页面状态 marker
或 primary/supplement 现场规则；ScanSci 的 DOI 模板和 Browser fallback 不是生产证据。因此没有
Browser rule、risk group 或 session key。

明确目标期刊文章且通过统一验证的 PDF 才可能是 `primary-pdf`。Supplement、preprint file 必须
保持非主资产；HTML、XML、metadata 和 wrong article 必须排除。PDF 格式声明、CC BY 或 URL
后缀不能跳过资产归属检查。

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 fixture 为
`tests/fixtures/acquisition/profiles/copernicus-publications.json`。Fixture 独立证明 OAI XML/PDF
边界、动态期刊子域不使用 wildcard、服务公告和 Browser 不适用；不保存真实 DOI、正文、响应、
Cookie、账号或 Browser profile。

`unsupported` Profile 不进入 production catalog，也不新增 credential section。当前有效替代
路径是通用可信 Public/OA hint 和用户独立的手动 PDF 接纳。
