# Block 3：外部边界与失败诊断

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | `EXT01`-`EXT04` |
| 前置块 | Block 1、2 Completed |
| 下游块 | Block 4 |
| 恢复点 | 最后一个通过离线边界测试的 Task |

## 块结果

Browser、Network 与 Config probe 提供足够但安全的外部边界诊断：普通运行不刷屏，Debug 能解释路径和失败，配置测试明确实际请求、wire model 与 stream。

## 进入条件

- 业务 INFO owner 已稳定；
- 相关 Browser/Network/Config probe 文件的现有用户改动已逐项审查；
- 只允许 fake/fixture/本地受控边界，不连接真实服务。

## 责任与改动面

Primary owner 负责 Network HTTP、Browser scheduler/session/native adapter、Acquisition Browser controller、Config probe diagnosis/presenter 及相关离线测试。不得扩大 Browser 动作集合、访问策略或 probe 网络范围。

## 需要保持的行为

- 携带 credential 的 Network 调用不在 Network 层记录敏感请求；
- Browser 不记录完整导航目标、selector、页面正文、截图字节、Cookie、Profile 或 seed；
- Config probe 只显示无 query/userinfo/fragment 的安全 endpoint；
- Model probe 显示实际 wire model，完整本地 reference 只作为明确不同的本地身份；
- Download 无安全 probe 时继续报告 unavailable，不借用 Metadata 或下载真实 PDF。

## Tasks

- [x] **EXT01 — Browser/Network 降噪。** INFO 只保留用户需要的等待、Challenge/blocked/access-denied 与稳定失败，session/native/correlation/capture/cleanup 保持 DEBUG。
  - 验收：代表性 INFO 不出现 native 细节，Debug 保留必要事件与 elapsed。
- [x] **EXT02 — 统一外部失败分类。** 连接、TLS、policy、timeout、authentication、permission、quota、endpoint/model、contract 与资源预算使用一致的 code/reason/action/retryable 展示。
  - 依赖：EXT01。
  - 验收：受控 HTTP 状态和 access failure fixture 可区分，不输出 response body 或异常正文。
- [x] **EXT03 — 对齐 Config probe 请求诊断。** Model/Analyze/Browser Model 展示 model reference、wire model、method、safe endpoint、stream、result；Provider/MinerU 展示安全 request；human/JSON 复用同一 diagnosis。
  - 依赖：Block 1；保护当前 Config probe 改动。
  - 验收：成功、400、401、404、429、连接和 contract failure 表格/JSON 一致。
- [x] **EXT04 — 完成边界安全测试。** 覆盖 URL query/userinfo、headers、credentials、Prompt、response、Browser 私有内容与绝对路径不泄露。
  - 依赖：EXT02、EXT03。
  - 验收：两种日志模式与 Probe 输出均通过 hostile fixture。

## 执行方式与集成点

串行执行 EXT01-04。Network/Browser 只记录自身边界，Config probe 只使用当前 probe typed payload；不得为展示反向解析日志或扩大外部请求。

## 审查门

- R1：确认外部调用仍为 fake/fixture，现有安全 policy 不变；
- R2：每个失败分类检查证据强度，未知 404 不虚构为确定 Model 不存在；
- R3：离线边界、安全和 Probe human/JSON 测试全部通过。

## 接口 / 数据 / 依赖影响

- 接口：Probe 已有结构化 diagnosis 可能增加安全展示字段，但不新增外部请求；
- 数据：无持久化变化；
- 依赖：无。

## 验证与证据

```bash
uv run --frozen python -m unittest tests.test_configuration_probes tests.test_core_configuration_probes tests.test_config_ui
uv run --frozen python -m unittest tests.test_network_http tests.test_network_browser
```

实际测试模块名在执行时按仓库现有文件校准并记录。

## 退出条件

- EXT01-04 全部完成；
- Browser/Network INFO/DEBUG 分层与 Config probe 诊断通过直接测试；
- 无真实外部访问，无安全边界或请求范围扩张。

## 完成证据

完成于 2026-09-02：

- Browser controller、scheduler/group lifecycle 与 Cloak runtime readiness 降为 DEBUG；等待、暂停、circuit action、中断和 Browser page/Agent 稳定终态保持用户可见；
- Network 成功路径保持 DEBUG，安全 AccessFailure 保持 WARNING；携带 credential 的 Network 请求仍不生成 Network LogRecord；
- Browser Agent 失败在 controller Debug 和 Source 终态均使用稳定 code/retryable/reason/action，不输出页面、动作 payload、selector、截图内容或 Profile 路径；
- Config probe 继续从 typed details 同时驱动 human/JSON diagnosis，展示实际 wire model、Provider、method、无 secret endpoint 与 stream；
- 离线测试补齐 400、401、404、429、transport、contract、stream on/off，以及 userinfo/query/fragment URL 拒绝。

直接证据：

```text
Browser controller/scheduler、Network HTTP/Cloak、Browser Source、
Config probe/UI/core probe 相关 9 个测试模块                         253 passed
目标文件 Ruff check                                                 passed
```

## 失败与恢复

若安全 endpoint 无法从当前 typed payload确定，或分类需要读取 vendor body/异常正文，停止并保守显示未知原因，不把不可信对象引入 Logging；必要时返回所属 adapter 设计。

## 下游交接

Block 4 可依赖：业务摘要、外部 Debug 与 Config probe 已形成一致的用户诊断词汇，且全部由离线测试证明。
