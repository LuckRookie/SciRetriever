# Oxford Academic

- 官方资料最后在线核对：2026-08-15
- 配置选择键：无；Oxford Academic 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://academic.oup.com`
- 当前仓库接入状态：已进入 Publisher 验证矩阵，状态为 `unsupported`；无专属 Public、授权 API 或 Browser production route

## 1. 官方入口与本轮证据边界

- [Oxford Academic](https://academic.oup.com/)：当前期刊与图书平台 origin。
- [Text and Data Mining](https://academic.oup.com/pages/open-research/text-and-data-mining)：官方 TDM 入口；本轮匿名请求返回 Cloudflare 403，正文未核实。
- [Standard legal terms and conditions](https://academic.oup.com/pages/standard-legal-terms-and-conditions)：官方法律条款入口；本轮匿名请求返回 403。
- [Open Access](https://academic.oup.com/pages/open-research/open-access)：官方 OA 入口；本轮匿名请求返回 403。
- [academic.oup.com robots.txt](https://academic.oup.com/robots.txt)：当前路径级 crawler policy。

本轮只匿名读取官方 `robots.txt`，并对首页、TDM、法律条款与 OA 页面做有界状态核对；没有
访问文章正文、跟随真实 DOI、打开 PDF、登录机构账号、读取 Cookie/profile、调用真实 API、
完成 Shibboleth/OpenAthens 或绕过 Cloudflare。无法读取的政策正文不被旧经验、ScanSci 或
相似平台条款补写。

## 2. DOI、Public 与 API 结论

常见 DOI prefix `10.1093` 以及 `Oxford Academic` / `Oxford University Press` 文本只作弱
提示。Oxford Academic 承载大量不同 journal 路径和合作出版物；prefix、publisher 字符串或
Metadata Provider 来源不能单独证明 canonical landing、具体版本、文章 ID 或 entitlement。
实际 `academic.oup.com` landing 或可信来源明确给出的 asset origin 才是更强证据。

当前没有专属 Public route。可信 Metadata/OA 来源若明确提供安全 Oxford PDF 或 landing
`AssetHint`，通用第一层仍可逐项尝试，并继续经过实际字节、PDF reader、页面树、文章身份、
来源依据、许可证和不可变发布检查。Profile 不根据 DOI 或文章 path 合成 `/doi/pdf/`、
`/doi/epdf/` 或 `/article-pdf/` URL。

由于官方 TDM 页面当前无法匿名核实，本轮没有得到可实现的机器访问/PDF API endpoint、认证
方式、请求/响应 schema、内容版本、quota scope 或错误语义。授权 API capability 因而为
`unsupported`。将来若用户有 OUP 的书面 TDM/机构协议，需要先核对它交付的是 PDF、XML 还是
其它内容，并实现独立的 operator-managed adapter；不能把网页 URL 模板伪装成 API。

## 3. robots、Browser 与限速

当前 robots 对通用 user-agent 禁止多类内部、下载、citation、认证与搜索路径，包括：

```text
/DownloadFile/
/Citation/Download
/signin.aspx
/Shibboleth.sso/
/SignInShibboleth.aspx
/search-results
/advanced-search
```

它没有禁止所有文章或所有 `article-pdf` 路径，但“未被 robots 禁止”不等于获得自动 PDF
许可，也没有给出数值 Browser article-start interval、窗口额度、账号风控或 session policy。
TDM 和法律条款正文又尚未核实，因此不能建立 Browser route。

ScanSci 记录过 Oxford journal-specific article path、`/article-pdf/`、`/doi/pdf/`、
`/doi/epdf/`、Institutional Login/OpenAthens marker，以及一个 `pdf_response_captured` success。
该结果依赖上游 Browser profile/Cookie 体系，且单个成功不能证明文章是否 OA、机构 entitlement、
长期 URL 合同或批量自动访问权。SciRetriever 不复制 Cookie、CARSI、selector、URL 改写或 verdict。

当前还缺：

- 官方允许的 Browser 自动访问范围和数值 pacing；
- login、entitlement、paywall、challenge/rate/account-warning 的封闭 marker；
- primary、supplement、chapter/book 与 wrong-article 的现场归属证据；
- 可推广的机构 session、credential origin 和跨 journal entitlement 边界。

因此没有 Browser rule、`browser_rate_limit_group` 或 session key。

## 4. 共享平台不等于共享风险域

Oxford Academic 与 AIP Publishing 的 robots 路径、登录/下载端点名称和页面技术形状高度相似，
可作为共享发布平台模板的技术线索；现有证据不足以把 Atypon、Silverchair 或其它 vendor 名称
写成稳定业务合同。模板相似也不能证明两个出版社共享：

- 用户账号、机构 entitlement 或 Shibboleth session；
- Cookie domain、credential origin 或登录跳转 allowlist；
- WAF/account-warning、quota 或 Browser article pacing；
- primary/supplement 归属、产品许可或现场运营策略。

所以两个 Profile 使用独立 `platform_key` 和 origin；在没有 executable Browser route 时都不
创建 group。未来即使双方分别获准上线，也要先以各自官方/现场证据决定风险组，不能仅按底层
技术名称合并或跨 origin 携带 credential。

## 5. 资产归属与当前实现

可信 locator 得到的 PDF 必须证明是目标文章正文。Supplementary material/file 不能成为
`primary-pdf`；chapter、book front matter、metadata/loading 页面或 wrong article 必须排除。
路径中出现 `article-pdf` 或 DOI suffix 只是一项 locator 线索，不替代实际字节、页面树和文章
身份验证。

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 fixture 为
`tests/fixtures/acquisition/profiles/oxford-academic.json`。Fixture 证明弱 DOI、无专属 route、
共享平台不共享 risk/session、supplement 排除和上游 Browser success 非生产证据；不保存真实
DOI、正文、Cookie、账号、机构或 Browser profile。

`unsupported` Profile 不进入 production catalog，不新增 Oxford credential section，也不会
启动 Browser。替代路径仍是现有通用 Public/OA 来源和用户独立的手动 PDF 接纳。
