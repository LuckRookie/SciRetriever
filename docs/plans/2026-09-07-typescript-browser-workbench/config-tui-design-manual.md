# SciRetriever config TUI 设计手册

## 1. 目标与 owner

`sciretriever config` 是本地配置中心，不是第二个业务客户端。它帮助用户完成配置、查看脱敏 readiness、执行明确的最小测试，并把配置安全写入 `~/.sciretriever/config.toml`。普通配置和 secret 的读写 owner 必须唯一。TypeScript 已接管 typed projection、发布、credential、TUI/CLI 和 Application 装配；Python 配置中心只作为历史行为基线保留，不进入生产路径。迁移验收只注入临时 home。

如果未来由 TS 接管 TUI，切换必须一次完成：旧 Python 写入口变成只读/迁移提示，并由同一套 parser、publication 和 credential store 提供行为。禁止 Python 与 TS 同时修改同一配置文件。

## 2. 总体导航

首页固定为：

```text
Models   Search   Download   Parse   Analyze   Browser   Status   Theme   Quit
```

导航规则：`↑/↓` 移动，`Enter` 进入，`Esc` 返回，`q` 退出当前视图，`?` 查看快捷键。每个页面顶部显示当前位置、配置文件状态和未保存变更数量。Quit 有未保存变更时先提示保存/放弃/返回。

TUI 必须在窄终端工作：推荐最小 80×24。低于最小尺寸时只显示当前字段、错误和返回操作，不截断 secret 或把表格横向推离屏幕。

## 3. 页面设计

### Models

分为 `Providers`、`Models`、`Analyze`、`Browser Model` 四个视图。Provider 页面管理名称、类型、base URL 和 credential 引用；Model 页面管理模型名、能力声明、reasoning/stream/image 开关。Analyze 与 Browser 只选择已存在的 `provider/model` 引用，不复制 key。

保存前显示差异摘要，例如“新增 provider `openai`；选择 Analyze model `openai/gpt-x`；未修改 Browser”。不显示 key 的长度、hash、mask 或原文。

### Search

管理 Metadata source 的启用、顺序和查询限制。清晰区分“Metadata 能力”和“Download 能力”；一个 Provider 的 metadata 可用不能推断其 PDF 可用。Auto/Custom 顺序、空列表和单来源失败都可保存。

### Download

显示 acquisition source 顺序、启用状态和本地 readiness。没有安全 probe 时明确显示 `acquisition-probe-unavailable`。页面不提供访问未配置镜像、任意 PDF 或未经授权站点的试探按钮。

### Parse

配置 MinerU endpoint、连接模式和部署身份。Token 使用密码输入；Test 只执行 health/readiness，不上传用户 PDF。远程模式显示上传授权和 origin-bound token 是否齐备。

### Analyze

设置当前任务模型、最大动作/时间/字节预算、并发和失败策略。预算是用户可理解的数字，保存时校验上限。测试只验证当前任务模型和协议能力，不发送用户文献。

### Browser

分为 `Setup`、`Profiles`、`Runtime`、`Test`。Setup 选择 image-capable model 和启用开关；Profiles 只显示逻辑 profile 名；Runtime 显示 CloakBrowser/Playwright/Chromium/headed display 的 readiness；Test 分为 `Model` 与明确指定 access key 的 `Site`。打开配置页或 Status 不得隐式启动 Browser。

### Status

Status 是纯本地检查。默认表格包含 Model Providers/Models、Analyze/Browser 选择、MinerU、credential presence、Metadata/Acquisition source 和 storage。输出只显示 `configured / ready / unavailable / blocked` 及下一步，不显示 secret、路径中的用户目录、指纹、hash 或内容。

### Theme

只调整颜色主题、对比度和减少动画。主题不改变配置语义、测试行为或输出 JSON。

## 4. 配置编辑流程

每个编辑页面遵循：

```text
读取 → 编辑草稿 → 本地 schema 校验 → 显示差异 → 用户确认 → 原子发布 → 重新读取验证
```

