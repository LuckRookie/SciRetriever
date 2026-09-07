# PLOS

- 官方资料最后在线核对：2026-08-15
- 配置选择键：无；PLOS 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://journals.plos.org`
- 当前仓库接入状态：已进入 Publisher 验证矩阵，状态为 `unsupported`；通用显式 Public hint 会使用 `plos/web` 共享 scope 和 30 秒最小启动间隔，无专属 locator/API，Profile 不提供首页 probe；具有合法文章起点的目标仍可使用 `browser:generic`

## 1. 官方开放获取与机器入口

- [PLOS open science](https://plos.org/open-science/)：全部研究文章和 artifacts 按 CC BY 发布。
- [PLOS terms of use](https://plos.org/terms-of-use/)：站点、内容与 API 使用条款。
- [PLOS API](https://api.plos.org/)：Solr search 等公开 API 文档入口。
- [PLOS text and data mining](https://api.plos.org/text-and-data-mining.html)：metadata、XML、单篇 PDF 与 bulk 边界。
- [journals.plos.org robots.txt](https://journals.plos.org/robots.txt)：当前 journals crawler policy。

官方 TDM 文档明确说明全部 PLOS article 有 DOI，Solr API 可查 metadata/筛选 DOI，单篇 JATS XML
使用 `type=manuscript`，单篇 article PDF 使用 `type=printable`。Terms 允许按 CC BY 使用文章和
accompanying material，但要求 API 不得造成 excessive bandwidth 或 unreasonable burden。

同一 TDM 文档明确说批量下载 article PDF **不受鼓励**，整库 TDM 应使用官方 corpus/XML 路径；
journals robots 对通用 user-agent 声明 `Crawl-delay: 30`，并禁止 search、article metrics 和 user
路径。因此 SciRetriever 不从 `10.1371` DOI 猜 journal path，也不注册面向批次的 PLOS PDF
locator。上游把未知 journal 默认成 PLOS ONE 的做法尤其不能移植。

## 2. 当前 Public、API 与 Browser 行为

可信来源明确给出的 PLOS PDF/landing `AssetHint` 仍由通用第一层消费。生产 host table 将
`journals.plos.org` 固定到 `plos/web` 共享 scope：`max_concurrency=1`、相邻请求启动至少 30 秒，
同一进程内的 direct hint、landing 与 redirect 不能各自建立 limiter。这个收紧只保护显式 locator
访问，不把 Profile 变成专属 route，也不代表 PLOS 鼓励批量 PDF。

Solr 是 search/metadata API，JATS 是结构化全文；两者都不是 direct PDF API。官方 printable
endpoint 属于公开 journals web path，因此当前 authorized API capability 为 `unsupported`。

公开 PDF 不需要机构 Browser。当前没有 Browser route、risk group 或 session key；ScanSci 的
Browser success、Cookie 或 URL mapping 不构成必要性、长期稳定性或生产证据。

## 3. 资产归属与当前实现

明确目标 PLOS article 的 printable PDF 且通过统一验证后才可能是 `primary-pdf`。Supporting
information 必须保持 supplement；JATS XML、HTML、peer review、metrics 和 wrong article 必须
排除。DOCTYPE、HTTP 200、`type=printable` 或 DOI prefix 不能代替实际 PDF reader、页面树和
文章身份检查。

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 fixture 为
`tests/fixtures/acquisition/profiles/plos.json`；精确 host pacing 位于
`src/sciretriever/acquisition/registry.py`。Fixture 独立证明官方单篇 PDF、批量 PDF 不受鼓励、
30 秒 crawler delay、Solr/JATS 边界和 Browser 不适用；不保存真实 DOI、正文、响应、Cookie、
账号或 Browser profile。

`unsupported` Profile 不进入 production catalog，也不新增 credential section。当前有效替代
路径是通用可信 Public/OA hint 和用户独立的手动 PDF 接纳。
