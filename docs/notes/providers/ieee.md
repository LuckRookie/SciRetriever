# IEEE Xplore

- 官方资料最后在线核对：2026-08-15
- 配置选择键：无；IEEE Xplore 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://ieeexplore.ieee.org`
- 当前仓库接入状态：已进入 Publisher 验证矩阵，状态为 `unsupported`；已记录 Full-Text Access API 方向，但无可执行授权 PDF API 或 Browser production route

## 1. 官方入口与证据

- [IEEE Xplore](https://ieeexplore.ieee.org/)：文章平台入口。
- [IEEE Xplore API documentation](https://developer.ieee.org/docs)：Metadata、Open Access 与 Full-Text Access API 能力索引。
- [Chargeable Full Text Requests](https://developer.ieee.org/Chargeable_Full_Text_Requests)：销售开通、authorization key、token 和 article request 的最小公开合同。
- [IEEE Xplore API Terms of Use](https://developer.ieee.org/API_Terms_of_Use2)：API 许可、调用额度和 automated retrieval 限制。
- [IEEE Xplore robots.txt](https://ieeexplore.ieee.org/robots.txt)：当前 crawler 路径声明；不能替代内容许可或 Browser policy。

上述材料均为 `official`。本轮没有注册 IEEE developer 账户、读取 API key、联系销售、调用 API、访问文章、执行机构登录/2FA 或下载全文。

## 2. 官方 API 能力与当前缺口

开发者门户当前列出三类相关能力：

```text
Metadata Search API
Open Access API
Full-Text Access API
```

Open Access API 描述为可查询 OA full-text，也可涉及 chargeable full-text；收费 Full-Text Access API 描述为检索 chargeable full-text。公开的收费流程只有：销售开通的 authorization key → 获取 token → 随 article request 发送 token。当前匿名文档没有给出足以安全实现的 endpoint、请求/响应 schema、媒体类型、PDF 对象归属、token origin/生命周期或具体 rate limit；rate limit 只在注册过程显示，并可由 IEEE 修改。

所以 SciRetriever 不能把“full-text”自动解释为 PDF，也不能新增一个用户无法按文档配置和离线验证的 credential section。若以后取得正式产品合同，应作为第二层官方 API 单独实现：authorization key/token 只能绑定到精确官方 origin，调用共享真实 quota scope，并且只有明确的主 PDF bytes 才能形成 `TemporaryPdf`。

API 条款还要求除 IEEE 明确提供的方式外不要绕开 API 获取内容，并禁止 robot、spider 或 site search/retrieval application 批量检索/索引。它不构成普通 article Browser 的许可。

## 3. `arnumber`、DOI 与 PDF 线索

IEEE Xplore 的稳定文章定位可由数字 `arnumber` 表达；当前 Profile 为未来运行时证据声明 `ieee-arnumber` namespace。一个来源明确、经过边界验证的 `ieee-arnumber` 可以比 publisher 文本更强地定位 Xplore article，但它不证明当前账号 entitlement、媒体类型或 route readiness。

DOI prefix `10.1109` 及 `IEEE` / `Institute of Electrical and Electronics Engineers` 文本只作弱提示。没有 arnumber 或实际 DOI landing 时，不能用 DOI suffix 猜 arnumber。

ScanSci 记录过以下形状：

```text
landing: /document/{arnumber}
PDF:     /stampPDF/getPDF.jsp?...&arnumber={arnumber}
viewer:  /stamp/stamp.jsp?...&arnumber={arnumber}
```

其成功记录依赖特定机构的 OpenAthens、SSO、2FA 和返回代理链。SciRetriever 不复制其中的高校身份、CARSI/Cookie 文件、CloakBrowser 或 success verdict；这些观察也不能证明 stamp response 的长期 URL、supplement 排除或其它用户的 entitlement。

## 4. Browser 结论

当前没有生产 Browser rule：

- 官方自动访问方向是经过许可的 API，而非可自由批量执行的 article Browser；
- 没有公开的 Browser article interval/window、共享 risk/session group 或 session lifetime；
- 没有独立核实 institutional sign-in、authenticated/entitled、paywall/not-entitled、MFA/challenge/rate/account-warning marker；
- 没有证明 stamp PDF、supplementary multimedia、standards/cover、wrong article 的封闭归属规则；
- 上游特定机构 SSO/2FA 记录不能转成通用生产行为，也禁止自动完成 MFA。

因此 `ieee-xplore` 状态为 `unsupported`，没有 Browser route 或新增 Metadata credential。若未来先
补齐官方政策、封闭规则和离线证据，并由用户另行授权现场核实，也必须使用普通配置选中的持久
Profile、当前机器正常网络出口和一篇批准样本；无 GUI Linux 使用 Xvfb，probe 不开放交互，按
独立 IEEE risk group 串行。自动流程不得填写凭据、导入 Cookie 或处理 MFA/challenge；需要用户
认证时只能通过配置中心的独立显式可见 Browser 动作完成。现场结果仍不能替代 Full-Text API 的
独立产品合同，也不能证明 Profile 已登录或任意文章 entitlement。

## 5. 当前实现边界

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 fixture 为 `tests/fixtures/acquisition/profiles/ieee-xplore.json`。Fixture 证明 `ieee-arnumber` 与弱 DOI/publisher 证据分离、官方 API 合同仍不完整、无 executable route；不保存真实文章号、token、Cookie、机构或正文。

现有来源明确提供的安全 IEEE PDF/landing `AssetHint` 仍可走通用第一层，并接受实际字节、PDF reader、页面树、来源依据和不可变发布检查。unsupported Profile 不删除公开候选，也不会把失败升级到 IEEE Browser。
