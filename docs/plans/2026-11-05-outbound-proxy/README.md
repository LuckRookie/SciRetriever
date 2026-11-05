# 计划 18：出网代理

类型：计划
负责：ADR 0056 的落地，以及同批修正的旧文档错误
状态：In progress（2026-11-05 开工）

## 目标

按 [ADR 0056](../../architecture/decisions/0056-outbound-proxy-by-requester.md) 加入一个显式配置的出网代理。文献来源、DOI 解析、模型 Provider、远程 MinerU 与浏览器逐项选择直连或经代理，默认全部直连。完成后 Semantic Scholar 可以单独改走本机代理。

同批修正已发现的旧文档错误（第 03 块）。

## 授权

Owner 2026-11-05：“开始实施，同时修正旧文档错误”。

- 已授权：改代码、改普通配置与 `credentials.toml` 的字段合同、改文档、本地提交。
- 验证中的真实请求：只用沙箱配置目录（不含任何凭据），经本机代理对 Semantic Scholar 发只读检索探测。
- 未授权：push；部署 4174（完成后另问 Owner）；修改用户的 `config.toml`、`credentials.toml` 或 catalog。

## 不变量

- 默认全部直连；只填代理地址不改变任何流量。
- 经代理时 URL、DNS、私有地址检查、TLS 证书校验、限速、额度、字节上限、redirect 与凭据 origin 规则全部照旧。
- 代理不可用报 `proxy-unavailable`，不回退直连。
- 不读取环境代理变量；代理认证不进日志、事件或 Web 数据。

## 结果块

| 块                           | 结果                                                             | 负责   | 依赖      | 状态 |
| ---------------------------- | ---------------------------------------------------------------- | ------ | --------- | ---- |
| [01](01-network-egress.md)   | Network 按发起方选择出口；配置、凭据、测试与机器接口             | Codex  | —         | Done |
| [02](02-settings-network.md) | 设置页“网络”分区与“经代理”标记；配置说明、页面规格与相关文档同步 | Claude | 01 的合同 | Done |
| [03](03-doc-corrections.md)  | 旧文档错误修正                                                   | Claude | —         | Done |

## 完成标准

- 01、02、03 的退出条件都满足。
- 定向测试通过；收尾跑一次全量。
- 沙箱配置下 Semantic Scholar 经代理检索探测通过，直连项不受影响。

## 进度

- 2026-11-05：ADR 0056 Accepted（`989fc8b`）。01 派给 Codex：`sandbox/prompts/2026-11-05-plan18-01-network-egress.md`，回执 `sandbox/reports/2026-11-05-plan18-01/`。
- 2026-11-05：01 交付 `e4cae62`，Claude 核对合同、核心连接与测试。02 完成设置页“网络”分区、来源行与模型行的“经代理”标记、来源测试“可用 · 经代理”，Web 定向测试 `apps/web/test/next-settings-network.test.ts`；`setting=network` 加入服务端页面地址白名单。2.3 与 3.2 的文档同步完成。
- 2026-11-05：沙箱（无凭据）真实复验：测试代理 passed（43 ms），Crossref 直连 passed；Semantic Scholar 经代理 CONNECT 成功、目标返回 429（`metadata-provider-rate-limited`）。完成标准中的 Semantic Scholar 一项未满足，原因是匿名额度，不是出口；待匿名额度恢复后在同一沙箱复测，或由 Owner 在正式配置下测试。
