# Wiley

- 最后核对：2026-08-07
- schema v2 选择键：asset `wiley`
- 供应商角色：在 operator 已取得 Wiley TDM/内容授权时提供主文资产；不是 SciRetriever 元数据或引用 provider
- 当前仓库接入状态：只有 asset 选择键、通用 Protocol/adapter/registry；没有 Wiley 专用生产 client，registry 未连接到当前 Assets Service

## 1. 官方入口与证据状态

- [Wiley Text and Data Mining](https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining)：官方 TDM 入口。

2026-08-07 由当前环境访问该页面返回 HTTP 403。遵守访问边界，本轮没有绕过、浏览器规避或继续轰炸，也没有找到可匿名读取且足以确认当前 endpoint、认证 header、响应 schema、限流和 token 生命周期的其它 Wiley 官方资料。

因此本文严格区分：

- `official`：只确认 Wiley 存在上述官方 TDM 入口；页面细节本轮不可读。
- `verified`：保留 2026-07-21 已记录的两篇文章历史现场结果。
- `待核对`：endpoint、认证位置、申请/续期、配额、错误体与媒体类型合同。

这不是断言 Wiley 当前无 API，而是说明当前自动化环境无法取得足够公开依据。

## 2. 认证与授权边界

Wiley TDM 访问需要 operator 取得相应认证材料，并遵守账户、机构和内容授权。认证材料有效不等于每篇文章都有内容权；同样，某篇 OA 或订阅文章可访问也不能证明整个 DOI 空间可访问。

当前公开页面不可读，以下事实均标为待核对，不能由 client 实现经验反向升级成官方合同：

- 当前认证 header 或 query 参数名称；
- token 的申请入口、有效期、轮换与失效症状；
- 机构订阅、个人访问、OA 与 TDM 权限之间的精确关系；
- requests/s、每日/周期配额、quota headers 和重试策略；
- 401、403、404、429 的 Wiley 特定错误体语义。

当前官方认证字段尚未核实，目标生产 adapter 在合同明确前必须保持 `unsupported`，不能接受猜测字段。合同确认后，认证材料只从 `~/.sciretriever/credentials.toml` 私有读取并由 Bootstrap 注入 adapter，不得写入普通配置示例、命令参数、日志、provenance、locator 或本文。

## 3. 外部能力与代表性响应

### 3.1 历史现场验证

`verified`，2026-07-21：当时已有认证材料在旧分层基准中对两个真实样本返回成功：

- 1 篇 OA 样本；
- 1 篇 closed/订阅样本。

两者当时均取得可通过本地 PDF 检查的主文内容。这证明的是“该时间点、该认证/授权环境、该两篇样本”成功，不证明：

- 当前 token 仍有效；
- endpoint/header 仍未变化；
- 所有 closed 内容都可访问；
- 当前 Composition 已接 Wiley client；
- 成功响应不需要再次验证媒体类型与 PDF bytes。

本轮没有读取旧认证材料、没有重放历史请求、没有下载文章。

### 3.2 可安全记录的响应形状

在缺少当前可读官方 schema 的情况下，只能规定 adapter 所需的最小中性边界，不能伪造 Wiley JSON：

```text
success:
  HTTP 2xx
  Content-Type compatible with PDF (after normalized parsing)
  bounded bytes passing PDF basic checks

failure:
  non-2xx, timeout, over-budget response, redirect/policy rejection,
  unexpected media type, invalid PDF bytes, or immutable publish conflict
```

如果 endpoint 返回 HTML landing page、登录页或错误页，即使状态为 200，也不能作为主 PDF 接纳。若将来官方提供 JSON/XML locator 响应，应先记录实际层级和 content negotiation，再添加显式 adapter 解析；本文不预设字段名。

## 4. 元数据与引用能力

当前 schema v2 没有 `wiley` metadata 或 citation 选择键。本轮也未找到可读的 Wiley 官方资料，足以把某个元数据/引用产品纳入本任务的稳定外部合同。因此：

- 不从 TDM PDF 或响应 headers 反向构造 `LiteratureMetadata`；
- 不从文章正文临时抽取引用并冒充供应商结构化关系；
- 不新增 Wiley 作者、期刊或引用专用 Model；
- 如果未来产品需求引入 Wiley metadata/citation，需先更新公开配置合同、责任文档和直接测试。

## 5. 与 SciRetriever 中性数据的候选映射

| 外部事实 | 候选归属 | 约束 |
|---|---|---|
| operator 配置且经授权的文章请求目标 | `ContentTarget` 的解析输入 | 不保存认证材料；标识符必须来自当前 Literature |
| 官方 endpoint 返回或重定向后的安全 HTTPS locator | 运行时 `PdfCandidate.url` 候选 | 需通过 URL、DNS、redirect、origin 和凭据边界；Wiley 不是 metadata provider，不产生 `MetadataObservation.asset_hints` |
| 主文 PDF 响应 | Acquisition 获取输入 | 有界读取、规范化 media type、PDF 基本检查、hash 和 immutable publish |
| 请求时间和 provider identity | provenance 候选输入 | 不记录 token/header 值或受限正文 |

当前通用 `ResolverCandidate` 只表达 locator、role 和 headers；它不表达授权是否充分，也不验证 PDF。后续 fetch、检查与 Literature 接纳仍由各自责任模块完成。

## 6. 不进入业务 Model 的信息

- token、认证 header 值、cookie、机构 session、账户或订阅标识；
- 受限响应正文、登录 HTML 与诊断页面；
- 供应商内部对象或 entitlement payload；
- 单次 HTTP 200 推导出的长期授权、OA 或版权结论；
- 从 PDF 临时抽取而未经过 Analysis/Literature 规则的元数据与引用。

## 7. 排障与复核清单

1. 由 operator 在可访问官方页面的人工浏览器中核对当前 TDM 条款、endpoint、认证位置和限流，但不得把凭据复制进工单或仓库。
2. 选团队明确获准的稳定 DOI 做最小健康检查；未知授权 DOI 不能用于判断 token 失效。
3. 分开记录网络/认证、内容 entitlement、无资源、限流、HTML 响应、PDF 校验和 immutable publish 冲突。
4. 401/403 不能仅凭状态码区分 token 失效与内容无权；应依当前官方错误合同或 Wiley 支持结论。
5. 获取成功后仍验证最终 URL、media type、bytes、hash 和大小预算。
6. 把新官方事实以 `official` 和日期补回本文；供应商支持结论标 `support`，不写敏感工单内容。

## 8. 当前实现边界

`wiley` 仅是当前 asset 允许键。仓库没有 endpoint、认证材料解析、DOI 路由、响应 schema、entitlement 判断或 Wiley 错误映射；也没有历史 downloader/translator 的当前生产实现。只有调用方提供具体 `ResolverClient` 时 registry 才能构造通用 adapter，且该 registry 尚未连接 Assets Service。2026-07-21 历史成功不构成当前可运行用户能力。
