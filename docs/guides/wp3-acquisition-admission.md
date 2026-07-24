# WP3 Acquisition Provider 与 Adapter 准入记录

本记录依据 [Provider 准入与退役模板](provider-admission-template.md)，登记 2026-07-24 已实现的 WorkVersion acquisition 能力。它是 `implementation` 级离线证据，不表示任何外部 endpoint、会话或内容授权已经现场验证，也不作官方或法律结论。当前用户行为以 [README](../../README.md) 为准，运维背景见 [Provider 运维手册](provider-operations.md)。

本记录不包含 endpoint、profile path、凭据值、签名 URL、Cookie、响应正文或用户身份。

## 1. 身份与责任

| 字段 | 内容 |
|---|---|
| provider / adapter ID | first-tier `direct` 与 configured providers；`sci-hub`；`translator-<rule>`；`browser-<rule>` |
| 能力类型 | direct asset resolver / configured landing resolver / restricted translator / browser adapter |
| 产品阶段 | current implementation，WP3 |
| 运行状态 | active capability；Sci-Hub、translator、browser 均默认关闭 |
| 维护责任人 | repository maintainers |
| 首次准入日期 | 2026-07-24 |
| 最后复核日期 | 2026-07-24 |
| 下次复核截止 | 2027-01-24，或 provider/API/browser runtime 实质变化时提前复核 |
| 证据等级 | `implementation`；无本记录覆盖的 live Sci-Hub/browser `verified` 证据 |
| 责任 spec / 批准引用 | requirements FR-10 至 FR-12、system design Acquisition 流、technical architecture、已批准 WP3 execution plan |

## 2. 能力、标识符与角色

| 能力 | 输入与标识符 | 资产角色 | 输出语义 |
|---|---|---|---|
| `direct` | WorkVersion 中已持久化的 HTTPS locator | 目标指定角色 | 零或一个 runtime candidate |
| arXiv / Crossref / Unpaywall / Europe PMC / Semantic Scholar | arXiv ID、DOI 或 PMID，按 provider 要求 | primary PDF | 有界、确定性排序的 runtime candidates |
| OpenAlex | DOI | primary PDF | 按 location 顺序选择首个 HTTPS locator，产生零或一个 runtime candidate |
| Elsevier / Wiley / Springer | DOI 与启用 provider 所需的 credential reference | provider 声明的 primary/supplementary PDF、XML 或 HTML | 有界 runtime candidates |
| configured Sci-Hub | DOI，显式启用且与 first-tier provider 列表一致 | primary PDF | landing resolution 后零至八个候选 |
| restricted translator | DOI 与严格 rule template | primary PDF | 固定静态 HTML whitelist 提取的零至八个候选 |
| profile-copy browser | DOI、严格 rule 和已验证 profile source | primary PDF | 一个 browser landing candidate，由隔离 runner 获取合格 PDF |

所有能力只填补已存在 WorkVersion 的角色缺口，不创建 Work/WorkVersion。primary PDF 是 `download` 完成的必需角色；XML/HTML 是可选补充，只有 primary PDF 已成功或复用后才尝试，不能替代 primary PDF 或独立满足后续 analyze。

## 3. 调度与请求预算

1. 第一层 configured providers 以 `provider_concurrency` 做有界竞速；默认值为 4。
2. 每个 provider 完成有界 resolution 后，候选按稳定 priority/ID 排序，以 URL identity + role 去重，并顺序执行；单来源最多执行 8 个候选。
3. 第一层没有合格 primary PDF 时，translator rules 按配置顺序逐个运行；全部耗尽后才按顺序运行 browser rules。
4. candidate timeout 是内容可进入验收的绝对最晚边界；CLI 默认 30 秒。host budget 默认并发 2、最小间隔 0 秒，均可通过严格配置或本次 CLI 覆盖。
5. candidate body 受 `max_asset_bytes` 限制；browser profile 另受文件数和总字节上限约束。
6. rate-limit 响应停止当前 provider 的后续候选；winner 出现后取消或排空 loser，loser 不得 late accept。

## 4. Host、DNS 与 Redirect 边界

### First-tier direct/providers

- 只允许 HTTPS，无 URL userinfo；shared URL policy、DNS pinning、redirect 逐跳复检、有界读取和敏感 header 处理适用。
- DNS 必须解析为允许的全局地址；redirect 后重新执行 scheme/host/address/policy 检查。
- provider lookup 与 candidate execution 都受有限 timeout；credential 只在受控 request header/query 中使用。

### Configured Sci-Hub

- 仓库没有默认 mirror 或 endpoint；operator 必须显式提供其确认可使用的 HTTPS base URL。
- base host 与 `allowed_pdf_hosts` 构成精确 host allowlist，不支持 wildcard、IP literal、userinfo、非标准端口或 fragment。
- landing 只接受 HTML 或 allowlist 内的直接 PDF；challenge、登录页、not-found 和无 PDF 证据响应稳定拒绝。

### Restricted translator

- rule template 必须是 HTTPS，并且只含一个 `{doi}` 或 `{doi_path}` placeholder。
- template/final landing 与 PDF 分别使用精确 host allowlist；redirect 后 final landing 仍需在 allowlist 内。
- 只读取 `citation_pdf_url`、受控 `link`、`iframe`、`embed`、`object` 和具有 PDF 证据的 `a`；不执行任意脚本，supplement/preview/cover 等候选拒绝。

### Profile-copy browser

