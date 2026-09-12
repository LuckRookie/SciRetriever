# Python 配置 owner 的 typed bridge（历史迁移证据）

> 本文件记录迁移期 bridge 的验证，不代表当前生产 owner。当前配置、凭据、readiness、TUI 和 Application 组装
> 已由 TypeScript owner 直接提供；安装包和 TS Full 不启动 Python bridge。下文涉及 Python subprocess 的内容均为
> 历史切片证据，保留用于追溯迁移语义。

2026-09-10。已实现 `read`、`validate`、`diff`、`publish`、`status`、`credential`，并接入合成工作台启动。
首阶段已验证应用重启重读、TUI 模型选择、真实 80×24 PTY 导航/密码输入、compact/help，以及显式 probe 的
分发、反馈与取消所有权。运行中资源 hot reload 和真实外部服务效果明确 Deferred。

## 合同与 owner

- Python `configuration.projection` 通过既有安全 reader/parser 生成 ordinary configuration 的规范 alias
  projection；不把原始 TOML/comment、凭据、错误输入或堆栈传给客户端。
- `entry.configuration_bridge` 是有界 stdio JSON adapter，只消费显式注入的 absolute home；拒绝未知操作、
  多余/重复字段、不匹配协议版本、超限输入。唯一发布路径是 Python `update_configuration_sections`；
  不调用 TS 配置 writer，不访问外部 Provider、不启动 Browser；status/credential 只在注入 home 中调用凭据 owner。
- TS `ConfigurationOwnerBridge` 通过 subprocess 调用 Python owner，使用清理过的子进程环境、输入/输出
  1 MB 上限、deadline 和 AbortSignal；内部异常稳定转换，不转发 stderr。普通配置返回值再次经过既有 TS
  配置解析边界；不解析人类可读输出。
- `read` 返回 ordinary configuration 与内部编辑 revision（原始 ordinary 文件 SHA256，缺失为 `missing`）。
  此 revision 是编辑基线，不属于 status/UI/日志；`diff` 校验当前基线，只返回 changed field names。
- `publish` 明确选择 sources/providers/models/analyze/browser/parsing 中要替换的 section；既有 Python
  TOML round-trip writer 保留其它 section 和注释，发布后重读。paths/execution/library 不增加独立写入口。
- Python writer 新增可选 `expected_revision`，在其安全读取原文件的位置比较基线；原有 CLI/TUI 调用保持
  兼容。POSIX writer 在同一配置目录 inode 上使用非阻塞 flock 包住最终 metadata compare/replace；旧
  配置中心、模型/凭据联动的 configuration staging commit 和 bridge 共用该 publication 函数。并发失败
  报告 configuration-conflict，不覆盖成功者。目录锁由关闭 fd 自动释放，不增加持久 lock 文件。
- TS bridge 当前验收平台为 Linux x64；不把本轮 POSIX 串行替换证据外推至其它平台。
- `status` 返回 contracts 中闭合的 `ConfigurationReadiness`：只含 owner/逻辑 target/state/code/next_action
  和凭据 presence。不返回配置原文、绝对路径、secret、mask、长度、hash 或 fingerprint。Status 永不联网或
  启动 Browser；Metadata 与 Acquisition 分列，无安全 acquisition probe 时显示 unavailable。
- `credential` 支持 model/mineru/source 的 keep/set/remove。空输入保留，source 未提交字段保留，只有
  remove 删除。model/mineru origin 来自当前普通配置；在同一目录锁内再次核对配置基线，禁止 endpoint
  改变后拿旧草稿删除或绑定 secret。普通配置和凭据的既有 writer 共用可重入目录锁，不新增 lock 文件。
- Application 可显式注入 `configurationOwner`，在打开 DB、FileStore 或组装 Agent 前读取 Python projection；
  合成预览使用该路径。保存不修改运行中快照，关闭/重启后使用新选择和凭据。未实现运行中资源的热替换。
- TUI/非 JSON CLI Status 消费相同 readiness；既有 JSON status 保留兼容输出。Models 页增加 Analyze 和
  Browser 的共享模型选择，Browser 仅列出 image-capable model；确认后使用 expected_revision 发布，不复制 key。

## 测试

直接 TS 测试在 `sciretriever-config-owner-*` 临时 home 中调用实际 Python 包：

