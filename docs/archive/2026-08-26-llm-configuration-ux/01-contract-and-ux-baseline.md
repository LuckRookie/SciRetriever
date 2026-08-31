# Block 01：合同与 UX 基线

## 块身份

- 状态：Completed
- Task 范围：UXC01–UXC04
- 前置块：无
- 下游块：Block 02
- 恢复点：现有向导、配置模型、官方协议事实已完成调查

## 块结果与进入条件

形成不依赖实现偶然细节的基础向导、兼容和联网边界；requirements/ADR 能解释新增用户结果。
进入条件是用户已授权改进 LLM 配置 UX、现有固定 HOME 和无状态 Agents 合同已核实，当前满足。

## 责任与改动面

Primary owner 负责 `requirements.md`、ADR 0017、本计划与直接 UX 测试基线。保护工作树已有
Agents/Browser 和固定配置路径改动，不修改真实配置、凭据、Harness 或运行数据。

## 需要保持的行为

- `config status` 纯本地；probe 必须显式；secret 不回显。
- Analysis 与 Browser 共用 endpoint/credential，但 role readiness 独立。
- Rules/Agent Browser controller 仍在作业前互斥选择。
- 旧 TOML 缺少新增默认字段仍可解析。

## Tasks

- [x] **UXC01 — 固化基础配置用户结果。** requirements 规定向导只暴露服务连接、模型、
  context、vision 和 reasoning，并有无 secret 摘要。
  - 依赖：无。
  - 验收：目标描述不承诺自动猜测远端未提供的能力。
- [x] **UXC02 — 固化显式模型发现边界。** ADR 0017 区分纯本地 status、显式只读模型发现和
  显式最小调用 probe。
  - 依赖：UXC01。
  - 验收：模型发现不持久化 catalog、不发送 Literature、不自动发生。
- [x] **UXC03 — 固化 reasoning 与视觉语义。** 角色级 reasoning 采用 default/low/medium/high；
  vision 映射到明确图片能力和可验证 Browser role，而非名称猜测。
  - 依赖：UXC01。
  - 验收：不支持的模型通过 probe 暴露，不能静默降级。
- [x] **UXC04 — 建立回归测试基线。** 测试明确旧八预算/Browser 内部字段不再属于基础向导，
  并保护旧配置和独立 Browser role。
  - 依赖：UXC01–UXC03。
  - 验收：测试描述用户结果与外部 I/O 计数，不锁死无意义提示顺序。

## 执行方式、集成点与审查门

串行完成 UXC01–04；requirements 与 ADR 是 Block 02 的接口。R1 核对用户授权与 Accepted
合同，R2 检查每项文档是否把当前实现冒充发布事实，R3 要求合同和测试基线一致。任何要求
持久 catalog、隐式联网或改变 Browser controller 语义的 finding 均阻断并回到设计。

## 接口/数据/依赖影响

本块只改变目标合同和测试预期；不改变数据库、用户文件、依赖或生产对象图。

## 验证、退出、证据与恢复

验证文档 diff、链接、术语和测试名称。全部 Task 勾选、无开放 material finding 后退出。
完成证据在执行后填写。失败时保留调查事实，回到本文件首个未勾选 Task；Block 02 只能依赖
已写入真相源的合同，不依赖讨论摘要。

### 完成证据

- `requirements.md` 的 R2 与全局验收明确五类基础问题、官方固定值、显式模型读取、手工回退、
  高级值渐进披露和 secret-free Review；ADR 0017 明确本地 status、目录 observation、Analysis
  probe 与 Browser Agent probe 是四种不同事实。
- reasoning 固定为 `provider-default / low / medium / high`；vision 只形成声明和同模型
  Browser role，不把模型名称或目录缺失字段当成能力证明。Rules/Agent 互斥、Profile/runtime
  与文章授权边界保持不变。
- `tests.test_cli`、`tests.test_agent_configuration_setup` 与 Configuration 回归覆盖基础流不询问
  八预算/Browser 内部上限、取消不写盘、不同 Browser 模型保留、旧配置默认可读和外部调用计数；
  最终纳入 Block 05 的 253 项聚焦回归。
- R1–R3 审查无 blocking/material finding；长期迁移方向由 ADR 0019 单独约束，本块没有把
  PydanticAI、MCP、Skill 或 LangGraph 写成当前行为。