- landing、PDF 和全部 network requests 分别受精确 host allowlist 控制；browser 启动前解析所有 network hosts，只接受全局地址，运行中越界 request 直接 abort。
- profile source 必须是现有真实目录；在 POSIX 上必须由当前用户拥有且权限为 `0700`，并与 storage root 互不包含。
- 每次 browser candidate execution 都在当前 invocation 内把 profile 复制到 owner-only temporary directory，headless persistent context 只使用副本；不调用 `storage_state`，不修改源 profile，结束或失败后关闭 context 并清理副本。
- 不支持交互登录、密码输入、CAPTCHA 或 challenge 绕过。operator 在 SciRetriever 外准备其有权使用的会话，并负责授权范围。

## 5. Runtime-only 敏感数据

以下数据只允许存在于当前进程内：execution/page URL、query、request header、referrer、auth-context reference、expiry、credential、browser profile source、profile copy、Cookie/session、network response 和下载正文。

可持久化或输出的内容限于 provider/rule ID、tier、稳定的脱敏 candidate identity、candidate outcome、稳定 reason/action、retryable、winner、WorkVersion/role、accepted RawAsset ID、hash 和已脱敏 provenance。catalog diagnostics、JSON 输出、异常文本和 package lineage 不得包含上述 runtime-only 数据。

## 6. 身份验证与不可变接受

- 所有 PDF、XML 和 HTML 在 immutable acceptance 前都执行角色、MIME、大小、格式、解析和目标文章身份验证。
- exact DOI 一致可以确认身份；没有可用 DOI 时，保守标题一致或标题加作者/年份佐证可以确认。
- 明确 DOI/标题不符为 mismatch；无法提取足够身份信息、加密/损坏内容或无法确认的扫描件为 unconfirmed。两者都 reject，WorkVersion 角色保持 missing，不进入 quarantine 或人工自动放行。
- WP3 不声称 OCR，也不把 XML/HTML 提升为 primary PDF。
- 只有 validation winner 进入 `AssetAcceptanceCoordinator`；内容按 hash create-if-absent，不覆盖已有 RawAsset，同 WorkVersion/role 的并发接受必须收敛。

## 7. 稳定失败与用户动作

| 场景 | 稳定 reason | retryable | 用户动作 |
|---|---|---:|---|
| 配置缺失或冲突 | `configuration_invalid` | 否 | `check_configuration` |
| credential 被拒绝 | `authentication_required` | 否 | `check_credentials` |
| 429 / rate limit | `rate_limited` | 是 | `retry_later` |
| transport/server/timeout | `provider_unavailable` | 是 | `retry_later` |
| 资源不存在 | `resource_not_found` | 否 | `try_another_source` |
| challenge、无候选或响应 shape 无效 | `response_invalid` | 否 | `try_another_source` |
| MIME、内容、解析或身份校验失败 | `content_invalid` | 否 | `review_content` |
| 用户中断 | `cancelled` | 否 | `none`；重跑未完成 WorkVersion |
| 未分类内部错误 | `unknown_failure` | 否 | `contact_maintainer` |

某来源失败但其它来源成功时，失败只保留为 losing diagnostic detail。全部来源耗尽时，primary PDF 结果为 missing，不计 accepted；`download` 的 canonical JSON 分开报告 selected、accepted、reused、missing、interrupted 和每个 WorkVersion 的脱敏角色/details。

## 8. 离线 Fixture 与准入证据

CI 和本地 harness 不访问 live provider，不使用真实凭据、会话或受限正文。2026-07-24 的 implementation evidence 包括：

- `tests/test_wp3_foundation.py`：fresh schema 无 durable acquisition task tables、provider race、provider 内顺序候选、单 winner、reuse、validation failure；
- `tests/test_download_wp3.py`：selector、8-candidate cap、去重、三层顺序、optional roles、identity reject、Ctrl+C retained progress、脱敏和不可变收敛；
- `tests/test_cli_download_wp3.py`：无 selector fail closed、全部 selector 形状、search-download 共用服务、stable JSON counts、Sci-Hub config consistency；
- `tests/test_sci_hub_wp3.py` 与离线 landing fixture：allowlist、候选顺序/去重/cap、challenge/not-found、无泄漏；
- `tests/test_translator_wp3.py` 与离线 landing fixture：固定静态 whitelist、allowlist、supplement rejection、无脚本依赖；
- `tests/test_browser_wp3.py`：strict schema、profile owner/mode/storage boundary、snapshot caps、network route、deadline、无 `storage_state`、challenge rejection 和 cleanup；
- `tests/test_acquisition_identity_validation.py`：PDF/XML/HTML 的 pass/mismatch/unconfirmed 与有界解析；
- `tests/test_toml_config.py`：strict keys、disabled capability、template/host 和 Sci-Hub/provider consistency。

Fixture 由 repository maintainers 随 parser、provider response contract 或 browser runtime 变化更新。任何 fixture 不得引入真实 endpoint、credential、profile/session、签名 URL 或受限正文。

## 9. Disable、复核与退役

- Disable first-tier provider：从 `acquisition.providers` 移除；其它 providers 和后续显式 tiers 保持可用。
- Disable Sci-Hub：同时从 provider 列表移除并取消 enabled 状态；不得保留默认 mirror 假设。
- Disable translator/browser：省略对应表或仅保持 disabled；translator/browser disabled 时不得配置 rules，browser disabled 时不得配置 profile。
- Capability disable 不删除或覆盖已经接受的 RawAsset、WorkVersion asset link、hash 或脱敏 diagnostics。
- 退役触发：外部 contract 无法在现有安全边界内适配、长期无维护 fixture、必需 host/session 边界无法封闭、或 repository maintainers 决定停止支持。
- 退役步骤：先默认关闭并更新 README/provider operations/config example/tests，再删除 adapter 和 accepted config；保留既有不可变资产及其非敏感 provenance，不迁移或重写历史内容。
- 复核不得使用本记录推断 endpoint 合法性、provider 官方支持或 operator 的内容授权；这些责任始终由 operator 和相应外部条款决定。
