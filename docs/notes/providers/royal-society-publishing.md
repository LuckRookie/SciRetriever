# Royal Society Publishing

- 官方资料最后在线核对：2026-08-15
- 配置选择键：无；Royal Society Publishing 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://royalsocietypublishing.org`
- 当前仓库接入状态：已进入 Publisher 验证矩阵，状态为 `unsupported`；无专属 Public 或授权 API，Profile 不提供首页 probe；具有合法文章起点的目标仍可使用 `browser:generic`

## 1. 官方入口与本轮证据边界

- [Royal Society Publishing](https://royalsocietypublishing.org/)：官方期刊平台 origin。
- [Platform terms](https://royalsocietypublishing.org/terms)：官方条款入口。
- [Royal Society open access](https://royalsociety.org/journals/open-access/)：官方 OA 入口。
- [royalsocietypublishing.org robots.txt](https://royalsocietypublishing.org/robots.txt)：官方 robots 入口。

上述平台首页、条款、OA 页面和 robots 在本轮匿名核对中均返回 403，正文未核实。本轮没有访问
文章正文、打开 PDF、登录机构账号、读取 Cookie/profile、完成 SSO 或绕过 challenge。当前结论
保留不可审查缺口，不用第三方 URL 模板或 success verdict 代替官方 policy。

常见 DOI prefix `10.1098` 与 Royal Society 名称只作弱提示，不能独立证明 canonical landing、
具体刊物、文章版本或 entitlement。可信来源明确提供的 Royal Society PDF/landing `AssetHint`
仍可由通用第一层逐项尝试，并经过 URL 安全、许可证、实际字节、PDF reader、页面树、文章
身份和不可变发布检查；Profile 不注册专属 Public route。

## 2. API 与 Browser 结论

本轮没有得到可核实的机器访问/PDF API endpoint、认证产品、响应 schema、媒体类型、quota
scope 或错误语义，因此 authorized API capability 为 `unsupported`。

当前证据不足以建立 Royal Society 专属 Browser 页面程序或首页 probe：

- 可读取的自动访问条款和数值 article-start pacing；
- login、authenticated/entitled、paywall/not-entitled、challenge/MFA/rate/account-warning 的
  封闭 marker；
- primary PDF、supplement、media/loading 页面和 wrong article 的现场归属证据；
- 可推广的机构 session、credential origin 和 account-risk policy。

ScanSci 的单个 Browser success 不能证明长期 entitlement、页面状态、供应商政策或归属。共享
CDN、路径形状或平台模板也不证明 Royal Society 与其它 Publisher 共享 risk/session group。
所以当前没有 Browser rule、`browser_rate_limit_group` 或 session key。

## 3. 资产归属与当前实现

明确目标文章且通过统一验证的 PDF 才可能是 `primary-pdf`。Supplementary material/file 必须
保持 supplement；media、loading 页面和 wrong article 必须排除。HTTP 200、PDF 路径名和上游
文本匹配不能跳过统一验证。

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 fixture 为
`tests/fixtures/acquisition/profiles/royal-society-publishing.json`。Fixture 独立证明官方政策
当前不可匿名审查、无 API/Browser、supplement 排除和上游 success 非生产证据；不保存真实
DOI、正文、Cookie、账号、机构或 Browser profile。

`unsupported` Profile 不进入 production catalog，不新增 credential section，也不会启动
Browser。替代路径仍是现有通用 Public/OA 来源和用户独立的手动 PDF 接纳。
