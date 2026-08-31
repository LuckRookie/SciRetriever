# Block 03：精简引导式配置

## 块身份

- 状态：Completed
- Task 范围：UXG01–UXG07
- 前置块：Block 02 Completed
- 下游块：Block 04
- 恢复点：typed model discovery 与 reasoning role binding

## 块结果与进入条件

用户通过精简向导完成可运行 LLM 设置；复杂预算和独立 Browser 模型进入 Advanced。进入前
Block 02 R3 必须通过，模型发现可由 fake 独立调用。

## 责任与改动面

Primary owner 负责 `entry/cli/main.py`、`config_ui.py`、Configuration editing seam 与 CLI/UX
测试。保护 Provider/Browser 其它菜单、固定路径与原子双文件发布。

## 需要保持的行为

- 保存前不改变普通配置或凭据；取消/EOF/验证失败保持原值。
- 相同 origin 可复用已有 key 但不显示；新 origin 必须输入新 key。
- Rich 与 plain 完成同一语义；stdout/stderr 和 JSON status 合同不混淆。

## Tasks

- [x] **UXG01 — 简化服务连接步骤。** 官方 preset 隐藏固定 Base URL/协议；Custom 只问 Base URL
  和协议，service identity/authentication 安全推导。
  - 依赖：Block 02。
  - 验收：无内部 `service_name` 或认证实现术语阻塞基础用户。
- [x] **UXG02 — 改善凭据步骤。** 同 origin 提供“保留已保存 key / 输入新 key”，新服务隐藏输入；
  任何摘要和错误不含 secret。
  - 依赖：UXG01。
  - 验收：cancel 和 fetch 失败不会写盘，保存仍走原子发布。
- [x] **UXG03 — 集成模型获取与手工回退。** 用户明确选择后 GET models、选择模型；失败显示通俗
  原因并直接转手工输入。
  - 依赖：UXG02。
  - 验收：不选择 fetch 时外部调用为零，空/超长 catalog 仍可手工配置。
- [x] **UXG04 — 收敛 context、vision 与 reasoning。** 使用可信目录值作默认，其余清楚询问；
  形成 Analysis 与同模型 Browser role 的封闭能力。
  - 依赖：UXG03。
  - 验收：不同模型的既有 Browser role保留，同模型 vision=false 才移除自动绑定。
- [x] **UXG05 — 自动形成 context-aware Analysis 默认。** 新配置或不兼容旧预算采用安全基础值；
  可验证且兼容的已有高级预算原样保留。
  - 依赖：UXG04。
  - 验收：典型 32k/128k/1M context 均能构造合法 Configuration。
- [x] **UXG06 — 建立摘要与 Advanced。** 保存前只显示服务、endpoint、协议、模型、context、vision、
  reasoning、Browser 结果和 credential 动作；预算/独立 Browser 编辑进入 Advanced。
  - 依赖：UXG01–UXG05。
  - 验收：基础流不询问八预算、图片数量/字节或工具开关。
- [x] **UXG07 — 完成 CLI slice review。** 审查第一次使用、编辑、取消、错误、plain/Rich、secret 和
  旧配置保护。
  - 依赖：UXG01–UXG06。
  - 验收：R3 无 blocking/material finding。

## 执行方式、集成点与审查门

按真实用户顺序串行形成连接→凭据→模型→能力→摘要→保存。R2 每次检查外部调用计数和写盘
计数；Rich 仅替换呈现，不另建业务流程。Block 04 依赖最终配置 payload 与菜单合同。

## 接口/数据/依赖影响

CLI 交互与配置写入值变化；固定路径、credentials TOML 格式、数据库和依赖不变。

## 验证、退出、证据与恢复

运行 `test_cli.py`、`test_config_ui.py`、`test_configuration_editing.py` 的相关用例，并用受控 HOME
检查生成 TOML（不读真实 HOME）。全部 Task 与 R3 通过后退出。失败时不手工清理用户目录，
只在测试临时目录重现。

### 完成证据

- 基础向导按 Service → Credential → Model → Capabilities → Review 运行；OpenAI/Anthropic
  preset 隐藏固定 endpoint/protocol，Custom 只询问 Base URL 与三种协议并安全推导
  `service_name`/authentication。
- 同 origin 已保存 API key 可保留但从不回显；新 origin 必须隐藏输入新 key。模型目录只在用户
  选择 Fetch 后调用，Agent/Bootstrap/Network/`OSError` 均显示脱敏原因并进入手工输入，任何确认
  前写盘计数为零。
- capability 只询问 context、vision、reasoning；32k、128k、1M context 的安全 Analysis defaults
  有直接测试，兼容高级预算保留。vision=true 建立同模型 Browser role，false 只移除同模型自动
  绑定，不删除不同模型的 Advanced role。
- R5 发现并修正“切换 endpoint 但模型同名时误继承旧 context/vision/reasoning 默认”的普通
  finding；新回归证明保存结果为新服务明确输入和 provider-default，而不是旧服务声明。
- plain/Rich、取消/EOF、fetch/manual、summary、Advanced Analysis limits、独立 Browser model
  及 Browser Agent probe 入口由 `tests.test_cli`、`tests.test_config_ui`、
  `tests.test_configuration_editing` 覆盖，并纳入最终 253 项聚焦回归；R3 无剩余 finding。
