# MinerU 接入注意事项

> 状态：当前外部依赖说明。普通配置与凭据合同以
> [配置手册](../guides/configuration.md) 和
> [配置技术文档](../architecture/technical/configuration.md) 为准；本文只记录易变的
> MinerU 外部事实和 operator 注意事项。

秘密值、私有 endpoint、用户 PDF 内容、task URL 和模型 token 都不能写入本文。

## 1. 当前锁定的实现身份

| 项目 | 当前值 |
| --- | --- |
| MinerU release | `3.4.4` |
| API protocol | `2` |
| profile | `vlm-engine` |
| archive backend | `vlm` |
| parse method | `auto` |
| 服务所有权 | operator-managed persistent service |
| 主要内容输入 | 归档中的 Markdown |
| 辅助验证输入 | content list、middle/model JSON、实际引用图片 |

这些值由当前 `MinerUProtocol2ServiceClient`、归档 adapter 和直接测试共同锁定。它们在
`sciretriever config`、`config status` 中只读显示，不作为可选 backend。MinerU 4.x 或
其它 profile 不能在未重跑协议/归档/科学 PDF corpus 前替换当前实现。

2026-07-24 的本机对比使用 MinerU 3.4.4 对 4 篇、共 49 页 PDF 测试 `pipeline`、
`vlm-engine`、`hybrid-medium` 和 `hybrid-high`。四种模式均产生 Markdown、content list、
middle JSON 和图片；人工抽查中 VLM 阅读性最好，但出现过把 `151.41 ℃` 识别为
`151.41%` 的数值错误。这个证据支持当前质量优先选择，不构成自动双跑或 fallback 合同。

最后核对的官方资料：

- [MinerU 3.4.4 release](https://github.com/opendatalab/MinerU/releases/tag/mineru-3.4.4-released)
- [CLI service usage](https://github.com/opendatalab/MinerU/blob/0dfc9460cd9ab693b9af60ae3fbffd7bc111b062/docs/en/usage/cli_tools.md)
- [API request client](https://github.com/opendatalab/MinerU/blob/0dfc9460cd9ab693b9af60ae3fbffd7bc111b062/mineru/cli/api_request.py)
- [FastAPI lifecycle](https://github.com/opendatalab/MinerU/blob/0dfc9460cd9ab693b9af60ae3fbffd7bc111b062/mineru/cli/fast_api.py)
- [VLM preload](https://github.com/opendatalab/MinerU/blob/0dfc9460cd9ab693b9af60ae3fbffd7bc111b062/mineru/cli/vlm_preload.py)

## 2. 当前生产接线

根级 Bootstrap 已经根据 `[parsing]` 构造 production protocol-2 client、
`MinerUArchiveAdapter` 与 Parsing service。内容补全按下面的有界顺序运行：

```text
health -> submit PDF -> poll task -> fetch archive -> validate/convert -> publish ParserResult
```

client 校验 health、release、protocol、task ID、状态和响应预算；归档按不可信输入处理，
验证路径、重复文件、大小、JSON 深度/类型、Markdown、实际引用资源、backend 与输入 PDF
对齐。公共结果只保留 parser-neutral Markdown、实际引用资源、输入/result hash 和 provenance；
原始归档、私有 JSON、未引用图片和调试输出在尝试结束后清理。

`config test mineru` 是独立的 health-only 诊断：它只执行 `GET /health` 并验证 healthy、
release `3.4.4`、protocol `2` 和固定 profile；不会 submit、poll、fetch archive、上传 PDF，
也不会写 Catalog、Report 或最后测试状态。

## 3. 配置与上传边界

可信工作站优先使用 loopback：

```toml
[parsing]
base_url = "http://127.0.0.1:8000"
connection_mode = "loopback"
model_identity = "mineru-3.4.4-vlm"
remote_upload_authorized = false
```

loopback 只接受 HTTP localhost/loopback IP，不读取 bearer token。远程模式必须满足：

- hostname-based HTTPS，禁止 remote IP literal、userinfo、query、fragment 和不规范路径；
- operator 在交互向导明确确认源 PDF 会离开本机；
- `remote_upload_authorized = true`；
- bearer token 保存在统一 `~/.sciretriever/credentials.toml` 的 `[mineru]`，并与规范
  origin 精确绑定；
- redirect 到另一 origin 时不携带 token。

SciRetriever 不读取 MinerU secret 环境变量。Base URL、connection mode、model identity
和 consent 属于普通配置；release/protocol/profile/backend/parse method 不是用户选项。

## 4. Operator 所有权

| Operator 负责 | SciRetriever 负责 |
| --- | --- |
| 部署、启动、停止、升级和容量 | 安全组装 client 与访问准入 |
| 模型、revision、文件 hash、GPU/driver | 提交有界请求并验证协议 |
| 并发、队列、task retention | 限制轮询、task ID 和响应预算 |
| TLS、认证入口和上传政策 | origin-bound token 与 redirect 防泄漏 |
| 运维日志和部署证明 | parser-neutral 结果、hash、lineage 和脱敏失败 |

SciRetriever 不启动备用 MinerU、不管理 vLLM endpoint，也不把 remote task state 当作第二套
业务状态。中断本地进程不等于远程 task 已取消；重跑以当前已接纳 PDF/ParserResult 事实为
准。服务 retention 到期或 task 不认识时，本次尝试失败或重新提交，不持久化 task 历史。

## 5. 事故检查

health 失败时，先检查服务是否监听、TLS/认证入口、3.4.4 release、protocol 2、模型预加载、
GPU 容量和 operator 日志。不要让应用自行启动无审查 fallback。

任务长期不完成时，检查并发、队列、显存和 retention；不要在同一 task 仍有效时无界重复
提交。归档被拒绝时区分 zip 路径、大小、JSON、Markdown、资源、backend、页数和输入 hash
问题。诊断只能保留稳定 failure code 和有界上下文，不能保存 secret、task URL、用户正文
或不安全路径。

## 6. 升级门禁

改变 MinerU release、profile、模型、推理引擎或输出 schema 前：

1. 固定候选版本、模型 revision 与部署 digest；
2. 运行 protocol fake、恶意归档 fixture 和科学 PDF acceptance corpus；
3. 比较阅读顺序、公式、表格、图片引用与数值准确性；
4. 审查依赖/模型许可、GPU 和运维要求；
5. 由 owner 接受后同步 adapter、Notes、配置只读身份与测试；
6. 新结果完整接纳前保留当前 PDF 和已有有效 ParserResult，不原地覆盖资产。
