# MinerU 接入注意事项

> 状态：当前外部依赖说明。配置合同以 [schema v2 配置手册](../guides/configuration.md)和 `src/sciretriever/model/configuration.py` 为准；已组装能力以 Composition wiring 和直接测试为准。

本文记录 [ADR 0003](../architecture/decisions/0003-operator-managed-mineru-service.md) 接受的 MinerU 外部服务边界、版本目标和运维注意事项。它不定义新的程序入口，也不表示 parser 已经由当前对象图连接到可运行的 Service。

秘密值、私有 endpoint、模型 token、用户 PDF 内容和运行时 task URL 都不能写入本文。

## 1. 已接受的外部目标

| 项目 | 已接受值 |
|---|---|
| MinerU release | `3.4.4` |
| MinerU API protocol | `2` |
| Parser backend | `vlm-engine` |
| 服务所有权 | operator-managed persistent service |
| 主要结构 | `middle.json` |
| 辅助输出 | `content_list.json`、model output、提取图片 |
| 权威输入 | 已接纳的 primary PDF 及其 hash |

这些值约束 operator 管理的外部部署和 adapter 验收方向。当前 schema v2 的 `[parsing]` 只接受连接协议、服务地址、模型标识、可选 secret reference、上传确认和资源上限，不接受 `service_version`、`api_protocol` 或 `backend` 字段。不要把旧配置字段复制到当前配置中。

MinerU 4.x 改变了独立 VLM 服务合同，不能自动替换 3.4.4。服务、模型、推理引擎或输出 schema 变化前，必须重新运行 parser acceptance corpus，并经 owner 审查。

官方 3.4.4 资料，最后核对于 2026-07-24：

