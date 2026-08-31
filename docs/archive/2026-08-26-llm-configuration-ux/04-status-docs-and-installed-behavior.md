# Block 04：状态、文档与安装后行为

## 块身份

- 状态：Completed
- Task 范围：UXD01–UXD05
- 前置块：Block 03 Completed
- 下游块：Block 05
- 恢复点：已通过 CLI 直接测试的最终配置 payload

## 块结果与进入条件

本地状态、公开示例、指南、技术文档和 installed wheel 对新的基础配置行为说同一事实。进入前
Block 03 R3 必须通过。

## 责任与改动面

Primary owner 负责 status presenter/payload、README、example、requirements/ADR/technical/guides
的当前行为同步，以及 installed acceptance。保护 Provider/PDF/Browser 其它文档事实。

## 需要保持的行为

- status 只显示普通值和 credential presence，不显示 secret、不联网。
- 目标文档与当前行为文档分工清楚，不把未真实验证的模型能力写成事实。
- 示例不包含 token、Cookie、个人路径、运行 catalog 或真实模型响应。

## Tasks

- [x] **UXD01 — 更新本地 status 与 home。** 展示 reasoning、vision 和 Browser 同/独立模型结果，
  并给出下一步 probe 提示。
  - 依赖：Block 03。
  - 验收：JSON/人类展示不含 secret，调用网络计数为零。
- [x] **UXD02 — 更新示例与用户指南。** 以基础向导为推荐路径，解释自动模型获取、手工回退、
  provider metadata 限制和 Advanced。
  - 依赖：UXD01。
  - 验收：命令、固定路径、TOML 字段和当前菜单与源码一致。
- [x] **UXD03 — 更新架构技术文档。** 记录 model discovery owner、reasoning 映射、role capability、
  secret/network 边界和无持久 catalog。
  - 依赖：Block 02、Block 03。
  - 验收：ADR/design/technical 无矛盾。
- [x] **UXD04 — 更新 installed acceptance。** fresh wheel 证明新字段可解析、基础菜单可达、status
  展示且模型发现不会被隐式触发。
  - 依赖：UXD01–UXD03。
  - 验收：安装环境不访问真实服务或 HOME。
- [x] **UXD05 — 完成跨面集成审查。** 对公开行为、配置 schema、对象图、文档与 wheel 内容做 R4。
  - 依赖：UXD01–UXD04。
  - 验收：无 material finding。

## 执行方式、集成点与审查门

先 status，再当前行为文档和架构文档，最后 installed acceptance，串行执行。R2 检查每处文本是否
区分“目录报告”“用户声明”“probe 证明”。R4 汇合 Model/Agents/Bootstrap/CLI/config serialization。

## 接口/数据/依赖影响

公开 status payload 增加字段、示例 TOML 增加默认 reasoning；无数据库或依赖变化。

## 验证、退出、证据与恢复

运行 status/config UI/installed CLI 直接测试，检查 Markdown 链接和示例解析。全部 Task、R4 和
证据闭环后退出。失败时回到产生不一致的 Block，不在 presenter 中维护第二套推断。

### 完成证据

- config home/status 分开显示 Agent service、Analysis role、Browser role、controller、Profile、
  CloakBrowser runtime 与 MinerU；role 的 context、vision、reasoning、capability/readiness 均
  标记为本地声明并给出 `config test llm` / `config test browser-agent`。窄终端 Rich 回归验证
  stdout-only JSON、无 ANSI、无 secret 且语义不因物理换行丢失。
- `tests.test_cli` 显式把 `fetch_agent_models` 设为若被调用即失败，证明 `config status` 纯本地；
  Browser Agent probe 只发送合成 1×1 PNG 与一个封闭 generic tool，不启动 Browser、不发送
  Literature/PDF/page content/真实截图；MinerU probe 只做 health、上传 PDF 为 false。
- README、example、配置指南、requirements、ADR 0017、design、Agents/Configuration/Entry/
  Network 技术文档与 documentation map 已同步；示例 TOML 严格解析通过，目录 observation、
  operator declaration 与 probe evidence 没有混写。归档后对 19 个任务相关 Markdown 文件的
  相对链接和围栏复查通过。
- installed-wheel 新用户旅程从空临时 HOME 配置 custom loopback Analysis + same-model Browser，
  保存 `openai-chat-completions` 与 `reasoning_effort = "medium"`，不生成 credentials、不联网、
  不创建 Catalog/ArtifactStore；status/probe 隔离旅程同样通过。
- Full 初次暴露旧 installed status keyset 漏接 `reasoning_effort`；验收断言补齐公开字段后单项、
  Full 和两条定向 fresh-wheel 旅程均通过。R4 无未处置 material finding。
