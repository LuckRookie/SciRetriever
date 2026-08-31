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
| 固定访问模式 | CloakBrowser patched Chromium + fixed identity + `headless = false`；无 GUI Linux 使用 Xvfb，probe 不提供用户交互 |
| Browser Profile identity | `<opaque-nonsensitive-profile-identity>`；不是路径、账号、机构或登录结论 |

允许的状态只有 `draft-not-authorized`、`authorized-not-started`、`running`、`stopped`、
`inconclusive`、`failed`、`verified-awaiting-review`、`closed`。任何状态都不能单独改变 Profile
production status。

## 2. 前置证据清单

- [ ] 官方自动访问/TDM/订阅条款已核对并在 Provider Notes 记录日期和 URL。
- [ ] 当前机器网络出口及拟访问内容的使用权由 operator 自行确认。
- [ ] Profile 已是 `production-ready`，生产 rule、manifest 和离线 fixture 完整闭环。
- [ ] Browser policy 数字有 Provider-specific 依据，不使用全局默认间隔。
- [ ] Local HTTPS/真实 Chromium、页面资源/redirect、validation/publication、取消和清理测试通过。
- [ ] 已选择并安全初始化持久 Profile；probe 不读取其内容，也不包含登录、机构选择、Cookie 导入、MFA/CAPTCHA、反检测或未知站点步骤。
- [ ] 样本不需要登录、机构选择、MFA 或人工 challenge；这些交互不属于第一版现场核实范围。

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
| Approved page-resource origins | `<closed-origin-set>` |
| Stable article identity | `<namespace-and-match-rule>` |
| Primary capture | `<closed-rule-category>` |
| Supplement / excluded / wrong article | `<closed-rule-category>` |
| Entitled markers | `<fixture-marker-ids>` |
| Login / paywall / not-entitled markers | `<fixture-marker-ids>` |
| MFA / challenge / rate / IP / account markers | `<fixture-marker-ids>` |

不要在本文件写完整文章 URL、selector、页面正文、签名 locator 或真实响应。未批准第三方页面资源
必须在 DNS 前丢弃；点击或页面脚本产生的显式 request 必须逐项复审，未暴露 route 的 native
redirect 只有同页 live ancestor、批准且预绑定的最终 origin 与 terminal host admission 同时成立
时才能关联。

## 6. 仓库外落点与清理选择

| 项目 | 已批准的位置类别或处理方式 |
| --- | --- |
| Catalog / ArtifactStore | `<approved-run-directory-category>` |
| Reports / normal log / debug log | `<approved-run-directory-category>` |
| Catalog/assets/log cleanup | `<retain-or-remove-after-explicit-confirmation>` |
| Browser Profile / 临时工作区 | 所选持久 Profile 保留；自动下载工作区在 broker 关闭后删除 |

- [ ] 落点不在仓库、源码、测试 fixture 或用户未批准的位置。
- [ ] 删除范围已解析为精确目标，不删除用户既有资产。
- [ ] 日志和报告脱敏规则已确认。

## 7. 用户另行授权复核

- [ ] 我确认只核实本单一个 Provider/access key。
- [ ] 我确认匿名样本和当前机器网络出口在我的授权范围内。
- [ ] 我确认可能触发真实请求、IP 限速或站点风控。
- [ ] 我确认 probe 使用普通配置选中的持久 Profile 和当前机器网络出口，执行时不隐式登录、不导入 Cookie，也不读取登录结果。
- [ ] 我确认所有停止条件、预算、时间窗、落点和清理选择。
- [ ] 授权记录位置：`<conversation-or-change-record-reference>`；不复制敏感正文。

## 8. 执行记录与停止条件

执行前：

- [ ] 再次显示并核对 policy、预算、落点、access key/rule revision 和当前时间窗。
- [ ] Public/API 正常结束与 Browser admission 已由受控运行证明。
- [ ] Cloak wrapper、Playwright API、经核实 binary、fixed identity manifest、headed display/Xvfb、持久 Profile 独占 lease 和临时下载工作区 readiness 已确认。

出现 `429`/quota/`Retry-After`、login、MFA、challenge resource-blocked、所选 controller 结束后
仍为 `challenge-unresolved`、IP block、account warning、未知 origin、entitlement 不确定、
supplement/wrong article、budget、timeout、cleanup/publication/数据完整性
错误或用户取消时立即停止；不得换入口、换网络、提高频率或扩大样本。

| 结果字段 | 脱敏记录 |
| --- | --- |
| 开始 / 结束 UTC | `<timestamps>` |
| 实际文章流程 / 导航 / 请求 | `<counts>` |
| 最大并发与实际 start 间隔 | `1` / `<seconds>` |
| 稳定 outcome / code | `<safe-values>` |
| primary / supplement / wrong article | `<category-only>` |
| 临时工作区 / Profile lease / 残留进程检查 | `<safe-result>`；不记录 Profile 路径或内容 |
| 停止原因 | `<safe-reason>` |

## 9. 结果与后续审查

- [ ] 原始 Cookie、响应、PDF、截图、个人路径、数据库和日志未进入 Git。
- [ ] 临时下载工作区已删除、Profile lease 已释放且持久 Profile 保留，没有残留 Chromium/Playwright 线程。
- [ ] 对应 Provider Notes 只增加了脱敏、可审查的事实和日期。
- [ ] evidence/rule/fixture 与 status 更新经过独立代码/文档审查。
- [ ] 相关定向测试、安装 wheel acceptance、Quick 和 Full 已重新通过。
- [ ] 现场结果没有被描述成长期 SLA、所有文章 entitlement 或自动 production-ready。

最终结论：`<inconclusive|failed|verified-awaiting-review>`。
