# M0 Request Amplification Baseline v1

> **归档状态：已被替代。** 本文仅保存 2026-07-23 产品重置前的历史测量和批准证据，不是当前请求预算、需求或实施授权。当前方向见 [ADR 0002](../../adr/0002-work-centered-literature-library.md)和[文献库执行计划](../../planning/literature-library-execution.md)。下文状态与数值保持原样，仅用于审计。

## 状态

- 版本：`m0-request-amplification-v1`
- 测量口径：provider-isolated offline canary
- 批准上限：每个 accepted asset 最多 `12` 次 HTTP 请求
- Owner 状态：`approved`
- 批准日期：`2026-07-22`
- 批准依据：当前 project owner conversation，owner 明确选择“批准 12 次”
- M0 disposition：`BUILT / EXITED`
- 适用范围：M2 单 provider / resolver canary 的扩展门，不是通用成功率或生产 SLA

project owner 已在 2026-07-22 当前 conversation 批准该数值，M0 的数值门已关闭并退出。该批准只固定未来 provider-isolated canary 的 request-amplification ceiling，不授权 M2、新 provider、Sci-Hub、translator、proxy、browser、session 或 live benchmarking。

## 计数规则

分子统计从 resolver 开始到一个 RawAsset 被接受之前发出的全部 HTTP `GET` / `HEAD`，每次 redirect hop 单独计数。分母是同一 provider-isolated canary 中 accepted asset 的数量。

以下情况不计入分子或分母：

- headers-only preflight；
- 已有资产的 admission reuse，因为它不会联网；
- 人工现场排障请求；
- job-level 的后续 invocation retry。retry amplification 单独报告，不能用来隐藏首次执行放大。

无 accepted asset 时不计算比率，必须单独报告请求总数和稳定失败分类，不能除以零或丢弃失败样本。

## 数值依据

M0 的 provider-isolated 成功路径最多包含两个网络阶段：一次 resolver / metadata 请求和一次 asset 请求。共享 secure transport 的 `MAX_REDIRECTS = 5`，因此每个阶段最多是一次初始请求加五次 redirect：

```text
2 request phases * (1 initial request + 5 redirects) = 12 requests / accepted asset
```

`direct` 等单阶段路径天然低于该上限。多 provider source plan 不属于 provider-isolated canary；每个 provider 必须分别报告，禁止把前序失败来源的请求摊入后序成功来源后再宣称通过。

## 未来 M2 Canary 使用规则（M2 未授权）

如果 M2 后续另行获批，新 resolver 只有在以下条件连续两轮满足时才能从 canary 扩展：

- local rejection 为 `0`；
- false acceptance 为 `0`；
- provenance completeness 为 `100%`；
- request amplification 不超过 owner 批准的本报告数值；
- 所有失败均映射为稳定、脱敏的 reason / action。

任何需要超过批准上限的 provider 必须给出独立证据并取得 owner 例外批准；不得通过忽略 redirect、失败请求或无资产样本来降低数字。
