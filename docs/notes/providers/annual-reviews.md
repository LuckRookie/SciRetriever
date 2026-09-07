# Annual Reviews

- 官方资料最后在线核对：2026-08-15
- 配置选择键：无；Annual Reviews 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://www.annualreviews.org`
- 当前仓库接入状态：已进入 Publisher 验证矩阵，状态为 `unsupported`；无专属 Public 或授权 API，Profile 不提供首页 probe；具有合法文章起点的目标仍可使用 `browser:generic`

## 1. 官方入口与本轮证据边界

- [Annual Reviews journals platform](https://www.annualreviews.org/)：当前期刊平台 origin。
- [Annual Reviews terms](https://www.annualreviews.org/page/about/terms)：官方条款入口；本轮匿名请求返回 403，正文未核实。
- [Subscribe to Open](https://www.annualreviews.org/page/librarians/subscribe-to-open)：官方 S2O 入口；本轮匿名请求返回 403。
- [annualreviews.org robots.txt](https://www.annualreviews.org/robots.txt)：当前可匿名读取的 crawler 路径 policy。

本轮只匿名读取官方 robots，并对条款和 Subscribe to Open 入口做有界状态核对；没有访问文章
正文、打开 PDF、登录机构账号、读取 Cookie/profile、完成 SSO/2FA 或绕过 challenge。

常见 DOI prefix `10.1146` 和 Annual Reviews 名称只作弱提示。Subscribe to Open 项目名称也
不能独立证明某篇文章、某个版本或当前订阅周期已经开放。可信来源明确提供的 PDF/landing
`AssetHint` 仍由通用第一层消费，并经过许可证、实际字节、PDF reader、页面树、文章身份和
不可变发布检查；Profile 不合成专属 locator。

## 2. robots delay 不是 Browser policy

官方 robots 对通用 user-agent 声明 `Crawl-delay: 2`，并禁止 session、profile、search 与
delivery administration 等路径。这个两秒 delay 只属于 crawler indexing policy；它不证明
Browser 自动获取许可、机构账号风险边界、文章启动间隔或页面交互规则，不能直接转换为
`BrowserRateLimitPolicy`。

本轮没有得到可核实的机器访问/PDF API endpoint、认证产品、schema、媒体类型、quota scope
或错误语义。因此 authorized API capability 为 `unsupported`；S2O 页面存在也不构成 API。

## 3. Browser 结论

ScanSci 的记录依赖特定高校 OpenAthens、SSO/2FA、可见 CloakBrowser 和持久化会话。这些材料
既不能证明其它机构或用户的 entitlement，也不能成为 SciRetriever 的通用 credential origin、
session policy、页面 marker 或长期 success verdict。项目不复制其中的 Cookie、机构身份、
selector、反检测或自动 MFA 流程。

当前还缺可读取的自动访问条款、数值文章风险策略、login/entitlement/paywall/challenge
marker，以及 primary、supplement、front matter 和 wrong review 的现场归属证据。因此没有
Browser rule、`browser_rate_limit_group` 或 session key。

## 4. 资产归属与当前实现

明确目标 review article 且通过统一验证的 PDF 才可能是 `primary-pdf`。Supplementary
material/file 必须保持 supplement；front matter、metadata、loading 页面和 wrong review
必须排除。Crawler delay、HTTP 200、PDF 路径名或上游 success 都不是归属证据。

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 fixture 为
`tests/fixtures/acquisition/profiles/annual-reviews.json`。Fixture 独立证明两秒 crawler delay
不能授权 Browser、无 API/Browser、supplement 排除和机构特定 SSO 非生产证据；不保存真实
DOI、正文、Cookie、账号、机构或 Browser profile。

`unsupported` Profile 不进入 production catalog，不新增 credential section，也不会启动
Browser。替代路径仍是现有通用 Public/OA 来源和用户独立的手动 PDF 接纳。
