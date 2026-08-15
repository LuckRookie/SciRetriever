# Frontiers

- 官方资料最后在线核对：2026-08-15
- 配置选择键：无；Frontiers 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://www.frontiersin.org`
- 当前仓库接入状态：已进入 Publisher 验证矩阵，状态为 `unsupported`；无专属 Public、授权 PDF API 或 Browser production route

## 1. 官方开放获取与入口

- [Frontiers journals platform](https://www.frontiersin.org/)：官方平台 origin。
- [Frontiers open access](https://www.frontiersin.org/about/open-access)：官方 OA 说明。
- [Frontiers terms and conditions](https://www.frontiersin.org/legal/terms-and-conditions)：官方条款入口。
- [frontiersin.org robots.txt](https://www.frontiersin.org/robots.txt)：当前 crawler 路径 policy。

OA 页面明确说明 Frontiers 是 gold open-access publisher，全部期刊文章在发布时立即、永久、免费
在线，并按 CC BY 许可允许在注明原始作者和来源的条件下使用、分发和复制。常见 DOI prefix
`10.3389` 与 Frontiers 名称仍只作弱提示，不能独立启用 Publisher route。

官方 robots 对通用 user-agent 允许 `/`，但禁止 image、production、review、mail、admin 等路径，
没有发布数值 crawl delay。条款 URL 当前返回 200，但匿名静态响应只有应用 shell，正文未能在不
运行真实 Provider Browser 的边界内审查。开放许可与 crawler allowance 不能补出稳定的机器 PDF
endpoint、数值下载政策或批量合同。

## 2. Public、API 与 Browser 结论

可信来源明确提供的 Frontiers PDF/landing `AssetHint` 仍由通用第一层逐项消费，并继续经过
URL/DNS/redirect、许可证、实际字节、PDF reader、页面树、文章身份和不可变发布检查。当前不
根据 DOI 猜 `/articles/{doi}/pdf`；ScanSci 的模板和 success verdict 不是官方稳定合同，也不能
绕过强 landing evidence。

本轮没有得到可核实的机器 PDF API endpoint、schema、媒体类型、quota scope 或错误语义，因而
authorized API capability 为 `unsupported`。OA 正文正常不需要机构登录，Browser 不会提高访问
资格；当前也缺自动访问条款、数值 article policy、页面 marker 和 primary/supplement 现场规则。
所以没有 Browser rule、risk group 或 session key。

## 3. 资产归属与当前实现

明确目标 Frontiers article 且通过统一验证的 PDF 才可能是 `primary-pdf`。Supplementary
material/file 必须保持 supplement；ebook、Research Topic 页面、HTML 和 wrong article 必须
排除。OA 标志、HTTP 200、PDF 路径或第三方文本匹配都不是最终归属证据。

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 fixture 为
`tests/fixtures/acquisition/profiles/frontiers.json`。Fixture 独立证明 CC BY OA、无专属机器 PDF
合同、无 Browser 和猜测模板不准入；不保存真实 DOI、正文、响应、Cookie、账号或 Browser
profile。

`unsupported` Profile 不进入 production catalog，也不新增 credential section。当前有效替代
路径是通用可信 Public/OA hint 和用户独立的手动 PDF 接纳。