1. 默认值/有效草稿与 TS 一致；首次读取不创建配置；字段 diff、旧基线冲突及原文件字节保留；
2. comment 不回传；未知 key/非法引用/secret 字段拒绝；输入上限、取消 signal、子进程 deadline；
3. 首次 publish、回读、保留其它 section 和注释、并发两个客户端只允许一个基线成功；
4. 两个实际 Python writer 在 `staging-validated` failpoint 用 Barrier 确认都已暂存同一版本，随后竞争
   compare/replace，结果严格为一个 published、一个 conflict。
5. model/source/mineru 凭据 set、留空、keep、remove，来源字段合并，origin 变更后的不可用和 stale revision 拒绝；
6. 禁用 socket connection 和 subprocess launch 后仍能获取 readiness，空 home 保持为空；未知字段、重复行、非法
   state 和 credential hash 字段在 TS DTO 解析边界拒绝；
7. 实际 Application 从 Python owner 选择模型，保存后旧实例保持原快照，重启采用新模型；非法配置在 DB 前拒绝。

`configuration-tui-journey.test.ts` 同样由 TS 驱动实际 Python：覆盖所有一级导航、80 列 readiness、模型引用
选择和确认、键盘输入 adapter，以及真实 80×24 PTY 中进入 Models/Esc 返回/Quit。PTY 使用实际 getpass 输入
合成密码，验证终端无回显；没有用 mock 密码输入代替这项证据。测试只使用临时 home，并禁止网络连接。

本轮 `SCIRETRIEVER_CLOAK_BUNDLE=<verified-bundle> pnpm full` 通过：55 个测试文件、195 个测试，包含
目标 Cloak、通过 Python owner 启动的工作台、双 viewer 和移动端旅程。日志：
`/tmp/sciretriever-owner-readiness-full.log`。

### 显式配置测试的反馈与取消

既有 CLI/TUI 测试命令新增 execution 摘要（JSON 为保留原字段的追加字段）：owner、逻辑 target、稳定 code、
整体耗时、network 副作用说明、may_consume_quota 和下一步。只把本地跳过/无下载 probe 描述为 not-requested；
其它结果和中断保守描述为 may-have-run，不能据此推断实际请求数、流量或账单。Ctrl+C/SIGINT 在执行阶段
转换为 cancelled，finally 关闭 session；CLI 返回 130，TUI 显示结果并返回。不会自动重试。

`configuration-probe-journey.test.ts` 使用实际 Python dispatch/presenter 和合成 session，验证全部八类 owner、
--all 的 Browser 开关与目录/site/PDF 排除项、未知目标在组装前拒绝、人类取消确认不组装、真实 SIGINT 的
session 关闭及 CLI/TUI 结果。测试禁止网络连接；它证明的是命令分发、反馈和取消资源所有权，尚不证明实际
外部 HTTP 连接在取消时的释放。真实 Provider probe 需要另行授权，不属于首阶段离线验收。

加入上述显式测试切片后的历史 TS Full：56 个测试文件、196 个测试全部通过（目标 Cloak 已启用），日志
`/tmp/sciretriever-owner-probes-full.log`。历史整库验收曾扩展到 85 个测试文件、352 项测试，日志
`/tmp/sciretriever-plan-full-final.log`；没有运行 Python Quick/Full/unittest。

没有运行 Python unittest 或 Python Harness。仅对本轮 Python 源码使用 formatter；行为由 Vitest 调用
真实 Python owner 验证。CI Full 安装锁定 Python 运行依赖用于这些 TS subprocess 测试，入口仍为
`pnpm full`；Quick 不需要 Python runtime。PDF 验证另需要系统 poppler-utils。

## 首阶段边界与 Deferred

阶段 04 的单一 Python writer、typed projection、配置/凭据发布、readiness、显式测试命令和 TUI 主旅程已经闭环。
运行中资源 hot reload、Web 配置编辑器、所有字段组合的穷举编辑矩阵、真实 Provider probe 和生产配置入口切换
明确 Deferred；compact 布局和 `?` 帮助已有直接测试。这些暂缓项不建立第二个 writer，也不扩大当前支持矩阵。

此前 publication 切片 TS Full：54 个测试文件、186 个测试通过，日志
`/tmp/sciretriever-owner-publication-full.log`。本轮 readiness/credential/TUI 与启动组装的验收另记录于下方。
