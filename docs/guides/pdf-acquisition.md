# PDF 获取指南

SciRetriever 对数据库中已存在的 Literature 执行自动 PDF 补全。它不会在主题发现或引用发现
时顺带下载全文，也不会把某个 Metadata Provider 当作原文访问方。默认流程固定为：

```text
Public
  -> Authorized Provider API
  -> Controlled Browser
```

Browser 是风险最高且最慢的一层，只能处理前两层正常耗尽后仍未解决的最小集合。当前版本已经
提供 Browser 的安全基础设施、operator-managed profile、人工登录入口与第一条 production
route `browser:springerlink`。该 route 只对访问方证据收敛到 SpringerLink、具有唯一 DOI、
前两层正常结束且本地 Browser runtime/profile 就绪的文献适用；其它 Publisher 不获得
generic Browser fallback。

## 1. 当前支持矩阵

| 层 | 当前生产能力 | 配置或适用条件 | 当前边界 |
| --- | --- | --- | --- |
| Public | 已保存的 direct/landing `AssetHint` | 当前 Literature 已有可复核 locator | 所有 URL、redirect、媒体类型和实际 PDF 字节仍重新检查 |
| Public | arXiv、Europe PMC、Unpaywall | 在 `[sources.acquisition].providers` 启用；Unpaywall 另需公开联系邮箱 | 正常未命中才继续下一条路线 |
| Public | Metadata Provider 提供的公开 locator | 先由对应 Metadata adapter 形成 `AssetHint` | locator 不等于 PDF；仍由通用 Public route 获取和验证 |
| Public | Configured Sci-Hub operator locator | 只有程序调用方显式注入中性 resolver 时才 ready | stock CLI 不提供 endpoint、resolver 或凭据配置 |
| Authorized API | CORE API v3 | 启用 `core`、配置 `api_key`，并有 CORE `work:`/`output:` 强身份 | 有 key 不等于当前记录或文章可下载 |
| Authorized API | Elsevier Article/Object Retrieval | 启用 `elsevier`、配置 `api_key`；可选 `institution_token`；需 PII、Article EID 或已确认 landing | 显式 `MAIN web-pdf` object 优先；无可用 MAIN object 时以同一强身份协商 Article PDF；错误、XML 与 supplement 不冒充主 PDF |
| Authorized API | Wiley TDM API v1 | 启用 `wiley`、配置 `tdm_api_token`，且 DOI 安全落地到 Wiley Online Library | token、公网 IP 授权和文章 entitlement 是三个不同事实 |
| Authorized API | Springer | 无 | 当前 Full Text 产品是 JATS/XML，主 PDF route 为 unsupported |
| Controlled Browser | SpringerLink `springerlink-pdf@4` | `[access]` 显式启用；安全 operator profile、Playwright 与 Chromium 就绪；SpringerLink landing 或精确 asset origin 等强证据 + 唯一 DOI | 同 `springerlink` group 串行，每篇文章启动间隔至少 10s；先打开 rule 从唯一 DOI 构造的经审查 PDF locator 并接收初始 capture，绝不导航 Metadata Provider 给出的 opaque asset path；未捕获 PDF 时才检查封闭页面状态和 entitlement-gated static click；profile/login/entitlement 分立 |

Provider key 被配置模型认识、已启用、凭据存在、认证成功、当前文章有 entitlement 和最终取得
有效 PDF 是不同状态。用 `sciretriever config status` 查看本地 readiness；只有确实需要外部
连通性诊断时才显式执行 `config test`。

## 2. 批次、限速与预计时间

`complete pdf` 先冻结本次目标，再按 cohort 推进：

1. 对全部目标执行 Public；已成功目标不进入后续层。
2. 用 landing、稳定文章 ID 和 route hint 重新识别访问方。
3. 只对剩余且适用的目标执行 Authorized API。
4. 再次规划，只把允许升级的最小剩余集合交给 Browser admission。

普通 HTTP 与官方 API 使用各自真实的 Provider/host/quota scope，按已核实政策、窗口、
`Retry-After` 和动态阻塞执行；它们不会继承 Browser 的文章级串行规则。Browser 另按
`browser_rate_limit_group` 调度：

```text
SpringerLink group:  S1 --at least 10s/cooldown-- S2
Approved group B:    B1 --its own interval/window-- B2

SpringerLink 与将来独立准入的 B 可以重叠执行；每个组内部 concurrency 固定为 1。
```

当前只有 SpringerLink 一个 production Browser group，所以上图的跨出版商并行是调度合同，
不是对第二个站点已上线的声明。文章级 Publisher scheduler 与页面内 host admission 分开：
前者限制整篇文章流程的启动与串行，后者审查顶层导航、redirect 和静态 PDF 点击产生的实际
请求，不把 10 秒文章间隔错套到每一跳。当前 SpringerLink 文章规则只把 Metadata asset URL
用于提取精确 origin；实际 Browser 起点由 revisioned rule 和唯一 DOI 构造。它在连接前拒绝 stylesheet、
script、image、font 等非关键子资源，以免页面资源抢占单一 Browser 引擎；这不会放宽 origin、
Cookie、capture 或文章归属检查。

`[access].browser_max_concurrency` 只限制同一进程同时运行多少个不同风险组，不能提高组内并发。
普通配置中的 policy override 只能收紧已核实基线，不能缩短间隔、扩大窗口或抹掉 cooldown。

