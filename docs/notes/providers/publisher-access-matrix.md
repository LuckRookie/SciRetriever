# Publisher Access Profile 准入与验证矩阵

- 最后核对：2026-08-15
- 当前 schema：profile evidence fixture v1
- 文档性质：Publisher/Access Provider 易变事实、当前实现和验证缺口矩阵

本文记录 `PublisherAccessProfile` 的统一证据包、三态准入和当前仓库矩阵。它不重新定义 [ADR 0015](../../architecture/decisions/0015-publisher-aware-tiered-pdf-acquisition.md) 的三层顺序，也不表示拥有 Profile 就需要 Metadata Provider、API key 或 Browser session。新增或修改 Profile 还必须遵循 [Provider 接入开发手册](../../development/provider-integration.md)。

## 1. 三态只描述验证资格

每个已经进入验证矩阵的 Profile 恰有一个状态：

| 状态 | 含义 | 能否进入 production profile catalog |
| --- | --- | --- |
| `production-ready` | 当前声明的 route 已有官方/审慎政策、完整证据、生产对象图和离线验收；若声明 Browser，还必须有实际 `BrowserSiteRule` 和必要授权验证 | 可以，只装配该 Profile 明确声明的 route |
| `fixture-verified` | schema、安全、限速、页面状态和归属规则已由离线 fixture 证明，但仍缺真实平台、session、entitlement 或其它生产证据 | 不可以 |
| `unsupported` | 已审查但不能满足当前安全、政策、归属或可执行门槛；不声明任何可执行 route | 不可以 |

访问路径不是第四种状态。一个只支持公开或授权 API 的 Profile 可以是 `production-ready`，同时没有 Browser route；`public-api-only` 不再作为验证状态。尚未完成 P55 证据包的访问方不进入矩阵，不能为了表格覆盖把“未审查”写成 `unsupported`。

`production-ready` 也不表示所有账号或文章都能下载。凭据字段存在、Provider 接受凭据、当前运行环境有授权和具体 Literature 有 entitlement 始终是不同事实。

## 2. 每个 Profile 的统一证据包

生产 `PublisherAccessEvidence` 与仓库内 `tests/fixtures/acquisition/profiles/<access-key>.json` 必须一一对应，至少覆盖：

1. 稳定 `access_key`、展示名、官方产品名和 Access Platform；
2. 当前官方资料、访问条款和限速/配额依据的静态 HTTPS 引用；
3. 核对日期、evidence revision、Provider Notes 和唯一 fixture reference；
4. landing/asset origins、稳定文章 ID namespace、Provider record identity 与脱敏样例；
5. public、authorized API、Browser 三种 capability 的实际 route key；
6. policy evidence/revision、API quota scope，或 Browser rate/session group；
7. Browser rule id/revision、login/entitlement/paywall/challenge marker；
8. primary、supplement、wrong-article 与 excluded 归属样例；
9. 当前缺口、未执行的现场验证和明确退役条件。

Evidence URL 不能含 userinfo、query、fragment、IP 地址或非 HTTPS scheme；Notes/fixture 必须是仓库内固定相对引用。Fixture 只保存合成 identity、locator 和状态，不保存真实正文、Cookie、token、账号、机构或个人 Browser profile。生产运行不读取测试 fixture；fixture reference 是源码、测试和维护证据之间的可审计连接。

## 3. Browser Profile 的额外准入门

Profile 不再保存一套与执行无关的 selector 摘要。它只引用 `browser_rule_id` 和正整数 revision；统一 `PublisherAccessVerificationMatrix` 必须把它与真正执行的 `BrowserSiteRule` 对齐：

- Profile 只有一个精确 landing origin，且与 rule 相同；
- Browser allowed origins 与 rule 完全相同；capture/supplement/excluded locator 的 origin 都属于 Profile asset origins；
- `browser_rate_limit_group` 与实际 web scope 相同，policy revision/group 对齐，`max_concurrency=1` 且至少有一种非零 pacing；
- identifier-in-path 只能使用 Profile 声明的稳定 namespace；
- 有明确 primary capture prefix 和 supplement 排除规则；
- entitlement/authenticated、login-required、paywall/not-entitled、challenge/MFA/rate/account-warning 四类状态各有至少一个封闭 marker；
- rule 必须被一个且仅一个 Profile 引用，缺失、游离、revision 漂移或不完整均在组装时失败。

Matrix 只把 `production-ready` Profile 和其 rule 派生到生产 catalog。`fixture-verified` rule 可以参加离线验收，但不能因为规则文件存在而被生产 Source 看见；`unsupported` Profile 不能声明 public、API 或 Browser executable route。未知站点没有 generic Browser fallback。

## 4. 当前矩阵

| Access key | Platform / product | Public | Authorized API | Browser | Policy / session group | Evidence | 状态 | 当前缺口 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `core-open-access` | CORE API v3 | 通用已保存 locator 由独立 Public Source 消费；Profile 无专属 public route | `api:core` | 无 | `core/api` quota scope；无 Browser session | `core-v3-2026-08-15`；2026-08-15 | `production-ready` | Browser 未注册；不宣称真实 key 或单篇 entitlement |
| `wiley-online-library` | Wiley Online Library TDM API v1 | 无专属 public route | `api:wiley-tdm-v1` | 无 | `wiley/api` quota scope；无 Browser session | `wiley-tdm-v1-client-1.2.0-2026-08-15`；2026-08-15 | `production-ready` | Browser 未注册；不把一次探测扩展为长期 entitlement |

因此当前 production profile catalog 有 2 项，production Browser rule catalog 有 0 项。这个结果只说明 CORE/Wiley 已实现 route 的准入，不表示 P56-P69 的 Publisher Browser 画像已经完成。后续访问方只有在各自 Notes、manifest、rule/fixture 和状态结论闭环后才加入本表。

## 5. 离线验收边界

当前统一合同测试会：

- 逐项核对 production Profile 与 evidence manifest 的名称、日期、revision、官方引用、origin、identity 和 capability；
- 证明缺失、游离、重复引用、revision 漂移、origin/risk scope 不一致或缺少页面/补充材料规则时 fail closed；
- 用本地 Browser gate fixture 实际分类 primary、supplement、wrong-article 和 excluded capture；
- 证明 `fixture-verified`/`unsupported` 不进入 production 派生 catalog。

这些测试不连接真实 Provider、机构登录或 Browser profile，也不证明站点长期稳定、用户权限或下载成功率。真实只读核实只能由用户明确授权，结果必须脱敏并单独更新对应 Provider Notes、evidence revision 和状态。
