# Configured Sci-Hub

- 外部事实最后核对：2026-08-07
- 当前实现离线对照：2026-08-15
- 当前选择键：Acquisition `sci-hub`
- provider 名称中的 `Configured` 含义：只有 operator 显式提供获准 resolver/client 时才可能构造候选；仓库不提供默认 endpoint、镜像发现、会话或绕过能力
- 当前仓库接入状态：`public:sci-hub` operator-locator route 已接入生产 Acquisition registry 与三级 Planner；stock CLI 不提供 resolver，只有程序调用方显式注入 `ConfiguredLocatorResolver` 时该 route 才 ready

## 1. 证据与记录边界

当前没有找到可作为稳定生产合同的公开官方 API 文档，因此不存在可以按 `official` 记录的 endpoint、认证、响应 schema、分页、限流或错误码。本文也不记录或测试：

- endpoint、域名、镜像或镜像发现方式；
- cookie、session、browser profile、代理或账户材料；
- 绕过访问控制、验证码、付费墙或地区限制的方法；
- 真实 DOI、用户语料、下载内容或受限响应；
- 历史脚本中的地址、translator/browser 私有实现或凭据。

2026-08-07 没有对任何 Sci-Hub 服务发起网络请求。缺少稳定公开 API 依据意味着任何 operator client 都是环境特定实现，不能把观察到的页面结构提升为 SciRetriever 公共合同。

## 2. 当前配置与对象图语义

`sci-hub` 只出现在当前 Acquisition Provider 允许键中，不是 Metadata Provider，也没有引用能力。配置选择该键会让生产 registry 检查一个显式注入的 `ConfiguredLocatorResolver`；stock CLI 的生产依赖不提供该 resolver，因此启用后会在外部访问前稳定报告未配置。选择键不表示：

- 已配置 endpoint 或认证材料；
- 仓库能自动发现可用服务；
- operator 已取得合法访问授权；
- SciRetriever 能构造、发现或配置 resolver；
- operator 注入的 resolver 已通过其私有 endpoint/认证核验；
- 某篇 Literature 一定有 PDF。

只有程序调用方在 `BootstrapExternalDependencies.configured_sci_hub_resolver` 显式注入符合
`ConfiguredLocatorResolver` 的实现时，Acquisition registry 才把 `public:sci-hub` 标为 ready；
缺失或合同无效在组装/预检边界稳定失败。Route 已连接到统一 Planner、Public 层执行、locator
fetch、PDF 基本检查和 publication，但仓库仍不拥有 resolver 的远程协议，也没有默认终端用户
配置入口。

## 3. Operator 责任与访问边界

Operator 必须在部署环境之外确认适用法律、机构政策、内容许可和服务使用条件，并只配置其明确获准访问的资源。项目文档不替 operator 做授权判断，也不因 provider 名称存在而授予访问权限。

具体 client 即使由 operator 提供，也必须遵守共同边界：

1. 只接受明确配置，不扫描、不探测、不自动切换 endpoint。
2. 私有 resolver 自行拥有环境特定 endpoint 与认证，不能把它们、header、Cookie 或响应对象返回给 SciRetriever；当前仓库不为其定义 credentials section。
3. SciRetriever 对 resolver 返回的每个 locator 执行 HTTPS、URL/DNS/redirect/origin、timeout、响应大小和总预算；resolver 自身的外部访问属于 operator 管理的注入依赖，不能以此绕过部署方的政策。
4. 不跨 origin 自动转发敏感 headers/cookie；redirect 后重新执行安全判断。
5. 不规避 CAPTCHA、登录、访问控制、robots/服务限制或付费授权。
6. 只把安全 locator 作为候选；HTTP 200、文件名或页面声明都不能证明是 PDF。
7. Fetch 后执行媒体类型规范化、PDF magic/basic checks、hash、lineage 和 immutable publish。
8. 无安全候选可以返回“没有获得主 PDF”；无法安全发布或提交关系是系统失败，不能静默降级。

## 4. 最小中性合同

由于没有稳定 vendor schema，环境特定 resolver 只能在私有边界内处理外部响应，对 SciRetriever 输出有限的中性 locator：

```text
ConfiguredLocatorResolver.resolve(
  identifiers: tuple[Identifier, ...],
  cancel_event: threading.Event | None
)

output:
  tuple[str, ...]  # zero or more candidate HTTPS locators
```

Resolver 不返回 header、Cookie、角色、媒体类型、vendor object 或响应正文。SciRetriever 在本地规范化和去重 locator，以当前请求的已接纳 identifiers 形成不可逆的安全 candidate identity，再把实际获取交给统一 Public locator fetcher。不得为该 provider 新建 vendor 业务 Model、通用关系、额外资产状态或持久 session 表。没有候选与 resolver/transport/校验失败必须按现有 Acquisition 失败边界区分。

## 5. 元数据与引用能力

不适用。当前选择键仅用于 Acquisition，且没有稳定公开 schema。即使某个环境特定页面显示标题、作者或参考文献，也不得由 resolver 写入 `LiteratureMetadata`、`MetadataObservation`、`ProviderRelationObservation` 或权威 `Reference`。元数据与引用应来自相应已配置 Provider，并经过 Literature 所有者规则接纳。

## 6. 代表性响应结构

未提供。公开依据不足，且记录网页/镜像 shape 会诱导形成脆弱或越权的隐式协议。实现方需要在私有、获准环境中对外部响应做适配，并只以有限 locator tuple 穿过公开边界；测试使用 fake/fixture，不连接真实服务或用户语料。

## 7. 不进入业务 Model 或文档的信息

- endpoint、镜像、profile path、cookie、session、token、账户、代理配置；
- CAPTCHA/登录处理、规避或解锁策略；
- 原始 HTML、脚本、下载页字段和镜像特定 selector；
- 访问成功推导出的版权、OA 或授权状态；
- 目标文献之外的站点数据、遥测或用户信息；
- vendor 专用失败详情、逐候选持久错误和新的资产状态。

## 8. 失效、排障与退役

- resolver 未注入：这是对象图依赖缺失，不是“无 PDF”。
- Network policy 拒绝 URL/DNS/redirect/origin：保持系统失败证据，不放宽安全规则。
- 返回 HTML、验证码、登录或非 PDF：停止该候选，不实施绕过。
- endpoint/页面结构改变：由 operator 在私有实现中升级并用 fixture 契约测试；不得把地址或响应正文补进仓库。
- 授权、合法性或可维护性无法继续确认：从部署配置移除 `sci-hub` 并撤销私有依赖；不影响其它 provider 已提交事实。

## 9. 当前实现边界

仓库没有 Sci-Hub endpoint、认证、HTML parser、Browser、translator、镜像发现或自动 failover。
当前专用 `ConfiguredSciHubPdfSource` 只调用显式注入的 resolver、验证其有限 locator tuple，并把
实际获取交给共享 Public locator/PDF validation/publication 边界；生产 registry 与 Planner 已接线，
但 stock CLI 不注入 resolver，所以默认不 ready。直接测试仅使用 fake resolver/locator fetcher，
没有连接真实服务、读取凭据或下载真实文献。本文不为任何外部服务建立默认或推荐访问方式。
