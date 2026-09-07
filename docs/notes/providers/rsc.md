# RSC Publishing

- 官方资料最后在线核对：2026-08-19
- 配置选择键：无；RSC Publishing 是 Publication/Access Provider
- Access Platform：`https://pubs.rsc.org`
- 当前仓库接入状态：`production-ready` Profile；无专属 Public 或授权 PDF API route；Profile 只启用首页可达性 probe，真实文章统一使用 `browser:generic`

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

当前 Profile 只把 DOI prefix `10.1039` 及 `Royal Society of Chemistry` / `RSC Publishing` 文本作为弱提示。它们不能单独证明原文访问方；只有实际 RSC landing、可信 asset origin 或其它强证据才能让 production resolver 收敛到该 Profile。

ScanSci 记录过以下页面形状：

```text
landing: /en/content/articlelanding/{year}/{journal}/{article-id}
PDF:     /en/content/articlepdf/{year}/{journal}/{article-id}
```

以及一次 `rsc_articlepdf` 成功。这些仅是待核实上游观察，不能证明 URL 是长期官方合同、当前账号 entitlement 或正文归属，也不能替代每次 redirect/response 的 origin guard。

RSC article page 可能同时提供 Electronic Supplementary Information（ESI）。当前技术 fixture 已
验证封闭正文 action、ESI、excluded 与 wrong-article 分类；它不表示已经识别真实站点所有 ESI
形状，也不能把通用 `/articlepdf/` selector 或 HTML extractor 提升为生产合同。

## 4. 当前状态与实现边界

`rsc-publishing` Profile 的状态为 `production-ready`：

- 无经过核实的 direct PDF API 或专属 public route；
- 不拥有专属 Browser route、rule、selector 或调度组；合法文章起点统一进入
  `browser:generic`，由 Agent 选择封闭动作，Network capture 后由 Acquisition 独立验证正文、
  ESI/wrong-article 与目标身份；
- 官方普通条款限制自动化软件下载，TDM 项目要求预先联系；operator 必须确认实际用途符合组织
  授权与 RSC 条款，Browser 总开关不构成许可证明；
- `browser_probe_enabled = true` 只允许配置中心打开 RSC 首页检查 runtime/目标可达；真实文章
  只有在前两层正常未命中、起点合法且通用 runtime 就绪时才进入 Browser；
- 不复制 ScanSci 的 generic selector、CARSI/Cookie 文件、任意脚本和 success verdict；
- 不新增 Metadata Provider 或 credential section。

以下 Revision 3、`rsc-publishing-pdf@*`、RSC lane 和 Challenge 子生命周期均是旧规则执行器的
历史证据，不是当前 runtime 合同。Revision 3 的新增证据日期为 2026-08-21，只为当时的 RSC
规则声明受限的 Cloudflare dependency：
精确 origin `https://challenges.cloudflare.com`、path prefix
`/cdn-cgi/challenge-platform/` 与 `/turnstile/v0/`，且资源类型只允许 `script`、
`document`、`fetch`、`xhr` 和 `image`。它不加入 RSC 的普通
`allowed_origins`；只有当前 RSC Publisher 页面或其 frame ancestry 能给出发起与用途证明时才
可加载，不能作为初始/任意顶层导航、popup、PDF locator 或 capture source。这里记录的
`resource-blocked`、`settling`、`cleared`、`interaction-required` 与 `settle-timeout` 是
2026-08-21 旧 Challenge 子生命周期的历史 fixture 词汇，不是当前运行合同。当前运行只把它分类为
统一 `page_state=CHALLENGE`。旧 controller 停止时仍未清除会形成文章级
`challenge-unresolved`。该 fixture 只证明旧程序没有自行挡住必要资源，不证明当前通用 Agent、
当前 IP、机构合同或文章 entitlement。

2026-08-22 的固定单篇真实串行 A/B 中，stock 与 Cloak 各自加载 17 个上述受限资源，本地阻断
均为 0，随后都在有界窗口形成 `settle-timeout`，没有捕获 PDF。这个结果证明当前文章绑定、
Turnstile 路径和 image 子资源没有再被 SciRetriever 自己误拦；它不证明自动验证已通过、文章有
权限或 Cloak 提高了下载成功率，也没有触发 CAPTCHA 点击。

CBA72 将 RSC 的本次服务器现场准入记为 `deferred`。这不降低其 `production-ready` 工程状态、
也不等于其它机构/Profile 全局 unsupported；它只表示固定代表样本在旧执行器中停在持续自动
验证且没有可验证 PDF。

现有来源若明确提供安全的 RSC PDF/landing `AssetHint`，仍可在第一层通过通用 Public Source 获取，并接受实际字节、PDF reader、页面树、来源依据与不可变发布检查。该路径不会因为存在 RSC Profile 而跳过授权判断，也不会把第一层失败自动升级到 Browser。

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 Profile fixture
为 `tests/fixtures/acquisition/profiles/rsc-publishing.json`。Fixture 不再保存页面规则、调度组或
文章下载准入。本轮没有真实 entitlement 或内容下载证据；当前 IP 或一次页面可达也不能证明具体
文章 entitlement。Browser 总开关关闭时通用 route 不构造可执行 adapter；启用后也不放宽通用
Network guard、正文/ESI 归属或 PDF 文章身份验收。
