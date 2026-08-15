# Science / AAAS

- 官方资料最后在线核对：2026-08-15
- 配置选择键：无；Science/AAAS 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://www.science.org`
- 当前仓库接入状态：已进入 Publisher 验证矩阵，状态为 `unsupported`；无专属 Public、授权 API 或 Browser production route

## 1. 官方入口与本轮证据边界

- [Science journals platform](https://www.science.org/)：当前文章平台 origin。
- [AAAS terms](https://www.aaas.org/terms)：AAAS 通用条款入口；本轮只返回需要 JavaScript 的外壳，正文未核实。
- [Science terms of use](https://www.science.org/content/page/terms-use)：Science 条款入口；本轮匿名请求返回 Cloudflare 403。
- [Science open access](https://www.science.org/content/page/open-access-aaas)：OA 入口；本轮匿名请求返回 403。
- [science.org robots.txt](https://www.science.org/robots.txt)：当前 crawler 路径与 agent policy。

本轮只匿名读取官方 `robots.txt`，并对首页、条款和 OA 入口做有界状态核对；没有访问文章
正文、跟随真实 DOI、打开 PDF、登录机构账号、读取 Cookie/profile、调用真实 API、完成 SSO
或绕过 Cloudflare。无法读取的政策正文不由旧经验、ScanSci 或其它 Atypon 类站点补写。

## 2. DOI、Public 与 robots capability

常见 DOI prefix `10.1126` 以及 `AAAS` / `American Association for the Advancement of
Science` / `Science Journals` 文本只作弱提示，不能独立证明 canonical landing、具体刊物、
文章版本或 entitlement。实际 `www.science.org` landing 或可信来源明确提供的 asset origin
才是更强证据。

robots 对通用 user-agent 禁止 `/action`、`/search`、`/media`、`/author` 等范围，同时为
少数动作给出 allow，包括 `showFeed`、`showJournal`、`showXml`、`showCoverImage` 和
`downloadSupplement`。这些规则要精确解释：

- 允许 XML/feed/topic/cover crawler path 不证明它们是 PDF 或授权全文 API；
- `downloadSupplement` 明确是 supplement，不能成为 `primary-pdf`；
- 未被 robots 禁止的文章路径也不自动获得批量 PDF 下载许可；
- robots 没有提供数值并发、文章间隔、窗口额度或账号 policy。

因此 Profile 不声明专属 Public route。可信 Metadata/OA 来源若明确给出安全 Science PDF 或
landing `AssetHint`，通用第一层仍可逐项尝试，并继续经过实际字节、PDF reader、页面树、
文章身份、来源依据、许可证和不可变发布检查；不会根据 DOI 合成 `/doi/pdf/` 或 `/doi/epdf/`。

## 3. 授权 API 与 Browser 结论

本轮未得到可核实的官方机器访问/PDF API endpoint、认证产品、schema、媒体类型、quota scope
或错误语义。robots 允许 `showXml` 只说明 crawler path，不说明返回内容、entitlement、许可
或稳定协议。因此 authorized API capability 为 `unsupported`。

ScanSci 记录过 Science DOI landing、`/doi/epdf/`、`/doi/pdf/` 与一个
`pdf_response_captured` success，同时建议持久 Browser profile 并处理机构 SSO/CAPTCHA。
该单样本无法证明它是公开、机构授权还是长期 URL 合同，更不能形成批量 Browser 权利。
SciRetriever 不复制 Cookie、CARSI、CAPTCHA/反检测、selector、URL 模板或 verdict。

当前 Browser route 还缺：

- 可读取的官方自动访问条款与数值 article-start pacing；
- login、entitlement、paywall、challenge/rate/account-warning 的封闭 marker；
- primary、supplement、media/XML 与 wrong-article 的现场归属证据；
- 可推广的机构 session、credential origin 和 account risk policy。

所以没有 Browser rule、`browser_rate_limit_group` 或 session key。未来若得到明确许可，也必须
按 Science 自有 origin/账号证据建立串行组；与 PNAS 共享页面模板、CDN 或 PDF path 都不能
自动合并 risk/session group。

## 4. 资产归属与当前实现

可信 locator 得到的 PDF 必须证明是目标文章正文。通过 `downloadSupplement` 得到的文件始终
属于 supplement；XML、media、cover、loading 页面和 wrong article 不能成为 `primary-pdf`。
URL 中出现 DOI 或 `pdf` 只是一项 locator 线索。

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 fixture 为
`tests/fixtures/acquisition/profiles/science-aaas.json`。Fixture 独立证明弱 DOI、robots 的 XML/
supplement allowance 不生成主 PDF route、无 API/Browser、supplement 排除和上游 Browser
success 非生产证据；不保存真实 DOI、正文、Cookie、账号、机构或 Browser profile。

`unsupported` Profile 不进入 production catalog，不新增 Science credential section，也不会
启动 Browser。替代路径仍是现有通用 Public/OA 来源和用户独立的手动 PDF 接纳。
