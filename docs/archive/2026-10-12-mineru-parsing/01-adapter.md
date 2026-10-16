# 01：真实 MinerU 适配

状态：Completed。

## Outcome 与进入条件

使用已确认的 3.4.4/protocol-2 响应和归档结构修复根因，使真实产物通过既有安全与完整性边界。已有用户修复授权与四篇真实失败证据。

## Tasks

- [x] 1.1 共用 health 必需字段验证，接受无关扩展字段；保留重复 JSON、版本、协议、状态与 task ID 拒绝。
- [x] 1.2 将任务提交/轮询/下载组织为同一协议 client，接入本机与远程运输层；每次远程请求读取当前凭据，不跟随返回的任意 URL。
- [x] 1.3 请求 Markdown，按实际 deadline 与适当间隔轮询；覆盖排队、超时、取消、服务失败，无固定 120 次截断。
- [x] 1.4 正确解析 middle 图片名与 Markdown 相对资源，保留路径/hash/大小检查；从 middle 得到输出页数，由 Parsing 与输入 PDF 页数独立核对；更新转换规则 provenance。
- [x] 1.5 合成响应模拟真实扩展字段、嵌套 ZIP、输出开关和延迟任务；验证拒绝非法路径、丢失资源、错误页数、损坏归档和取消，并复核凭据调用方。

## 责任与集成

协议与私有布局归 `parsing/backends/mineru/`；Network 继续拥有请求安全与预算；Bootstrap 只组装。公共 ParserResult、文档合同、数据库与配置格式保持兼容，不引入 MinerU 任务持久化或后端自动切换。

## 验证、退出与恢复

定向 `pnpm exec vitest run` 覆盖 MinerU、Parsing、配置凭据和 Document 调用方；随后 Quick。逐个真实 ZIP 经原转换入口验证，但不以此替代 02。记录具体修改和测试结果后勾选任务；失败保留原样本和日志，不通过改写真实响应获取绿色。

## 执行证据

2026-10-12 工作树实现协议共用、deadline、归档转换及来源 ID 修复；增加 `profile.ts`/`protocol.ts`，没有改公共 ParserResult/schema。首轮 6 文件 49 项通过，随后本机/远程与读取 2 文件 24 项通过，Quick 通过；新增远程 TLS health/submit redirect 断言经 5 文件 36 项专项复核通过。真实第二轮与最终参数 hash 轮均四篇正式解析成功，见修复报告。Full 及最终读取收尾由 02 记录。

过程中发现全零 provenance ID 导致多篇发布冲突，已加入 1.4 的修复与合成回归；参数 hash 记录模型身份。所有实际产物留在临时目录。
