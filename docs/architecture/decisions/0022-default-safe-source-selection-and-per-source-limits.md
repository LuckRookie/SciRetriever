# ADR 0022：默认安全 Source 选择与逐 Source 扫描上限

- Status: Accepted
- Date: 2026-08-31
- Supersedes: none
- Superseded by: none
- Amends: [ADR 0014](0014-capability-scoped-providers-and-local-credentials.md)
- Related: [ADR 0013](0013-decoupled-discovery-and-database-maintenance.md)、[ADR 0015](0015-publisher-aware-tiered-pdf-acquisition.md)、[产品需求](../requirements.md)、[设计文档](../design.md)、[配置技术文档](../technical/configuration.md)

## 背景

ADR 0014 已经把外部文献能力分成 Metadata 与 Acquisition，并区分项目支持、用户启用、
本地 readiness 和实际调用。不过，要求用户先了解完整 Provider 矩阵、逐项填写
`providers`，再到另一个 `[discovery]` section 配置扫描上限，会让第一次使用和普通配置中心
承担不必要的内部知识。凭据文件中恰好存在一个 Key 也不能安全地替代 Source 选择：同一机构
可能同时提供 Search 与 Download，认证存在更不证明用户希望启用两个能力。

另一方面，“默认全部使用”不能解释为启动时联网探测、根据临时 outage 改写集合，或对每篇
Literature 盲目调用所有下载 Provider。默认行为必须是版本可审计、离线可解释且保留
Acquisition 的证据驱动短路。

## 决策

### 1. 每类 Source 只有 Auto 与 Custom 两种选择方式

`[sources.metadata]` 与 `[sources.acquisition]` 各自保存一个 `mode`：

- `auto` 使用当前版本维护的默认安全 Source catalog；普通配置不持久化展开后的
  `providers`；
- `custom` 精确使用用户保存的 `providers` 集合和顺序，可以为空；空列表就是该能力不启用
  命名 Provider，因此不再增加 `Off`；
- `auto` 禁止同时保存非空 `providers`，避免“跟随版本”与“冻结列表”两个真相共存；
- 不增加 preset、profile、include、exclude、继承或按 Key 自动启用等第三种选择体系。

Auto catalog 是 release 事实，不是远端发现结果。升级版本可以依据生产准入、政策或服务变化
增加、撤下或调整 Auto Source；需要跨版本冻结集合与顺序的用户使用 Custom。配置解析、首页和
status 都不得为了决定 Auto 集合而访问 Network。

### 2. 当前 Auto catalog

Metadata Auto 的有序集合是：

```text
crossref
semantic-scholar
arxiv
openalex
europe-pmc
datacite
core
opencitations
```

这些 Source 都有当前生产实现，且在缺少可选 Key 时仍有安全的公开访问方式。可选 Key 只改善
已经启用的 Source，不改变集合。Crossref 没有普通子表时使用 anonymous pool；配置联系邮箱后
可以显式使用 polite pool。OpenCitations 只参加精确 lookup 与引用能力，不参加主题搜索，因此
当前一次主题搜索最多有七个 Auto Source。

Acquisition Auto 的命名 Source 只有：

```text
arxiv
europe-pmc
```

除此之外，Acquisition 固有地消费 Literature 已保存且通过安全验证的 direct-file/landing
`AssetHint`；Crossref、Semantic Scholar、OpenAlex、DataCite 等 Metadata Source 提供的 hint
通过这条通用路线使用，不为名称对称再启用一套转发 adapter。Auto 仍按 Literature 证据、
Public → Authorized API → Browser 的层级和成功短路执行，不会为每篇文献调用所有能力。

Sci-Hub、Unpaywall、CORE/Elsevier/Wiley 授权 PDF API 和其它要求 operator 普通参数、必需凭据、
entitlement 或风险确认的命名 Source 不进入 Acquisition Auto。Browser 继续由 `[download]`
独立显式启用；凭据存在不能暗中启用 Search、Download、Sci-Hub 或 Browser。

### 3. Metadata limit 属于 Metadata Source 配置

原 `[discovery].metadata_scan_limit` 删除，普通配置改为：

```toml
[sources.metadata]
mode = "auto"
limit = 500
```

`limit` 是大于等于 1 的整数，默认 `500`。它分别应用到本次参与运行的每个 Metadata Source，
不是多个 Source 共享的总量，也不是 HTTP 请求次数。Provider 返回的每条原始 metadata item 在
过滤、最低身份准入、去重和接纳之前消耗一个额度；自然耗尽或达到该 Source 上限都是正常结束。
引用查询同样使用这个逐 Source 上限。以当前 Auto catalog 和默认值执行主题搜索时，理论原始
item 上限是 `7 × 500 = 3500`，但 Provider 可以更早自然耗尽或失败。

旧 `[discovery]` 不迁移、不忽略，作为未知 section 直接拒绝。当前配置合同不保留兼容读取器、
双写或隐藏 fallback。

### 4. 配置中心与状态使用有效选择

配置中心的 Search 页面固定为 `Sources / Limit / Test / Back`，Download 页面固定为
`Sources / Test / Back`。
Sources 页只用单词级 `Auto / Custom / Back` 及具体 Source 名称表达对象：Auto 切到 Custom 时
冻结当前有效集合；Custom 切回 Auto 时删除固定 `providers` 并重新跟随当前版本 catalog。选中
具体 Source 后，就近显示它实际拥有的 `Setup`、`Key`、`Test`、`Enable` 或 `Disable`；Search Auto
仍可配置 Crossref anonymous/polite 普通参数。Sci-Hub 的 `Mirrors` 只出现在 Sci-Hub Source 页，
编辑镜像不会启用该 Source。

首页计数、Source 对象页、`config test --all`、status enablement、registry、Bootstrap 和运行时
precedence 都必须消费同一个本地 effective Source resolver。`Key` 只在确有可配置凭据的具体
Source 上出现；Key 存在不反向改变有效集合。status 可以保留完整 capability matrix 供 JSON 审计，
但人类主视图只展开当前有效或需要用户注意的项，并明确显示 Auto/Custom 与逐 Source limit。

## 结果

- 空普通配置具有确定的 Metadata/Acquisition 默认能力，不需要用户先掌握 Provider 矩阵；
- 版本默认与用户冻结列表不再混写，升级影响可以清楚解释；
- Metadata 上限与其 Source owner 放在同一处，且多来源扩大覆盖时不会暗中共享一个总额度；
- 凭据、在线状态和 Source enablement 继续是不同事实；
- Acquisition 仍基于已有证据和风险层级执行，不因 Auto 退化成全 Provider 穷举。

## 不采用

- 启动时联网探测“能用的 Source”并动态改写 Auto；
- 根据 credentials 中是否存在 Key 自动启用 Search 或 Download capability；
- 同时维护 Auto、preset、include/exclude 与自定义数组；
- 为 Custom 空列表再增加一个等价的 Off 模式；
- 把 limit 解释为所有 Provider 的共享总量、最终接纳数量或 HTTP 请求次数；
- 保留 `[discovery].metadata_scan_limit` 的兼容读取、迁移或 fallback。
