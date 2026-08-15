# World Scientific

- 官方资料最后在线核对：2026-08-15
- 配置选择键：无；World Scientific 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://www.worldscientific.com`
- 当前仓库接入状态：已进入 Publisher 验证矩阵，状态为 `unsupported`；无专属 Public、授权 API 或 Browser production route

## 1. 官方入口与本轮证据边界

- [World Scientific journals platform](https://www.worldscientific.com/)：当前平台 origin。
- [World Scientific terms and conditions](https://www.worldscientific.com/page/terms-and-conditions)：官方条款入口；本轮匿名请求返回 403，正文未核实。
- [worldscientific.com robots.txt](https://www.worldscientific.com/robots.txt)：当前可匿名读取的 crawler 路径 policy。

本轮只匿名读取官方 robots，并对条款入口做有界状态核对；没有访问文章正文、打开 PDF、登录
机构账号、读取 Cookie/profile、完成 SSO 或绕过 challenge。

常见 DOI prefix `10.1142` 与 World Scientific 名称只作弱提示。可信来源明确提供的 PDF/landing
`AssetHint` 仍由通用第一层消费，并经过 URL 安全、许可证、实际字节、PDF reader、页面树、
文章身份和不可变发布检查；Profile 不合成专属 locator。

## 2. robots 与 API 边界

官方 robots 对通用 user-agent 声明 `Crawl-delay: 1`，并允许 `showXml` 路径。一秒 delay 只属于
crawler indexing policy，不证明 Browser 自动获取许可、文章启动间隔或账号风险边界；允许 XML
也不证明该响应是目标主 PDF、公开全文 API 或可批量下载的正文。

本轮没有得到可核实的机器访问/PDF API endpoint、认证产品、响应 schema、媒体类型、quota
scope 或错误语义。因此 authorized API capability 为 `unsupported`；SciRetriever 不把
`showXml` 合成为 PDF route。

## 3. Browser 结论

ScanSci 的成功记录依赖机构访问链、Terms 确认、持久 Browser profile 和 viewer response
capture。这些结果不能证明其它用户的 entitlement、官方自动化许可、数值 pacing、通用 session
边界或长期稳定性。项目不复制其中的 Cookie、机构身份、Terms 自动点击、selector、profile 或
success verdict。

当前仍缺可读取的自动访问条款、login/entitlement/paywall/challenge marker，以及 primary、
supplement、reader/XML、book chapter 和 wrong article 的现场归属证据。共享 CDN 或平台模板
也不形成共享 risk/session group。因此没有 Browser rule、`browser_rate_limit_group` 或
session key。

## 4. 资产归属与当前实现

明确目标 journal article 且通过统一验证的 PDF 才可能是 `primary-pdf`。Supplementary
material/file 必须保持 supplement；reader、XML、book chapter、loading 页面和 wrong article
必须排除。HTTP 200、PDF 路径名、crawler allowance 或 response capture 都不能跳过统一验证。

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 fixture 为
`tests/fixtures/acquisition/profiles/world-scientific.json`。Fixture 独立证明一秒 crawler delay
不授权 Browser、XML 不冒充 PDF、无 API/Browser、supplement 排除和机构链非生产证据；不保存
真实 DOI、正文、Cookie、账号、机构或 Browser profile。

`unsupported` Profile 不进入 production catalog，不新增 credential section，也不会启动
Browser。替代路径仍是现有通用 Public/OA 来源和用户独立的手动 PDF 接纳。