Browser admission 日志会在产生副作用前报告：

- `parallel_group_count`：本轮允许并行的风险组数；
- `minimum_start_interval`：该组相邻文章开始之间的最低间隔；
- `next_allowed_in_seconds`：现有 interval/window/cooldown 距离下次允许开始的时间；
- `minimum_duration_seconds`：按当前允许文章数和已知等待计算的保守下界。

不同组并行时，总体下界取最慢组，而不是把各组相加。这个值不是完成承诺，不包含不可预测的
DNS/网络延迟、网页渲染、下载时间、外部服务排队或人工操作。当前只有 SpringerLink
work 可以产生实际 Browser 运行时间，且仍须先通过 admission。

## 3. 机构 IP、可选人工登录与 Browser 状态

运行裸 `sciretriever config`，进入 Provider Access/Controlled Browser 区，可以：

1. 选择或初始化一个 operator-managed profile；
2. 仅在文章实际要求登录、机构选择或 MFA 时，明确打开可见 Browser 处理该动作；
3. 删除所选本地 Browser session；
4. 禁用 Browser 总开关但保留 session。

正式文章流程不会先要求个人登录。它直接使用当前机器的正常网络出口访问已批准的文章目标；
若出版社按机构 IP 放行，PDF 会在同一受控下载与验证边界内自然交付。persistent profile 用于
隔离和复用会话，不等同于已登录，也不妨碍纯 IP entitlement。只有文章页实际返回登录、MFA、
challenge 或其它 action-required 结果时，才需要人工处理。

SciRetriever 不自动填写账号、选择机构、处理 MFA/CAPTCHA、导出 Cookie 或猜测登录 URL。
profile 目录存在只表示本地容器存在；关闭一次人工登录窗口也不证明 session 仍已认证；认证成功
更不证明机构 IP 或任意文章有全文 entitlement。`config status` 不打开 Browser，所以
`authenticated` 保持 unknown，`article_entitlement` 保持 not-proven。

当前 SpringerLink 已经过 route/rule/policy 的生产准入；其自动 Completion 仍同时要求
`browser_enabled = true`、安全 profile presence、Playwright 和 Chromium 就绪。这只表示运行时可以启动，
不表示 profile 已登录或目标文章有 entitlement。使用
`sciretriever config test --browser springerlink` 可做一次显式的 runtime/首页可达性探测，并
可选观察个人登录迹象；没有个人登录不会使探测失败。该 probe 不打开具体文章、不下载 PDF，
也不评估机构 IP 或任意文章授权。机构 IP 与文章 entitlement 只由具体文章尝试的实际响应判断。

## 4. 失败、暂停和重跑

| 结果 | 当前操作 | 是否立即升级 Browser |
| --- | --- | --- |
| 明确不适用、正常未命中、明确无 PDF 能力 | 继续同层其它路线或进入下一层 | 前两层全部正常耗尽后才可能 |
| 支持的 API 未配置 | 继续尝试同层其它独立 route；全部低风险 route 结束后以 action-required 收口 | 否，不用 Browser 绕过未配置或临时不可用的 API |
| timeout、临时网络错误、`503` | 标为可重试的 deferred/failed | 否 |
| `429`、quota、`Retry-After` | 更新共享阻塞并等待或延期 | 否，不能用 Browser 绕过 API 限制 |
| 登录、MFA、challenge、IP block、账号警告 | 暂停或熔断对应 Browser group | 不继续该组；其它 Provider group 可继续 |
| 配置、Storage、发布、清理或合同错误 | 立即失败 | 否 |
| Ctrl+C | 受控中断，清理未交付临时资源 | 重跑时重新读取 current facts |

后续阶段失败不会撤销已经提交的有效元数据或资产。只有所有适用自动路线正常耗尽，系统才记录
`NoPrimaryPdf`；临时错误、取消、配置问题和无法判断的授权结果不会伪装成耗尽。重跑同一个
selector 时，SciRetriever 会从数据库当前事实出发，只补仍缺失的步骤，不依赖上一轮内存队列。

常用命令：

```bash
sciretriever config status
sciretriever config status --json
sciretriever config test --browser springerlink
sciretriever complete pdf --all-pending --json
sciretriever --debug complete pdf --all-pending --json
```

正常结果写 stdout，进度和日志写 stderr。需要保留证据时应分别重定向。正常日志显示由 Entry
汇总的 tier/Browser escalation、Provider group 等待/暂停、交付/耗尽和稳定失败，不逐条刷
route miss；Debug 额外显示 route `disposition/next/elapsed`、授权 API target/lookup/download，
以及 Browser eligible/admitted/attempted/delivered、queue wait、session reuse、state/capture/cleanup。
这些字段仍不输出 secret、Cookie、完整 URL、selector、profile 路径/内容或 PDF 字节。

## 5. 使用责任

按 Provider 政策限速、同风险组串行和 challenge 熔断能降低误用与封号风险，但不能保证账号、
机构访问或公网 IP 永远不会受限。用户必须自行确认文献访问授权，并遵守账号、机构、出版社和
站点的适用规则。SciRetriever 不自动登录、不绕过 CAPTCHA/MFA，也不通过代理轮换或换入口规避
限速与拒绝。
