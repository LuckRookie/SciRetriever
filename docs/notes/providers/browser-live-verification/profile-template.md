# `<access-key>` Browser 现场核实单

> 复制本模板后必须把文件命名为 `<access-key>.md`。尖括号字段只是安全占位，不是授权。
> 未完成全部必填项和用户授权复核时，状态必须保持 `draft-not-authorized`。

## 1. 身份与状态

| 字段 | 值 |
| --- | --- |
| 状态 | `draft-not-authorized` |
| Access key | `<stable-access-key>` |
| Provider / platform | `<display-name>` |
| Provider Notes | `<repository-relative-note>` |
| Profile evidence revision | `<revision>` |
| Browser rule id / revision | `<rule-id>` / `<positive-revision>` |
| 代码 commit | `<commit>` |
| 核实负责人 | `<operator-role>`；不写账号、邮箱或机构身份 |
| 授权生效 / 到期 | `<UTC-window>` |

允许的状态只有：

```text
draft-not-authorized
authorized-not-started
running
stopped
inconclusive
failed
verified-awaiting-review
closed
```

任何状态都不能单独改变 Profile production status。

## 2. 前置证据清单

- [ ] 官方自动访问/TDM/账号条款已核对并在 Provider Notes 记录日期和 URL。
- [ ] 当前账号/机构/网络对拟访问内容的使用权由 operator 自行确认。
- [ ] Browser policy 数字有 Provider-specific 依据，不使用全局默认间隔。
- [ ] Profile 状态为 `fixture-verified`，有真实 rule、manifest 和完整离线 fixture。
- [ ] Local HTTPS/Chromium、validation/publication、取消和清理测试通过。
- [ ] production catalog 仍保持 fail closed；现场核实本身不提前上线 route。
- [ ] 没有需要自动登录、机构选择、MFA/CAPTCHA、反检测或任意脚本的步骤。

## 3. 精确样本与授权预算

真实样本标识只写入获准的仓库外运行记录，本文件使用匿名编号：

| 项目 | 获准值 |
| --- | --- |
| 匿名样本 | `<sample-01>` |
| 样本选择依据 | `<owned-or-authorized-access-basis>` |
| 最大文章数 / 文章流程数 | `<count>` / `<count>` |
| 最大顶层导航 / rule 动作 | `<count>` / `<count>` |
| 最大 popup / download | `<count>` / `<count>` |
| 最大总请求 / 总响应字节 | `<count>` / `<bytes>` |
| 最大单篇 / 总 wall time | `<seconds>` / `<seconds>` |
| 允许人工登录 | `<yes-or-no>`；不得自动填充或处理 MFA/CAPTCHA |
| 重试数 | `<count>`；每次重新排队并服从同一 policy |

## 4. Provider-specific 调度政策

| 字段 | 获准值与证据 |
| --- | --- |
| `browser_rate_limit_group` | `<stable-group>` |
| `browser_session_key` | `<stable-session-key>` |
| `max_concurrency` | `1` |
| `minimum_start_interval` | `<seconds-and-evidence>` |
| `maximum_starts_per_window` / `window_seconds` | `<count>` / `<seconds>` |
| completion / failure / rate-limit cooldown | `<seconds>` / `<seconds>` / `<seconds>` |
| runtime failure threshold | `<count>` |
| `Retry-After` | 始终服从；只能延长阻塞 |

若任一政策值未知，本单不能进入 `authorized-not-started`。

## 5. Origins、页面和正文归属

| 字段 | 获准边界 |
| --- | --- |
| Landing origin | `<exact-https-origin>` |
| Allowed navigation/capture origins | `<closed-origin-set>` |
| Stable article identity | `<namespace-and-match-rule>` |
| Primary capture | `<closed-rule-category>` |
| Supplement / excluded / wrong article | `<closed-rule-category>` |
| Authenticated / entitled markers | `<fixture-marker-ids>` |
| Login / paywall / not-entitled markers | `<fixture-marker-ids>` |
| MFA / challenge / rate / IP / account markers | `<fixture-marker-ids>` |

不要在本文件写完整文章 URL、selector、页面正文、签名 locator 或真实响应。

## 6. 仓库外落点与清理选择

| 项目 | 已批准的位置类别或处理方式 |
| --- | --- |
| Operator-managed profile | `<opaque-profile-identity>`；不写绝对路径或内容 |
| Catalog / ArtifactStore | `<approved-run-directory-category>` |
| Temporary downloads | `<approved-run-directory-category>` |
| Reports / normal log / debug log | `<approved-run-directory-category>` |
| Profile retention | `<retain-or-remove-after-explicit-confirmation>` |
| Catalog/assets/log cleanup | `<retain-or-remove-after-explicit-confirmation>` |

- [ ] 落点不在仓库、源码、测试 fixture 或用户未批准的位置。
- [ ] 删除范围已解析为精确目标；不删除既有 profile 或用户资产。
- [ ] 日志和报告脱敏规则已确认。

## 7. 用户另行授权复核

以下全部勾选后，用户仍须对本文件的精确 access key、样本、预算、时间窗、profile、落点和清理
选择给出明确授权：

- [ ] 我确认只核实本单一个 Provider/access key。
- [ ] 我确认样本和访问环境在我的授权范围内。
- [ ] 我确认可能触发真实请求、账号限速或站点风控。
- [ ] 我确认自动 route/probe 使用受控无头 Browser；如需可见 Browser，仅用于我自行完成登录/机构/MFA，人工步骤不会被自动化。
- [ ] 我确认所有停止条件和预算。
- [ ] 我确认仓库外数据、日志、profile 的保留/清理选择。
- [ ] 授权记录位置：`<conversation-or-change-record-reference>`；不复制敏感正文。

## 8. 执行记录与停止条件

执行前：

- [ ] 再次显示并核对 policy、预算、落点、精确 production access key/rule revision 和当前时间窗。
- [ ] Public/API 正常耗尽与 Browser admission 已由受控运行证明。
- [ ] Browser/runtime/profile readiness 只在本次授权范围内确认。

出现 `429`/quota/`Retry-After`、MFA/CAPTCHA/challenge、IP block、account warning、未知 origin、
entitlement 不确定、supplement/wrong article、budget、timeout、cleanup/publication/数据完整性错误或
用户取消时立即停止；不得换入口、换账号、换 profile、提高频率或扩大样本。

| 结果字段 | 脱敏记录 |
| --- | --- |
| 开始 / 结束 UTC | `<timestamps>` |
| 实际文章流程 / 导航 / 请求 | `<counts>` |
| 最大并发与实际 start 间隔 | `1` / `<seconds>` |
| 稳定 outcome / code | `<safe-values>` |
| primary / supplement / wrong article | `<category-only>` |
| cleanup / residual process check | `<safe-result>` |
| 停止原因 | `<safe-reason>` |

## 9. 结果与后续审查

- [ ] 原始 Cookie、响应、PDF、截图、个人路径、profile 和日志未进入 Git。
- [ ] 对应 Provider Notes 只增加了脱敏、可审查的事实和日期。
- [ ] evidence/rule/fixture 与 status 更新经过独立代码/文档审查。
- [ ] 相关定向测试、安装 wheel acceptance、Quick 和 Full 已重新通过。
- [ ] 现场结果没有被描述成长期 SLA、所有文章 entitlement 或自动 production-ready。

最终结论：`<inconclusive|failed|verified-awaiting-review>`。

若不是后者，Browser route 保持 `fixture-verified`/`unsupported`；即使是后者，也必须完成
[现场通过后的独立上线步骤](README.md#7-现场通过不等于自动上线)才能改变 production catalog。