校验规则：未知 section/key、错误类型、非法 enum、越界数值和错误引用在副作用前拒绝；错误消息指出字段和修复方式，不回显输入。保存采用临时文件、受控权限、no-follow/no-clobber 和原子替换；并发修改发现版本变化时停止并要求重新加载，不能静默覆盖。

credential 字段始终使用密码输入；编辑时留空表示保持原值，明确选择 Remove 才删除。TUI 永远不能把 secret 放到 screen dump、日志、历史命令、事件或 JSON status。

## 5. Test 语义

测试命令和 TUI 按 owner 分层：

| 测试 | 行为 |
| --- | --- |
| `provider <name>` | 有界地读取一次模型目录，不改变选择 |
| `model <provider/model> [--image]` | 验证精确模型及协议能力，不改变 Analyze/Browser 选择 |
| `search <source>` / `search --all` | 执行 Metadata 最小只读请求 |
| `download <source>` / `download --all` | 报告本地 readiness 和是否有安全 probe |
| `parse` | 执行 MinerU health |
| `analyze` | 验证当前 Analyze model |
| `browser model` | 验证当前 Browser model |
| `browser site <access-key>` | 只有显式调用才启动受控 Browser |

每次测试显示：`owner`、目标、结果、耗时、是否联网、是否消耗额度和下一步。`config test --all` 只汇总启用项，不读取 Provider 目录、不测试任意未选模型、不启动 Browser Site、不下载或上传 PDF。

## 6. 快捷键与交互反馈

- `Enter`：确认当前菜单或字段；
- `Tab` / `Shift+Tab`：字段间移动；
- `Space`：切换布尔值；
- `Ctrl+S`：保存草稿并进入差异确认；
- `Esc`：取消当前编辑并返回；
- `?`：打开当前页面帮助；
- `Ctrl+C`：取消正在运行的 test，确保 AbortSignal 释放网络资源。

底部状态栏固定显示：`未保存变更`、`保存成功`、`测试中`、`已取消` 或错误 code。长操作显示阶段和取消键，不能让用户面对无期限 spinner。

## 7. JSON 与自动化接口

交互界面和 `config status`/`config test` 共用同一只读 projection。JSON 顶层建议保持现有结构：`models`、`analyze`、`download`、`browser`、`parsing`、`providers`、`storage`、`execution`、`library`。字段表示状态和 capability，不包含 secret、路径敏感部分、hash、fingerprint 或原始响应。

TUI 不应解析人类可读输出作为内部 API。所有页面由 typed command/result 驱动；命令结果应有稳定 code、状态、错误原因和建议动作。

## 8. Browser 工作台联动

TUI 的 Browser 页面只负责配置和 readiness。真实页面观看、接管、输入、Candidate 审核全部在 Browser 工作台完成。TUI 可以提供“打开工作台”入口，但不得自己创建第二个 Browser Host，也不得绕过 Browser policy 直接执行站点操作。

## 9. 验收清单

1. 首次运行能在不存在配置文件时创建目录并安全保存；
2. 无效 section/key/type 在任何外部测试前被拒绝，原文件字节不变；
3. 配置、凭据、Status、JSON 都没有 secret 泄漏；
4. 保存失败、并发修改、取消 test、终端太小均有明确反馈；
5. `Status` 不联网，`Browser site` 是唯一显式启动 Browser 的配置测试；
6. TUI 与 CLI 使用同一 owner、parser、publication 和 projection；
7. Browser readiness 能指出缺失的模型、credential、runtime、binary、Profile 或 headed display；
8. 现有用户可继续使用原有命令和配置文件，迁移不会静默覆盖或重置配置。

## 10. 实施建议

稳定的 configuration contract、readiness projection、TS parser、Credential Broker、command service 和 TUI/非 TTY 入口已完成。Python 行为只作为历史 oracle；生产路径保持单一 TS owner，避免两个高风险 owner 并存。
