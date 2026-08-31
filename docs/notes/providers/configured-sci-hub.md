# Configured Sci-Hub

- 外部事实最后核对：2026-08-28（Asia/Shanghai）
- 当前实现离线对照：2026-08-28
- 当前选择键：Acquisition `sci-hub`
- 启用语义：Source 默认关闭；operator 显式启用后使用当前版本 bundled mirror set，custom
  `urls` 完整覆盖 bundled，Python 显式注入 resolver 又优先于两者
- 当前 bundled 列表：`https://sci-hub.ru`、`https://sci-hub.kr`
- 当前仓库接入状态：`public:sci-hub` operator-locator route 已接入生产 Acquisition registry
  与三级 Planner；stock CLI、纯本地 status、TOML custom override 和 Reset 均已接入

## 1. 搜索、核验与证据边界

当前没有找到可作为稳定生产合同的公开官方 API 文档，因此不存在可以按 `official` 记录的
endpoint、认证、响应 schema、分页、限流或错误码。2026-08-28 通过浏览器搜索和搜索结果对照，
共收集到至少 22 个不同的候选或聚合域名：

```text
sci-hub.se       sci-hub.st       sci-hub.ru       sci-hub.kr
sci-hub.wf       sci-hub.ee       sci-hub.ren      sci-hub.tf
sci-hub.tw       sci-hub.in       sci-hub.al       scihub.help
sci-hub.shop     sci-hub.mobi     scihub.wiki      sci-hub.name
sci-hub.sh       scihub.vip       sci-hub.works    sci-hubse.com
scihub.ink       sci-hub.run
```

这个数字是“搜索结果中声称相关的不同域名数”，不是可用镜像数，也不是全球完整总数。搜索摘要中
的 `official`、`live` 或 `verified` 标签只用于发现候选，不能单独成为接入证据。域名会失效、
被接管、变成聚合页或随地区和时间呈现不同结果。

本次只对其中 11 个反复出现或由页面重定向暴露的候选执行受限根页面核验。检查范围只有 DNS、
正常证书验证下的 TLS、HTTPS redirect、最终根页面状态、页面标题/标识以及是否存在 DOI 表单；
没有提交 DOI、没有搜索或下载论文、没有执行 JavaScript、没有处理 Challenge/CAPTCHA，也没有
绕过登录、访问控制或地区限制。

| 根入口 | 当前环境 observation | 结论 |
| --- | --- | --- |
| `https://sci-hub.ru/` | TLS 验证通过；HTTP 302 到 `https://sci-hub.kr/`；最终 200，页面标题为 Sci-Hub，存在表单和 DOI 标识 | bundled 第一入口；可跟随镜像轮换 redirect |
| `https://sci-hub.kr/` | TLS 验证通过；HTTP 200；页面标题为 Sci-Hub，存在表单和 DOI 标识 | bundled 第二入口；当前直接落点 |
| `https://sci-hub.se/` | 当前网络 TLS 握手失败 | 不内置；不能据此断言全球永久失效 |
| `https://sci-hub.st/` | 证书为 self-signed，标准校验失败 | 不内置；不得以关闭证书校验绕过 |
| `https://sci-hub.wf/` | TLS/200，但只返回 “Checking your browser…” Challenge | 不适合当前静态 locator parser |
| `https://sci-hub.ee/` | TLS/200，但标题为 proxy search links | 聚合/代理页，不作为通用镜像 |
| `https://sci-hub.ren/` | TLS/200，但表单提交到另一第三方 origin | 不作为稳定通用镜像 |
| `https://sci-hub.tf/` | 跳转到无关游戏广告页面 | 已劫持或停放，不内置 |
| `https://sci-hub.tw/` | 当前网络 TLS connection timeout | 不内置；不能据此断言全球永久失效 |
| `https://sci-hub.in/` | TLS/200，但表单提交到另一第三方 origin | 不作为稳定通用镜像 |
| `https://sci-hub.al/` | TLS/200，但表单提交到另一第三方 origin | 不作为稳定通用镜像 |