- [release](https://github.com/opendatalab/MinerU/releases/tag/mineru-3.4.4-released)
- [service usage](https://github.com/opendatalab/MinerU/blob/0dfc9460cd9ab693b9af60ae3fbffd7bc111b062/docs/en/usage/cli_tools.md)
- [API request schema](https://github.com/opendatalab/MinerU/blob/0dfc9460cd9ab693b9af60ae3fbffd7bc111b062/mineru/cli/api_request.py)
- [FastAPI task lifecycle](https://github.com/opendatalab/MinerU/blob/0dfc9460cd9ab693b9af60ae3fbffd7bc111b062/mineru/cli/fast_api.py)
- [model preload](https://github.com/opendatalab/MinerU/blob/0dfc9460cd9ab693b9af60ae3fbffd7bc111b062/mineru/cli/vlm_preload.py)

## 2. 当前代码边界

当前 Infrastructure 提供 `OperatorManagedMinerUAdapter`、`MinerUServicePort` 和 `MinerUArchiveAdapter`。Adapter 会核对 primary PDF hash，限制 task ID 和轮询次数，并在任务完成后把归档交给本地不可信输入校验。

`build_object_graph` 当前没有构造 MinerU service client，也没有把 parser adapter 连接到 `LightDocumentService`。因此：

- `[parsing]` 通过 schema v2 验证，只证明配置结构和安全约束成立；
- `OperatorManagedMinerUAdapter` 存在，只证明 Infrastructure 有可复用实现；
- 在 Composition 增加具体 service client 并连接 `LightDocumentService` 之前，二者都不能写成终端用户可运行的 PDF 解析入口。

## 3. 所有权边界

| Operator 负责 | SciRetriever 边界 |
|---|---|
| 部署、启动、停止和升级 MinerU | 校验调用方提供的 parser 输入与结果 |
| 准备模型、推理运行时、GPU 和显存 | 通过 `MinerUServicePort` 提交和轮询有界任务 |
| 管理服务并发、队列和 task retention | 限制轮询，校验 task ID 与归档 |
| 为远程访问提供 TLS、认证和上传策略 | 保持 secret、URL 和供应商类型不进入 Core |
| 记录部署与模型身份 | 保存经过接纳的中性 parser provenance |

SciRetriever 不启动、停止、重载或升级 MinerU，也不管理服务内部的 vLLM endpoint。

## 4. 部署与配置安全

可信工作站应优先把 MinerU 保持在 loopback。远程访问必须由 operator 放在经过认证的 HTTPS 入口后，并明确确认 PDF 会离开本机数据边界。不要把无认证、无 TLS 的服务直接暴露到不可信网络。

Schema v2 的 `[parsing]` 字段、默认值和完整约束只在[配置手册](../guides/configuration.md)维护。关键边界如下：

- `loopback` 只接受 loopback HTTP，禁止 secret reference 和 remote upload；
- `remote` 要求非 loopback HTTPS、`secret_ref` 和 `remote_upload = true`；
- `base_url` 拒绝 userinfo、query、fragment、路径跳转和编码后的路径分隔符；
- secret 只能以 `env:VARIABLE_NAME` reference 保存，配置解析不会读取 secret 值；
- `model` 是 operator 提供的部署标识，不能替代版本、协议或模型文件的独立 attestation。

当前 Composition 不根据 `[parsing]` 构造 service client。调用方不能把配置解析成功当成服务 health、模型身份或任务容量已经验证。

## 5. 外部服务协议

MinerU 3.4.4 的外部服务资料定义了 health、任务提交、状态查询和结果获取接口。当前 SciRetriever Infrastructure 只依赖抽象的 `submit(pdf)` 与 `poll(task_id)` port，没有发布这些 HTTP 路径的 SDK 合同，也没有在 Composition 中组装具体 HTTP client。

Operator 应在仓库外记录：

- MinerU wheel、lock 或 container digest；
- 精确模型 ID、revision 和文件 hash；
- 推理引擎、CUDA/driver 和 GPU 类型；
- 服务并发、retention 和输出目录；
- 部署标识和最近一次 acceptance corpus 结果。

## 6. 结果接纳

MinerU 归档即使来自受信 endpoint，也按不可信输入处理。当前 `MinerUArchiveAdapter` 要求归档恰好提供 `middle`、`model` 和 `content` 三类 JSON，并拒绝：

- 绝对路径、父目录跳转、反斜杠路径、重复路径、目录、符号链接和额外文件；
- 超过单文件、总解压字节、归档字节或 JSON 字节上限的内容；
- 重复 JSON key、非有限数字、过深结构和错误 schema；
- PDF 无效、页数不一致、错误 backend、重复 block ID 或超量 block；
- 无法与输入 primary PDF hash 对齐的请求。

归档通过解析后仍要由 `LightDocumentService` 执行业务接纳和发布。后续阶段失败不能修改已接纳 primary PDF，也不能把部分 parser 输出当成完整文档事实。

## 7. 中断与恢复

MinerU 3.4.4 的 task state 属于外部服务进程。服务重启或 retention 到期后，旧 task 可能不再存在。当前 adapter 支持调用方提供 `resume_task_id`，会在有 task ID 时继续轮询而不重复提交；轮询达到 adapter bounds 仍未完成时稳定失败。

调用方和 operator 必须遵守以下规则：

- 中断本地调用不等于外部 task 已取消；
- 只有同一可信部署仍认识 task ID 时才恢复轮询；
- 不认识或过期的 task 由上层用例记录为失败，再决定是否建立新 attempt；
- 已接纳的本地产物优先于远程 task 状态，不能被迟到结果覆盖；
- parser 失败不得撤销已经提交的 metadata 或资产事实。

## 8. 事故检查

服务不可用时，operator 应检查 health、3.4.4 部署身份、协议 2、模型预加载和 GPU 日志。不要让 SciRetriever 代替 operator 启动备用进程。

任务长期未完成时，检查服务并发、队列、GPU 容量和 retention。不要在同一 task 仍有效时无界重复提交。

结果被拒绝时，区分归档、JSON、PDF 对齐、页数、block 和文档 schema 错误。诊断只能保留有界、脱敏信息，不能保存 secret、task URL 或不安全解压路径。

## 9. 升级门禁

改变 MinerU、模型、backend、推理引擎或输出 schema 前：

1. 固定候选版本和模型 revision。
2. 运行科学 PDF acceptance corpus 与恶意归档离线 fixture。
3. 比较阅读顺序、公式、表格、图片和页级证据质量。
4. 审查代码、模型、依赖许可和部署要求。
5. 由 owner 接受后再更新 ADR、配置合同、provenance 或实现。
6. 新产物通过本地接纳前，保留已有有效文档和资产，不因外部服务升级原地覆盖。
