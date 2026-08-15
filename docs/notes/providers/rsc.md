# RSC Publishing

- 官方资料最后在线核对：2026-08-15
- 配置选择键：无；RSC Publishing 是 Publication/Access Provider
- Access Platform：`https://pubs.rsc.org`
- 当前仓库接入状态：已进入 Publisher 验证矩阵，状态为 `unsupported`；无专属 Public、授权 PDF API 或 Browser production route

## 1. 官方入口与证据

- [RSC Publishing](https://pubs.rsc.org/)：文章平台入口。
- [AI and TDM applications](https://www.rsc.org/publishing/product-information/product-catalogue/text-and-data-mining)：机器访问、许可和学术 TDM 指引。
- [Access and usage terms](https://www.rsc.org/publishing/product-information/access-and-usage/terms-and-conditions)：online product、认证、非商业使用和自动下载边界。
- [RSC website terms](https://www.rsc.org/help-and-legal/terms-of-use)：站点浏览、单份下载和一般使用边界。
- [RSC Publishing robots.txt](https://pubs.rsc.org/robots.txt)：当前 crawler 路径声明；不是内容授权或 Browser policy。

上述页面均为 `official`。本轮没有访问文章、下载正文/ESI、登录机构账号或读取 Cookie；只匿名读取公开政策与 robots 文本。

## 2. 自动访问与 TDM 边界

RSC 的 AI/TDM 页面说明，学术研究者是否可以对 article page 内容做非商业 TDM 取决于当地法律，并应向机构 librarian 确认；计划 text mining project 时应事先联系 RSC，以便确保机器访问不影响其他用户或违反条款。页面没有给出可以直接转成 Browser article-start interval/window 的数值政策。

RSC 的非商业使用条款更明确：用户不得使用任何自动化软件（包括 web crawler）下载 RSC Information，这类活动被描述为 strictly forbidden。条款允许用户通过 Secure Authentication 手工检索、查看、复制或下载内容用于个人非商业研究，但这不扩大为默认批量 Browser 权利。

因此 SciRetriever 不会把“机构账号可访问”“非商业研究”或上游单篇成功解释成自动下载许可。若未来有 RSC/机构明确许可，需要在单独现场核实单中记录许可范围、文章/请求预算和停止条件；当前不能猜一个保守 sleep 来替代授权与官方 policy。

## 3. 身份、locator 与 ESI

当前 Profile 只把 DOI prefix `10.1039` 及 `Royal Society of Chemistry` / `RSC Publishing` 文本作为弱提示。它们不能单独证明原文访问方；当前 unsupported Profile 也不进入 production resolver。

ScanSci 记录过以下页面形状：

```text
landing: /en/content/articlelanding/{year}/{journal}/{article-id}
PDF:     /en/content/articlepdf/{year}/{journal}/{article-id}
```

以及一次 `rsc_articlepdf` 成功。这些仅是待核实上游观察，不能证明 URL 是长期官方合同、当前账号 entitlement 或正文归属，也不能替代每次 redirect/response 的 origin guard。

RSC article page 可能同时提供 Electronic Supplementary Information（ESI）。没有独立页面 fixture 证明正文 action、ESI link、filename、response origin 和 wrong-article identity 前，任何通用 `/articlepdf/` selector 或 HTML extractor 都不能成为生产规则。Evidence fixture 明确把 ESI PDF 标为 `supplement`，但这只是 fail-closed 预期，不声称已经识别真实站点所有 ESI 形状。

## 4. 当前状态与实现边界

`rsc-publishing` Profile 的状态为 `unsupported`：

- 无经过核实的 direct PDF API 或专属 public route；
- 无 Browser rate/session group、页面状态 marker、正文/ESI capture rule 或 executable route；
- 不复制 ScanSci 的 generic selector、CARSI/Cookie 文件、任意脚本和 success verdict；
- 不新增 Metadata Provider 或 credential section。

现有来源若明确提供安全的 RSC PDF/landing `AssetHint`，仍可在第一层通过通用 Public Source 获取，并接受实际字节、PDF reader、页面树、来源依据与不可变发布检查。该路径不会因为存在 RSC Profile 而跳过授权判断，也不会把第一层失败自动升级到 Browser。

生产源码的 secret-free 结论位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 evidence fixture 为 `tests/fixtures/acquisition/profiles/rsc-publishing.json`。本轮没有真实 entitlement 或内容下载证据。
