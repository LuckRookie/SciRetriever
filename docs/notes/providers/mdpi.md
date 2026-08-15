# MDPI

- 官方资料最后在线核对：2026-08-15
- 配置选择键：无；MDPI 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://www.mdpi.com`
- 当前仓库接入状态：已进入 Publisher 验证矩阵，状态为 `unsupported`；无专属 Public、授权 PDF API 或 Browser production route

## 1. 官方入口与本轮证据缺口

- [MDPI journals platform](https://www.mdpi.com/)：官方平台 origin。
- [MDPI open access](https://www.mdpi.com/about/openaccess)：官方 OA 入口。
- [MDPI terms and conditions](https://www.mdpi.com/about/terms-and-conditions)：官方条款入口。
- [mdpi.com robots.txt](https://www.mdpi.com/robots.txt)：官方 robots 入口。

上述首页、OA、条款和 robots 在本轮匿名核对中均返回 403，正文未核实。本轮没有访问文章正文、
打开 PDF、运行真实 Provider Browser、读取 Cookie/profile、登录账号或绕过 challenge。当前结论
保留这一证据缺口，不用 ScanSci 的 URL 模板、浏览器结果或 MDPI 的一般 OA 声誉代替官方 policy。

常见 DOI prefix `10.3390`、MDPI 名称和 ISSN 路径只作弱提示，不能独立证明 canonical landing、
文章版本、PDF route 或访问政策。可信来源明确提供的精确 HTTPS PDF/landing `AssetHint` 仍可由
通用第一层逐项消费，并继续经过 URL/DNS/redirect、许可证、实际字节、PDF reader、页面树、
文章身份和不可变发布检查。

## 2. Public、API 与 Browser 结论

当前没有可匿名审查的官方 per-article PDF HTTP 合同、数值下载政策或可实现的机器 PDF API
endpoint/schema/quota。Profile 因而不从 DOI 或 ISSN 猜 `/pdf` 路径，也不注册 Public/API route。

开放获取内容原则上不需要机构 Browser；匿名 challenge 也不能成为自动升级 Browser 的理由。
当前还缺自动访问条款、数值 article-start policy、login/entitlement/paywall/challenge marker、
primary/supplement 现场归属和 account-risk policy。因此没有 Browser rule、risk group 或 session
key，不复制上游 Cookie、profile、selector 或 success verdict。

## 3. 资产归属与当前实现

明确目标 MDPI article 且通过统一验证的 PDF 才可能是 `primary-pdf`。Supplementary
material/file 必须保持 supplement；HTML、XML、book chapter、loading/challenge 页面和 wrong
article 必须排除。HTTP 200、PDF 扩展名、ISSN 路径或 OA 文本不能跳过统一验证。

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 fixture 为
`tests/fixtures/acquisition/profiles/mdpi.json`。Fixture 独立证明官方页面当前不可匿名审查、无
专属 API/Browser 和猜测模板不准入；不保存真实 DOI、正文、响应、Cookie、账号或 Browser
profile。

`unsupported` Profile 不进入 production catalog，也不新增 credential section。当前有效替代
路径是通用可信 Public/OA hint 和用户独立的手动 PDF 接纳。
