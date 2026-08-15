# American Mathematical Society

- 官方资料最后在线核对：2026-08-15
- 配置选择键：无；American Mathematical Society 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://www.ams.org`
- 当前仓库接入状态：已进入 Publisher 验证矩阵，状态为 `unsupported`；无专属 Public、授权 API 或 Browser production route

## 1. 官方入口与身份边界

- [AMS journals](https://www.ams.org/journals)：官方期刊入口。
- [AMS open access](https://www.ams.org/publications/journals/open-access)：官方开放获取入口；本轮匿名请求返回 403，正文未核实。
- [AMS subscriber information](https://www.ams.org/publications/journals/subscriber-information)：官方订阅信息入口；本轮匿名请求返回 403。
- [AMS terms of use](https://www.ams.org/about-us/governance/terms-of-use)：官方条款入口；本轮匿名请求返回 403。
- [ams.org robots.txt](https://www.ams.org/robots.txt)：当前可匿名读取的 managed crawler signal。

本计划中的 AMS 是 **American Mathematical Society**，其常见 DOI prefix 是 `10.1090`。
ScanSci 材料中的 `journals.ametsoc.org`、`10.1175` 和 AMS 简称指向 **American
Meteorological Society**，是另一家 Publisher。两者不得共享 origin、URL 模板、fixture、
Browser verdict、risk group 或 session。

`10.1090`、AMS 名称和数学文本只作弱提示，不能独立证明 canonical landing、文章版本或
entitlement。可信来源明确给出的 AMS PDF/landing `AssetHint` 仍可由通用第一层逐项尝试，
并继续经过 URL 安全、许可证、实际字节、PDF reader、页面树、文章身份和不可变发布检查；
Profile 不为此注册专属 Public route。

## 2. 官方 policy 与机器访问结论

AMS 的 robots 当前只给出 Cloudflare managed content signal：`search=yes`、`ai-train=no`、
`use=reference`。这可以证明 reference/search 用途的 crawler 信号，不能扩张为全文使用、
自动下载、机构授权 Browser 或数值 article-start pacing。

本轮没有得到可核实的机器访问/PDF API endpoint、认证产品、响应 schema、媒体类型、quota
scope 或错误语义，因此 authorized API capability 为 `unsupported`。公开条款、OA 和订阅
正文当前无法匿名审查，也不能由旧脚本、DOI 形状或另一家“AMS”的结果代替。

## 3. Browser 结论

当前没有 AMS Browser rule，原因包括：

- 缺可读取的自动访问条款和数值文章间隔；
- 缺 login、authenticated/entitled、paywall/not-entitled、challenge/MFA/rate/account-warning
  的封闭 marker；
- 缺 primary PDF、supplement 和 wrong-work 的现场归属证据；
- 缺可推广的机构 session、credential origin 和 account-risk policy。

ScanSci 对 `journals.ametsoc.org` 的 success/unsupported 结果不属于本 Publisher，不能作为
AMS Mathematics 的生产证据。当前不建立 `browser_rate_limit_group` 或 session key，也不启动
Browser。

## 4. 资产归属与当前实现

明确 AMS Mathematics 文章且通过统一验证的 PDF 才可能是 `primary-pdf`。Supplementary
material/file 必须保持 supplement；American Meteorological Society 内容、front matter、
loading 页面和 wrong work 必须排除。HTTP 200、PDF 扩展名和 DOI prefix 都不能跳过统一归属
检查。

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 fixture 为
`tests/fixtures/acquisition/profiles/american-mathematical-society.json`。Fixture 独立证明
`10.1090`/`10.1175` 的 Publisher 区分、无 API/Browser、supplement 排除和当前证据缺口；不
保存真实 DOI、正文、Cookie、账号、机构或 Browser profile。

`unsupported` Profile 不进入 production catalog，不新增 credential section。替代路径仍是
现有通用 Public/OA 来源和用户独立的手动 PDF 接纳。