上述 `verified` observation 只证明 2026-08-28 当前环境中的根页面形状。它不证明
`<mirror>/<encoded-doi>` 对任意 DOI 可用，不证明某篇 Literature 有 PDF，不证明服务长期在线，
也不证明访问者的法律、机构政策、内容许可或服务条款允许使用。产品内置两个入口是当前 release
维护选择，不是 SLA、官方身份认证或授权声明。

## 2. 当前配置与对象图语义

`sci-hub` 只出现在 Acquisition Provider 允许键中，不是 Metadata Provider，也没有引用能力。
Source 默认关闭；最小启用配置不需要镜像 table：

```toml
[sources.acquisition]
providers = ["sci-hub"]
```

此时有效列表来自当前版本 bundled mirror set。operator 需要自己的列表时可以完整覆盖：

```toml
[sources.acquisition]
providers = ["sci-hub"]

[sources.acquisition.sci-hub]
urls = [
  "https://mirror-one.example",
  "https://mirror-two.example/base",
]
```

`urls` 是一到八个有序、规范化后不可重复的普通非 secret URL。每项必须使用 hostname-based
HTTPS 默认端口，且不能包含 userinfo、query、fragment、IP literal、loopback、隐藏路径分隔符或
dot segment。custom table 一旦存在就完整覆盖 bundled，不会在 custom 失败后暗中回退，也不会
在升级时被改写。Reset 删除整个 custom table，而不是写空数组；Disable 只从 Provider 顺序移除
Source，并保留 custom。

Registry 在纯本地组装中按以下顺序选择 resolver：

```text
Python injected resolver
  > custom [sources.acquisition.sci-hub].urls
  > current-release bundled mirror set
```

无论选择哪一层，`ConfiguredSciHubLandingResolver` 都只接受当前 Literature 已接纳的规范 DOI，
按有效列表顺序形成 `<mirror>/<encoded-doi>` landing locator；没有 DOI 时 route 不适用。
Registry、`config status` 与 Planner 构造不执行 DNS 或 HTTP。未启用时即使 resolver locally
ready 也不会安装 `public:sci-hub` route。Status 用以下普通字段区分有效来源：

```json
{"mode": "builtin", "urls": ["https://sci-hub.ru", "https://sci-hub.kr"]}
```

或：

```json
{"mode": "custom", "urls": ["https://mirror-one.example"]}
```

## 3. Config 交互语义

交互入口固定在 `Download → Sources → sci-hub`：

```text
disabled: Enable / Edit / Back
enabled:  Edit / Disable / Back
editor:   Add / Remove / Save / Reset / Back
```

- `Enable` 直接使用当前有效列表，不先询问 URL；
- `Edit` 从 builtin 或已有 custom 的有效列表开始；
- `Save` 把 draft 写成显式 custom override；
- `Reset` 删除 custom override 并重新跟随当前版本 builtin；
- `Disable` 保留 custom override；
- `Back` 不发布 draft；
- 整个流程不调用 API Key、Cookie、session、代理或 hidden credential 输入。

## 4. Operator 责任与访问边界

Operator 必须在部署环境之外确认适用法律、机构政策、内容许可和服务使用条件。项目文档不替
operator 做授权判断，也不因 bundled 域名或 Provider 名称存在而授予访问权限。

1. Bundled 列表由 release 维护者通过受限根页面 observation 更新，不在运行时扫描、探测或自动
   发现镜像。运行只按当前有效列表逐个尝试，不并发轰炸多个镜像。
2. 普通配置不接受 API key、header、Cookie、session、代理、selector 或脚本。私有注入 resolver
   自行拥有环境特定认证，不能把 header、Cookie 或响应对象返回给 SciRetriever；仓库不为
   Sci-Hub 定义 credentials section。
3. SciRetriever 对每个 landing 和发现的 PDF locator 执行 HTTPS、URL/DNS/redirect/origin、
   timeout、响应大小和预算检查；不同 mirror hostname 自动进入各自的共享 Network web scope。
