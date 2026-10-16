# DeepSeek Harness 组件与兼容性

上级：[外部依赖说明](README.md)。接入决定与业务责任见 [ADR 0031](../architecture/decisions/0031-dsh-backed-agent-capabilities.md)，当前实现入口见 [Agents](../../apps/server/src/agents/README.md)。本页记录外部组件事实，不保存真实测试日志或成功率。

## 固定版本与来源

官方源码：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，调查 revision `d743267388641bc76f17c45ce8b4c231aed1d32c`。服务器直接依赖锁定 `@deepseek-ai/cordis@4.0.5-alpha.1`，下列 DSH 包锁定 `0.2.1-alpha.2`，实际解析图由 `pnpm-lock.yaml` 唯一定义。

| 组件                                                        | 接入用途                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `dsh-llm`                                                   | 模型 adapter 与消息/usage 事件协议；出站由 SciRetriever Network 实现 |
| `dsh-session`、`dsh-session-projection`                     | 任务会话原始事件与模型可见历史投影                                     |
| `dsh-system-prompt`                                         | 任务 scope 的固定系统指令                                            |
| `dsh-tools`                                                 | 工具声明、调用 ID、真实执行结果                                      |
| `dsh-agent`、`dsh-agent-loop`                               | Agent scope 与模型—工具循环                                          |
| `dsh-token-meter`、`dsh-compaction`、`dsh-compaction-basic` | 上下文估算与历史压缩                                                 |
| `dsh-attachment`                                            | 内存图片引用类型；字节由调用/会话所属 adapter 保管                        |
| `dsh-scope`、`dsh-session-persistence`                      | 核心包的运行时 peer/import 依赖；不挂载磁盘会话持久化服务            |

这些是独立发布的组件包；不安装或启动完整 DSH CLI/SDK/ACP 应用，不导入用户机器上的 DSH profile、模型与会话设置。Cordis 是组件组合与生命周期容器。

直接模块与 required peer 的解析闭包共 32 个包（包含既有可复用包），安装本次新增 31 个包。已核验闭包 manifest 的 license 均为 MIT；这些 manifest 未声明额外 Node `engines`，项目继续支持并验收 Node `22.19.0`。包携带的版权和许可证随正常依赖分发保留。新增版本仍为 alpha，升级应整组核对兼容性，不能自动浮动到下一个 alpha。

## 安装图不等于运行服务

`dsh-tools`、TokenMeter 和 compaction 的 required peer 会带入 sandbox、approval、commands、retry、filesystem 等包。它们在依赖图中存在，不表示 SciRetriever 挂载对应服务或开放这些能力。实际插件清单由 `agents/dsh/index.ts` 定义；Browser 工具只有原来封闭的动作集合。

便携安装必须递归保存 required peer 的本地已解析 tarball，才能在空缓存、无 registry 的环境安装。Optional peer 不因这次接入转为必需；不为满足包声明而启动对应插件。

## 协议与生命周期限制

- 官方 `LlmAdapter.stream()` 接收事件流；当前 SciRetriever Network 先完整接收有界响应并验证 SSE 完整性，再转换为 DSH 事件，不承诺逐 token 展示。
- 普通推理和压缩都从同一配置绑定读取模型、reasoning、凭据与 Network 准入。框架未获得直接 HTTP 出站通道。
- `concludeTurn()` 结束当前 turn，但同批其它工具仍需由 Browser 显式拒绝；不能把该方法当作撤销其它动作的保证。
- 压缩改变模型投影，不能当作原始事件与图片自动释放。文章关闭时必须释放 scope、路由与附件；首版不承诺跨进程对话恢复。
- 缓存收益取决于实际 Provider 返回的 usage 与服务行为；不能因保留对话就宣称缓存命中或更快。

升级时检查发布包 exports、peer 图、插件关闭、模型/工具 ID 往返、压缩计量与三种 wire 兼容；具体回归范围见活动计划和各模块测试。
