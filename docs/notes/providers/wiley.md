# Wiley

- 官方资料与最小只读链路最后在线核对：2026-08-19
- 当前实现离线对照：2026-08-20
- 当前选择键：Acquisition `wiley`
- 供应商角色：在 operator 已取得 Wiley TDM token、运行环境位于可授权公网 IP 范围且具体文章有 entitlement 时提供主文 PDF；不是 SciRetriever Metadata 或引用 Provider
- 当前仓库接入状态：Wiley Online Library TDM API 已作为第二阶段授权 PDF Source 接入；使用所选持久 Profile 的 Wiley Browser route `browser:wiley-online-library` 已进入生产 registry

## 1. 官方来源与证据等级

本轮使用以下 Wiley 官方材料核实合同：

- [Wiley Text and Data Mining](https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining)：官方 TDM 资源入口；当前自动化环境访问仍返回 Cloudflare `HTTP 403` / `cf-mitigated: challenge`，未尝试绕过；
- [WileyLabs/tdm-client](https://github.com/WileyLabs/tdm-client)：Wiley 官方组织发布的 TDM Client。核对版本 `1.2.0`，固定 commit `d5bbac831d473d99f506e845c59503eb09bfc6ff`（2026-07-02）；README 与源码共同给出 PDF、endpoint、认证 header、状态和限流合同；
- [Text Data Mining Client Tokens](https://static.wiley.com/tdm/)：Wiley 官方 token 入口；用户登录 Wiley Online Library、接受适用许可后取得或替换 token。

本文的 `official` 表示上述 Wiley 官方网页、组织仓库或客户端源码明确给出的事实；
`SciRetriever` 表示仓库基于官方事实形成的中性错误/安全映射。2026-08-14 经用户明确
授权执行了一次最小只读链路探测：只记录状态、origin 和 media type，不记录 token、完整
Location、opaque locator、Cookie、响应正文、用户公网 IP、账户或机构信息。该探测确认
API 当前单跳到 `alm.wiley.com` 并返回 `application/pdf`，不把一次结果扩展成长期合同。

## 2. 已核实的 PDF 下载合同

WileyLabs Client 明确提供单篇和批量 DOI PDF 下载。当前 endpoint 是：

```text
GET https://api.wiley.com/onlinelibrary/tdm/v1/articles/{percent-encoded-doi}
Accept: application/pdf
Wiley-TDM-Client-Token: <TDM token>
```

DOI 是一个完整 opaque path parameter，必须 percent-encode `/`、括号和 SICI DOI 等特殊
字符，不能把 DOI 自己拼进 URL，也不能重复编码。SciRetriever 将 canonical DOI 作为
结构化 `path_parameter` 交给共享 Network，由 Network 单独编码；唯一的 token 只作为
绑定到 `https://api.wiley.com:443` 的私有 header 发送。Wiley 官方客户端明确使用
`allow_redirects=True`。当前实测入口返回一次 `302`，目标形状为：

```text
https://alm.wiley.com/alm/api/v2/download/<opaque-locator>
```

这里的 `/alm/api/v2/download/` 是 TDM V1 首跳响应签发的下载 locator 形状，不是另一套
“Wiley TDM V2” API。SciRetriever 的唯一正式内容 API 合同仍是
`/onlinelibrary/tdm/v1/articles/{doi}`；不会把 ALM 内部路径版本外推成可独立调用、搜索或
配置的 V2 产品。

该 locator 是 Provider 生成的单个 opaque path segment，实测不同请求会产生不同层次的
percent encoding。SciRetriever 不对这个签发值做多层本地 path 解释，只为上述精确 HTTPS
origin、固定 path prefix、无 query/fragment 的单跳目标启用 guarded opaque-path；Network
仍检查 raw path、percent/UTF-8、DNS、地址类别和重绑定，并在跨 origin 时剥离
`Wiley-TDM-Client-Token`。完整 Location 和 opaque locator 不进入日志、provenance 或
持久化 `source_url`。

官方客户端当前解释：

| HTTP 状态 | WileyLabs Client | SciRetriever 中性结果 |
|---|---|---|
| `200` | 保存 PDF | 有界临时 PDF，具体文章 entitlement=`GRANTED`，随后统一验证 |
| `403` | `ACCESS_DENIED` | 授权/entitlement 系统失败，不形成耗尽 |
| `404` | `UNKNOWN_DOI` | 正常 `http-404` miss，可继续后续 Source |
| 其它非 `200` | API error | `401` 按通用 HTTP 认证失败、`429` 按 quota、`5xx` 按服务失败，其它按响应合同失败 |
| 网络异常 | Network error | 可重试的 Network/Access 系统失败 |

官方客户端没有进一步固定 `401`、`429` 或其它错误 body schema；SciRetriever 因此只按
稳定 HTTP 类别映射，不解析或保存供应商错误正文。200 响应也不能凭状态码直接接纳：
`Content-Type` 必须无歧义地规范化为 `application/pdf`，字节必须通过 PDF 签名、reader
可打开和至少一页页面树检查，最后再走 hash、provenance 与不可变 Storage 发布。HTML
登录页或错误页即使返回 200 也会被拒绝。

## 3. Token、IP 与单篇 entitlement

官方客户端当前要求：

- Wiley Online Library 账户；
- Wiley 颁发的 TDM token，并把当前签发格式描述为 UUID；
- 调用者公网 IP 位于账户/机构配置的 WOL 内容访问范围；
- 当前 DOI 对该访问环境可用。

TDM API 当前只支持 IP-based access。只有 SSO、从机构范围外运行（例如校外或 Cloud）
等场景不受支持；应由 WOL Account Admin 核对访问模型。由此必须区分五层事实：

1. `tdm_api_token` 字段在本地存在；
2. 生产组装确认它是安全的非空私有 header 值；
3. Wiley 当前服务接受该 token；
4. 当前调用公网 IP 具有相应内容访问路径；
5. 当前 DOI 的 PDF 确实获准下载。

`config status` 只检查第一层的本地字段 presence，不联网；真正构造 Wiley client 时才
检查第二层。SciRetriever 不把官方客户端当前使用 UUID 解释为必须永久硬编码的本地
语法，也不以本地正则替代第三层认证；格式变化、历史 token 和真实有效性均由 Wiley
响应裁决。前两层都不能宣布 token、IP 或文章 entitlement 已通过。某一篇 OA/订阅文章
成功只证明该时间点、该 token/IP/账户环境和该 DOI，不能推导整个 Wiley DOI 空间或
长期授权。

Token 固定保存在 `~/.sciretriever/credentials.toml`：

```toml
[wiley]
tdm_api_token = "<secret>"
```

这里的占位符不是可用 token。真实值不得进入普通 `config.toml`、argv、URL/query、日志、
Model、provenance、fixture、Notes 或错误文本；运行 `sciretriever config`，选择 Wiley 后
通过不回显输入写入，轮换或撤销由 Wiley 官方 token portal 管理。

## 4. 访问速率与共享准入

WileyLabs README 引用 Wiley TDM resources 的限制：

```text
最多 3 articles/second
每 10 分钟最多 60 requests
```

第二条意味着长时间连续运行平均约 10 秒一次。官方客户端批量默认暂停 5 秒，同时明确
提示长期连续使用应提高到 10 秒。SciRetriever 在共享 `wiley/api` Access Coordinator 中
同时表达两项上限：`max_concurrency=3`、最小启动间隔 `1/3` 秒、`60 requests / 600s`。
因此允许官方范围内的短突发，但窗口预算会约束持续调用；`429` 向同一共享 scope 反馈
throttled 状态。当前实现解释标准 HTTP `Retry-After`（delta-seconds 或 HTTP-date），并在
没有有效 header 的 `429/5xx` 上使用保守共享退避。未核实 Wiley 专用 quota header，因此
不猜测自定义字段；标准 header 支持和无 header 退避是通用 HTTP/项目策略，不冒充 Wiley
另外公布的额度合同。

## 5. Source 适用性与阶段顺序

Wiley API 接受 DOI，但 DOI 本身、DOI prefix、publisher 字符串或 MetadataObservation
来自哪家都不能证明文章属于 Wiley。生产 Source 必须同时满足：

1. 当前 Literature 恰有一个 canonical DOI；
2. 全部公开 Source 已正常耗尽；
3. 当前请求具有以下一项强证据：已接纳 AssetHint 的规范 origin 精确为
   `https://onlinelibrary.wiley.com` / `https://alm.wiley.com`，或该 DOI 经共享 Network 的
   安全 resolver 后最终 origin 精确为 `https://onlinelibrary.wiley.com`；
4. `wiley` 已启用、`tdm_api_token` 已配置且本地 AccessPolicy ready。

DOI resolver 不在 Acquisition 开始时提前调用；公开 direct/arXiv/Europe PMC/Unpaywall
等路径先成功时不会产生多余 DOI 网络访问。现有 AssetHint 已精确确认 Wiley 时，Source
只提取规范 origin 并与当前唯一 DOI 绑定，不复制原始 URL、query 或 Provider body，也不再
为了同一身份额外解析 DOI。AssetHint 属于其它 origin、解析得到其它出版社 origin、DOI
resolver 正常 `404/410` 或没有 DOI 时，Wiley 只是不适用；Network、取消、限流和服务错误
会传播稳定失败，不能伪装成 `NoPrimaryPdf`。存在多个 DOI 的异常旧记录不会把一个 origin
套到任一 DOI 上，Wiley fail closed 为不适用。

Wiley 本地 lookup 不联网，只把 DOI 转成 namespace `wiley-tdm-pdf` 的私有下载 locator，
entitlement 保持 `UNKNOWN`；具体 download 的 200 PDF 响应才把该篇 entitlement 证明为
`GRANTED`。获取顺序始终是：

```text
公开来源 → Wiley/其它已配置授权 Provider API → 受控 Browser
```

## 6. 中性映射与禁止进入 Model 的信息

| Wiley 外部事实 | SciRetriever 归属 | 约束 |
|---|---|---|
| canonical DOI + 已确认 WOL/ALM AssetHint origin，或已解析 WOL landing origin | 当前请求的强路由证据 | 只保存规范 origin 并存在于本次 Acquisition；不持久化成出版社事实 |
| TDM API DOI locator | `AuthorizedDownloadLocator` | 非 URL、无 token；只在 Wiley client 边界解释 |
| PDF response bytes | `TemporaryPdfContent` → 统一 PDF 验证 | 有界、可清理；通过后才成为不可变 Asset |
| DOI | 下载 provenance 的 `source_record_id` | 来源为 `wiley`；不复制 header、账户或 entitlement payload |

以下信息不能进入业务 Model 或仓库材料：token/header 值、cookie、账户和机构标识、用户
公网 IP、受限响应正文、登录/Cloudflare HTML、供应商内部 entitlement payload、错误
body，以及从单次成功推导的长期授权/OA/版权结论。Wiley TDM PDF 不反向构造
`LiteratureMetadata` 或引用关系；这些仍由 Metadata/Analysis/Literature 的中性合同负责。

## 7. Browser 画像审查结论

本轮按统一 Profile 门审查了 Wiley Online Library Browser 路径，结论是：Wiley TDM v1 API 与
Browser capability 均为 `production-ready`。该状态只表示当前 route/rule/policy、离线 fixture、
生产对象图和安全测试闭环，不表示当前 IP、机构协议或任意文章 entitlement 已在线证明。

生产规则 `wiley-online-library-pdf@3` 只接受强 DOI/WOL landing，精确允许
`https://onlinelibrary.wiley.com` 与 `https://advanced.onlinelibrary.wiley.com`；后者是经审查的
DOI landing alias，不会因为 resolver 第一跳进入 advanced 主机而跳过 Wiley Browser route。
规则从 `/doi/pdfdirect/`、`/doi/pdf/` 或 `/doi/epdf/` 的 response、download、popup、viewer 或
verified locator 中等待任一正文 capture，并排除 supporting information、excluded 和
wrong-article。规则包含 entitlement/paywall、login、MFA/challenge、rate/IP/account-warning
等封闭页面状态；Challenge 由作业开始前选定的 Rules 或 Agent controller 按统一页面合同继续
处理，登录/MFA 页面仍识别后停止，裸 403 则单独记录为 access denied。

Revision 3 的新增证据日期为 2026-08-21，只为 Wiley 规则声明受限的 Cloudflare dependency：
精确 origin `https://challenges.cloudflare.com`、path prefix
`/cdn-cgi/challenge-platform/` 与 `/turnstile/v0/`，且资源类型只允许 `script`、
`document`、`fetch`、`xhr` 和 `image`。它不加入 Wiley 的普通
`allowed_origins`；只有当前 Wiley Publisher 页面或其 frame ancestry 能给出发起与用途证明时才
可加载，不能作为初始/任意顶层导航、popup、PDF locator 或 capture source。这里记录的
`resource-blocked`、`settling`、`cleared`、`interaction-required` 与 `settle-timeout` 是
2026-08-21 旧 Challenge 子生命周期的历史 fixture 词汇，不是当前运行合同。当前 Rules 只执行
已审查动作，Agent 可以使用统一元素/坐标点击；controller 停止时仍为 Challenge 形成文章级
`challenge-unresolved`，不会打开 Challenge group circuit。该封闭规则和本地 fixture 只证明程序
没有自行挡住必要资源，不证明当前 IP、机构合同或文章 entitlement。

2026-08-22 的固定单篇真实串行 A/B 中，stock 与 Cloak 各自加载 17 个上述受限资源，本地阻断
均为 0，随后都在有界窗口形成 `settle-timeout`，没有捕获 PDF。这个结果证明当前文章绑定、
Turnstile 路径和 image 子资源没有再被 SciRetriever 自己误拦；它不证明自动验证已通过、文章有
权限或 Cloak 提高了下载成功率，也没有触发 CAPTCHA 点击。

CBA72 将 Wiley Browser 的本次服务器现场准入记为 `deferred`。这不降低
`wiley-online-library` 的 `production-ready` 工程状态，不删除生产 Browser rule，也不影响
独立的 TDM API route；它只表示固定代表样本停在持续自动验证且没有可验证 PDF。

ScanSci PDF revision `5e4a6f20ee32b16c0fcb52e37b66ca7a0b31edc5` 提供了
`/doi/pdfdirect/`、`/doi/pdf/`、`/doi/epdf/`、若干 supplement marker，以及一次转到
`advanced.onlinelibrary.wiley.com` 的历史运行线索；但其 verification record 同时依赖
CARSI Cookie、个人机构 Browser profile 和仓库中不存在的本地 source run。它不能证明这些
origin、模板、marker 或成功结论在 SciRetriever 中仍成立，详见
[ScanSci 迁移审计](../scansci-migration-audit.md)。当前常量是经独立 Profile/rule/fixture 审查后
形成的 SciRetriever 合同，不继承上游 CARSI Cookie、Profile 数据或 success verdict。

Browser 使用当前机器正常网络出口，以及共享 persistent Profile/context 中独立的 `wiley`
lane；组内并发 1、项目审慎最小文章启动间隔 20 秒，不猜测 Atypon 共享风险域。自动流程不导入或
读取 Cookie、不填写凭据；第一版不提供可见 Browser 认证入口。TDM API 的认证、quota、service
或 network failure 仍按第二层
失败合同处理，不能靠 Browser 绕行；只有 API 正常未命中或无该文章 entitlement，且其它
Browser admission 条件成立时才可能升级。

## 8. 当前实现与未闭合事项

当前生产实现已包含：Wiley 专用 client、精确 endpoint、单一安全非空 token、私有认证
header、opaque DOI 编码、到 `alm.wiley.com` 的 guarded 单跳 redirect、跨 origin token
剥离、AccessPolicy、HTTP 状态映射、单 DOI 与精确 landing/asset-origin target 绑定、
Registry/Bootstrap/config status 接线，以及离线 endpoint/凭据泄漏/跨 origin/阶段顺序/PDF
验证测试。生产 Browser rule 另覆盖 DOI/landing 归属、批准的 WOL/advanced origin、封闭页面
状态、正文/supplement/错文分类、组内调度、article lane 隔离与临时下载工作区清理。没有新增
`wiley-tdm` 依赖，直接复用共享 Network。

仍未闭合的外部事实是：官方客户端未详细规定 `401/429` 及其它错误 body、token 有效期/
自动过期策略、专用 quota response header、ALM locator 的长期版本保证，以及非
IP-based TDM API 支持。更新这些事实前应再次核对 Wiley 官方材料；真实 Provider 探测
只能由用户明确发起，仓库测试继续使用离线 fake。2026-08-19 本轮没有读取 token、调用真实
Wiley API、访问真实文章或下载真实 PDF。Production Planner 同时认识
`api:wiley-tdm-v1` 与 `browser:wiley-online-library`，但仍严格保持 Public → API → Browser，且
Browser 使用所选持久 Profile 与当前机器正常网络出口。Profile 是否存在、是否保存过登录状态、
机构 IP 和当前文章 entitlement 是分立事实，仍在真实页面逐文章判断。