4. 不跨 origin 自动转发敏感 headers/cookie；redirect 后重新执行安全判断。
5. 不规避 CAPTCHA、登录、访问控制、robots/服务限制、付费授权或地区限制。
6. Landing 可以直接返回 PDF，也可以用共享静态解析器声明 `citation_pdf_url`，或在
   `a/link/embed/object` 上明确声明 `application/pdf`；产品不执行页面脚本、不猜 selector。
7. HTTP 200、文件名或页面声明都不能证明字节是 PDF。Fetch 后仍执行媒体类型规范化、PDF
   magic/basic checks、hash、lineage 和 immutable publish。
8. 无安全候选可以返回“没有获得主 PDF”；无法安全发布或提交关系是系统失败，不能静默降级。

## 5. 最小中性合同

内置 DOI resolver 与环境特定注入 resolver 都只向 Source 输出有限的中性 locator：

```text
ConfiguredLocatorResolver.resolve(
  identifiers: tuple[Identifier, ...],
  cancel_event: threading.Event | None
)

output:
  tuple[str, ...]  # zero or more candidate HTTPS locators
```

Resolver 不返回 header、Cookie、角色、媒体类型、vendor object 或响应正文。内置 resolver 不执行
HTTP，只把 DOI 的每个 path segment 安全编码；`?`、`#`、百分号和 dot segment 不能改变 URL
结构。SciRetriever 在本地规范化和去重 locator，以当前请求的已接纳 identifiers 形成不可逆的安全
candidate identity，再把实际获取交给统一 Public locator fetcher。不得为该 Provider 新建 vendor
业务 Model、通用关系、额外资产状态或持久 session 表。

## 6. 元数据、响应与持久化边界

当前选择键只用于 Acquisition。即使页面显示标题、作者或参考文献，resolver 也不得写入
`LiteratureMetadata`、`MetadataObservation`、`ProviderRelationObservation` 或权威
`Reference`；这些事实应来自相应 Metadata Provider，并经过 Literature 所有者规则接纳。

没有把任一镜像页面提升为 vendor schema。当前实现只复用 Public locator fetcher 已有的有限静态
PDF 声明解析；Challenge、登录页、验证码页、脚本生成链接和任意 HTML 都不会因为来自 bundled
域名而得到特殊信任。Catalog/provenance 只保留稳定 `sci-hub` 来源、hash 与 lineage，不保存
landing HTML、候选 URL、query、redirect 目标或逐镜像细节。

## 7. 失效、排障与退役

- bundled 入口失效：维护者重新执行受限根页面核验并在后续 release 更新列表；operator 当前可
  保存 custom override 或禁用 Source。旧 release 不在运行时远程更新镜像。
- custom 全部失效：修改或 Reset custom；系统不会暗中混入 bundled，以免违反用户明确顺序。
- 注入 resolver 合同无效：修复调用方组装；不能回退 custom/bundled 掩盖显式 override 错误。
- Network policy 拒绝 URL/DNS/redirect/origin：保持系统失败证据，不关闭 TLS 验证或放宽规则。
- 某镜像正常 404、没有静态 PDF locator 或候选被拒绝：按顺序尝试下一镜像；不能虚构正常命中。
- 返回 Challenge、验证码、登录或非 PDF：拒绝候选，不实施绕过。
- 授权、合法性或可维护性无法继续确认：从 providers 移除 `sci-hub`；不影响其它 Provider
  已提交事实。

## 8. 当前实现与测试边界

Bundled 列表位于
`src/sciretriever/acquisition/sources/configured_sci_hub.py`，不是 Pydantic 字段默认值，因此
编辑其它配置不会把真实 endpoint 意外写入用户 TOML。生产优先级在 Acquisition registry 组装
边界实现；Config 只保存 custom override 与 enabled Provider，Status 展示 effective mode/list。

仓库没有 Sci-Hub 认证、Browser、translator、镜像发现、动态 selector、脚本执行或并发镜像竞速。
所有自动化测试继续使用保留域名、fake resolver/transport/fixture，不访问真实服务、读取凭据、
提交 DOI 或下载文献。本文件的 2026-08-28 observation 是用户明确授权的独立只读维护核验，不由
Harness、CI、安装后验收或普通 `config status` 自动刷新。
