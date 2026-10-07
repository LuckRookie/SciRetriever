# 文献供应商接入与治理

本页说明当前 TypeScript 实现与新增服务的维护入口。长期边界见 [ADR 0014](../architecture/decisions/0014-capability-scoped-providers-and-local-credentials.md) 和 [ADR 0012](../architecture/decisions/0012-process-local-provider-access-scheduling.md)。

## 定义与所有权

从 [`providers/README.md`](../../apps/server/src/providers/README.md) 查看目录导航。每家供应商拥有独立目录，静态汇总入口为 [`providers/registry.ts`](../../apps/server/src/providers/registry.ts)：

- `<provider>/definition.ts` 拥有该供应商的能力、认证字段、默认选择、PDF 适用证据和具体服务声明。`registry.ts` 仅汇总为 `LITERATURE_PROVIDERS` 与 `PROVIDER_SERVICES`，不复制定义。同一供应商可同时提供 Metadata 与 Acquisition；`hints` 表示提供下载线索，没有同名独立下载 adapter。
- 各家 `definition.ts` 的服务声明包含 URL、覆盖范围、quota group、默认并发/间隔/窗口和政策依据。Elsevier 的 Search、Abstract、Article/Object 是不同额度组；CORE 元数据和 PDF 复用同一组。
- `<provider>/metadata.ts`、`acquisition.ts` 和必要的 `locators.ts`/`record.ts` 保存该供应商协议实现，直接使用本目录定义。统一窄接口分别由 `metadata/ports.ts`、`acquisition/ports.ts` 提供；静态注册合同在 `providers/contracts.ts`，真正通用的协议帮助在 `providers/shared/`。
- Metadata registry、普通配置解析、凭据字段校验、安全状态、CLI 和生产 assembly 消费该目录。协议路径、分页和响应解析仍由所属 adapter 负责；不把供应商私有数据格式放进 Network。
- `metadataService` 按真实 API 路径选择产品；`publicWebService` 按下载/跳转的实际目的地选择网页政策，不能用元数据来源决定下载站点额度。

目录不保存 Key、Token、用户身份、当前余额、上次测试结果或文献事实。它不是新核心模块，也不替代配置/凭据 owner。现有用户配置格式和 Auto 选择保持兼容，Key 存在不会自动启用服务。

## 限流的当前实现

`NetworkBudgetCoordinator` 在同一进程内按 quota group 维护活动请求、最小启动间隔、多个 rolling windows 与阻塞截止。host 并发是附加资源约束，不能代替供应商额度组。两种能力共享组时一起计数，不同产品的窗口保持独立。

数值依据来自 `docs/notes/providers/` 中已保存的外部资料；本次治理没有重新联网核验政策。目录的 `policyBasis` 区分供应商数值与项目保守策略。未知普通网页当前采用单并发、1 秒启动间隔；未知 API 政策分量采用同一保守基线。具体服务的明确规则覆盖默认分量，例如 arXiv 3 秒、Wiley 60 次/10 分钟、DataCite 500 次/5 分钟。

普通 HTTP 每个重定向和静态链接请求重新选择目的地政策。`Retry-After` 在响应头到达、当前 permit 释放之前反馈整个额度组；无该头的 429 按目录默认退避 60 秒。等待比单次请求预算还长时保留 429/退避信息返回，不发起必然超时的内部重试。当前沿用 HTTP 层有界 `Retry-After` 上限，不宣称已实现任意长账户 reset deadline。

窗口只统计本进程发出的请求。日/周 rolling window 是保守本地限制，不等同于真实账户剩余额度，也不跨进程或重启持久化。CORE token cost、OpenAlex 调用成本、WoS Full Record allowance 没有被伪装成每请求一个单位；当前不完整解析供应商所有专有 quota/reset 响应头。账户政策变化需要按对应外部合同维护，不能凭 Key 存在推断套餐。

Browser 继续使用通用动作流程与独立的平台文章准入：动作结束后至少 5 秒、同平台实际网络结束后冷却 30 秒。HTTPS CONNECT 隧道是连接容量，不是逐网页请求计数。本次未将普通 HTTP 的服务窗口伪接到隧道上，也未声称完整实现 Browser 子资源的各站请求额度。Browser 的进一步平台政策接线须保持精确请求归属与下载生命周期。

## 接入或修改一个供应商

1. 在所属 Provider Note 保存官方来源、核对日期、产品边界、认证和额度依据，未知项明确标记。
2. 在 `providers/<provider>/definition.ts` 维护唯一服务声明，并在中央注册。区分元数据、全文线索与真正 PDF 能力，声明文献定位所需证据；不要仅凭 publisher 字符串或 DOI 前缀证明权限。
3. 在同一供应商目录实现 Metadata 或 Acquisition 的窄接口，并在所属 assembly 组装，复用 Network 和凭据 owner。禁止另设私有 sleep/limiter 或绕开网络准入；也不为了文件名对称给不支持的能力制造空实现。
4. 验证配置显示、实际能力与生产对象图一致；使用 fake/loopback 覆盖范围外文献、凭据撤销、跨能力共享额度、独立产品、重定向、限流、取消及不可变入库。
5. 同步当前指南并运行相关测试与 Full。若需要改变已支持配置或数据库格式，先遵循项目授权与兼容规则。

目录给出“支持什么、默认怎么访问”，实际服务器决定“本次是否可用、是否授权”。一次成功下载或本地凭据存在均不能覆盖后一个判断。
