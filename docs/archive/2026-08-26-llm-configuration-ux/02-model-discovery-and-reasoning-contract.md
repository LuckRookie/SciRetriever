# Block 02：模型发现与 reasoning 合同

## 块身份

- 状态：Completed
- Task 范围：UXM01–UXM06
- 前置块：Block 01 Completed
- 下游块：Block 03
- 恢复点：Block 01 合同与回归基线

## 块结果与进入条件

Agents/Bootstrap 提供一次安全模型目录读取，角色默认 reasoning 被 Runtime 绑定并由三种
adapter 真正编码。进入前 Block 01 R3 必须通过。

## 责任与改动面

Primary owner 负责 `model/configuration.py`、`agents/`、`bootstrap/` 与对应直接测试。
Configuration/CLI 只是下游消费者；Network transport 和 credential 文件格式受保护。

## 需要保持的行为

- AgentRuntime 仍一次调用、无 session/history；consumer 不选择 provider/model。
- POST 调用的 capability、context、output、hash、失败和日志边界保持。
- 模型发现只使用共享 HttpClient 和当前规范 origin，不跟随 redirect、不记录 secret。

## Tasks

- [x] **UXM01 — 建立中性 reasoning 配置值。** 给角色增加 `provider-default / low / medium / high`
  且旧配置默认 provider-default。
  - 依赖：Block 01。
  - 验收：strict parser 接受四值、拒绝未知值，旧 fixture 无迁移可读。
- [x] **UXM02 — 传播 reasoning 到 Provider wire call。** Bootstrap role binding 与 Runtime 只从
  已冻结角色配置传播，不允许 consumer 临时覆盖。
  - 依赖：UXM01。
  - 验收：错 role/capability 仍在 adapter 调用为零时失败。
- [x] **UXM03 — 映射三种协议请求。** Responses 使用 `reasoning.effort`，Chat 使用
  `reasoning_effort`，Anthropic 使用 `output_config.effort`；provider-default 全部省略。
  - 依赖：UXM02。
  - 验收：请求 fixture 和 parameters hash 同时覆盖，未知模型不被本地名称猜测。
- [x] **UXM04 — 实现有界模型目录解析。** OpenAI-compatible 只接纳基本 ID；Anthropic-compatible
  可选接纳 context/output/image/effort capability，结果不含 secret 且条目有上限。
  - 依赖：Block 01。
  - 验收：duplicate/超大/错误形状/错误状态稳定失败，合法可选字段缺失仍可取 ID。
- [x] **UXM05 — 装配显式生产发现入口。** Bootstrap 创建一次共享 Network 请求并及时关闭，
  credential 只绑定 candidate Base URL origin。
  - 依赖：UXM04。
  - 验收：offline fake 证明 GET、无 redirect、有界响应、正确 header 和失败脱敏。
- [x] **UXM06 — 完成底层切片审查。** 审查公共面、依赖方向、日志、repr、参数 hash 与测试。
  - 依赖：UXM01–UXM05。
  - 验收：R3 无 blocking/material finding。

## 执行方式、集成点与审查门

先配置值与 Runtime，再 adapter，最后 model catalog 与 Bootstrap；全部串行。Block 03 只依赖
稳定 typed result 和一个显式发现入口。R2 特别审查 secret 是否进入异常/模型、model list 是否
绕过 Network，以及 provider-default 是否真正省略参数。

## 接口/数据/依赖影响

增加向后兼容普通配置字段和 Agents/Bootstrap 内部公共类型；无数据库/credential schema/
第三方依赖变化。

## 验证、退出、证据与恢复

运行 configuration model、Agents contracts/providers、Bootstrap discovery 直接测试。全部 Task、
请求/失败 fixture 和 slice review 通过后退出。失败时从最近通过的直接测试恢复，不以宽松解析
掩盖 Provider 响应差异。

### 完成证据

- `AgentRoleConfig.reasoning_effort` 以向后兼容默认加入普通配置；Configuration → Bootstrap
  `AgentRoleBinding` → `AgentProviderCall` 全程使用冻结 role 值，consumer 无覆盖入口。
- OpenAI Responses、OpenAI Chat Completions 与 Anthropic Messages 分别编码
  `reasoning.effort`、`reasoning_effort` 与 `output_config.effort`；`provider-default` 的
  request fixture 证明字段完全省略，parameters hash 与 wire body 同步覆盖。
- `AgentModelCatalogClient` 只通过共享 `HttpClient` 读取当前规范 origin 的 `/models`：GET、
  0 redirect、0 retry、1 MiB response cap、最多 100 项。OpenAI-compatible 只接纳 ID；
  Anthropic-compatible 的 context/output/image/effort 仅形成可选 hint；结果不持久化。
- 目录测试覆盖 duplicate、错误 shape/status、1 MiB oversize、100 项截断、header/origin、
  timeout/access 与脱敏失败；Bootstrap 入口在 `finally` 关闭共享 Network client。
- `tests.test_agent_model_catalog`、`tests.test_agents_providers`、`tests.test_configuration_boundary`
  和 `tests.test_bootstrap_readiness` 全部纳入最终 253 项聚焦回归；R3 未发现未处置 finding。
