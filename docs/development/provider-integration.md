# Provider 接入开发手册

新增或实质修改 metadata/acquisition provider、translator 或 browser adapter 前，维护者应填写一份准入记录，并由责任 spec 明确其当前能力和资产角色。本模板保留 provider 安全、可维护性和证据要求，不属于任何旧下载阶段或 checkpoint 计划。

记录不得包含凭据值、完整签名 URL、Cookie、Token、用户身份、响应正文或内部工单内容。未知信息写“待核对”，不得猜测。

## 1. 身份与责任

| 字段 | 内容 |
|---|---|
| provider / adapter ID |  |
| 能力类型 | metadata / direct asset / translator / browser |
| 产品阶段 | current implementation / approved target / unapproved proposal |
| 运行状态 | proposed / active / degraded / retiring / retired；仅适用于 current implementation |
| 维护责任人 |  |
| 首次准入日期 |  |
| 最后复核日期 |  |
| 下次复核截止 |  |
| 证据等级 | official / implementation / verified / support / inferred |
| 责任 spec / 批准引用 |  |

## 2. 能力与输入

| 字段 | 内容 |
|---|---|
| 支持的标识符 | DOI / arXiv / PMID / URL / 其它 |
| 输入与归属 | Work 查询 / WorkVersion asset gap / landing page |
| metadata 字段或资产角色 |  |
| 输出语义 | observation / zero-or-more candidate / accepted content |
| 身份核对规则 |  |
| 匿名能力 |  |
| 凭据引用名 | 仅配置字段或环境变量名 |
| 授权范围与已知限制 |  |

## 3. 网络与请求预算

| 字段 | 内容 |
|---|---|
| 允许的 HTTPS host |  |
| DNS / redirect 规则 |  |
| 默认并发与最小间隔 |  |
| metadata fan-out 与 completion-order-independent merge |  |
| connect/read/operation timeout |  |
| 最大响应大小 |  |
| `Retry-After` 支持 |  |
| 单 WorkVersion 请求预算 |  |
| circuit / health 分桶 | 不得使用 DOI、完整 URL、凭据或用户身份 |

## 4. 敏感信息边界

- 哪些 URL、header、cookie、referrer 或 auth context 只能存在于运行时：
- 可保存的非敏感 provider record id、locator 和 provenance：
- 日志、failure、catalog 和报告的脱敏断言：
- secret 的 TOML 与环境变量来源：
- 禁用该能力后的回退：

## 5. 验证与资产接受

- metadata provider 如何转成 `MetadataObservation`，不泄漏 vendor dict：
- metadata provider 如何在有界并发和独立 timeout 下运行，并按 configured precedence/fill-missing 得到与完成顺序无关的 canonical 结果：
- provider record 如何只形成 observation，而不按来源膨胀 `WorkVersion`：
- acquisition candidate 如何通过 URL policy、有限 timeout 和 redirect 检查：
- acquisition 如何只填补指定 `WorkVersion` 的资产缺口：
- primary PDF 与 supplemental XML/HTML 的角色验证；XML/HTML 不得提升为 PDF 或独立满足 analyze：
- MIME、magic、EOF、解析、大小和目标文献身份检查：
- 何时允许进入 immutable RawAsset acceptance：
- race loser、取消和 timeout 如何禁止 late acceptance：

## 6. 失败与动作映射

- 所有来源耗尽时的 overall reason/action：
- 可展开的脱敏 per-source details：
- 某来源失败但其它来源成功时，如何把 losing failure 限定为 diagnostic detail：

| 场景 | 稳定 reason | retryable | 用户动作 | 最小复现证据 |
|---|---|---:|---|---|
| 配置或凭据缺失 |  |  |  |  |
| 认证或授权失败 |  |  |  |  |
| 429 或限流 |  |  |  |  |
| 资源不存在或无候选 |  |  |  |  |
| challenge 或 unsupported response |  |  |  |  |
| timeout 或 transport failure |  |  |  |  |
| MIME、内容或身份校验失败 |  |  |  |  |

## 7. 离线 fixture 与验收

按能力覆盖适用场景，CI 不使用真实凭据、真实受限正文或 live provider：

- metadata 缺字段、冲突字段和 provider precedence；
- metadata provider 实际并发启动、独立 timeout，且不同完成顺序产生相同 Work、WorkVersion 和 canonical metadata；
- 同一书目版本的多 provider records 收敛为 observations，不按 provider 数量创建版本；
- 零、单个和多个候选；
- 首候选失败后其它候选成功；
- 重复候选收敛；
- 429、timeout、redirect、截断、超限和无效内容；
- 敏感 query/header/cookie 不进入 durable state 或输出；
- race winner 后无 late acceptance；
- provenance、WorkVersion asset link 和 catalog 对账；
- PDF-only 可完成 analyze、XML/HTML-only 必须 blocked、PDF 与补充资产冲突时 PDF 控制结果及 PDF locator；
- 关闭 provider 后其它已批准路径保持可用。

记录 fixture 来源、版本、最后核对日期、预期结果和刷新规则。

## 8. 健康、复核与退役

- 最小无正文健康检查：
- 凭据失效、API 版本变化、限流和内容授权变化的稳定症状：
- 超过复核窗口时的降级行为：
- 禁用开关和回退路径：
- 退役触发条件：
- 退役后保留的脱敏 failure/provenance 证据：
- 用户迁移说明：

## 9. Review Checklist

- [ ] 责任 spec 明确该 provider/adapter 是当前能力还是尚未实现目标。
- [ ] 凭据、签名 URL、正文和用户身份未进入文档或 fixture。
- [ ] metadata provider 使用有界并发、独立 timeout 和 completion-order-independent merge；provider precedence/fill-missing 有确定性配置语义。
- [ ] provider record 只形成 observation；acquisition 只填补 `WorkVersion` asset gap。
- [ ] acquisition priority 和回退层级与责任 spec 一致。
- [ ] primary PDF 是 analyze 的必需权威基准；XML/HTML 只补充且不能覆盖 PDF。
- [ ] HTTPS、DNS、redirect、有限 timeout、响应上限和失败映射完整。
- [ ] 资产经过共享 validation 和 immutable acceptance，没有直接写目标文件。
- [ ] 离线 fixture、维护责任、复核日期和退役条件完整。
- [ ] 关闭能力后，其它已批准前台流程和既有 RawAsset 不受影响。
