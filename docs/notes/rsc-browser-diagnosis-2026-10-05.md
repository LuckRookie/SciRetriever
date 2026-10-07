# RSC 手动可下载与 Browser 失败的对照诊断

## 后续 DNS 传输对照

用户询问管理员是否需要修改 DNS 后，补做服务器端解析测试。没有修改系统 DNS 或 Browser 配置。
当前 `systemd-resolved` 的 stub 为 `127.0.0.53`，`eno1` 配置的上游是
`114.114.114.114`、`223.5.5.5`；网络由 `systemd-networkd` 管理。

| 查询路径                                                                               | 本轮结果                                                     |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 系统 stub，以及 114.114.114.114、223.5.5.5、119.29.29.29、1.1.1.1、8.8.8.8 的 UDP 查询 | 连续两轮 `SERVFAIL`                                          |
| 1.1.1.1 的 TCP 查询                                                                    | 首次及随后两次共三次成功，返回完整 CNAME 链及两个公网 A 地址 |
| 1.1.1.1 的 UDP 查询，分别启用和关闭 EDNS                                               | 随后两轮仍均为 `SERVFAIL`                                    |
| 8.8.8.8 的 TCP 查询                                                                    | 两轮超时                                                     |
| 223.5.5.5 的 TCP 查询                                                                  | 超时                                                         |
| 直连 Google / Cloudflare 的 HTTPS DNS 查询                                             | 分别连接超时 / 连接重置；没有可用 DNS 响应                   |

成功的 TCP 查询命令：`dig +tcp @1.1.1.1 id.rsc.org A`。
它与同地址 UDP 查询的结果不同，说明不能仅通过更换 DNS 地址宣称已修复。
现有证据支持排查 DNS 传输路径差异；尚不足以断言是拦截、透明转发或具体解析器故障。

管理员可先在独立本地端口部署 DNS 转发服务，对选定上游强制 TCP，验证后再接入系统解析器。
应保留原配置、校内域名解析规则及回滚路径，优先用条件转发缩小变更范围；不要把 CDN 地址写死到 hosts。
此操作只调整域名解析，不要求把 Browser 的 HTTP/HTTPS 流量改为外部代理。
系统解析恢复后仍需单独复测 Browser；此前的 HTTP 429 不会因 DNS 修复而自动得到解释或保证消失。

## 范围

用户已手动取得 DOI `10.1039/c4cp05552g` 的 PDF，并提供文章页截图及 PDF 直链。
本次只诊断同一篇文章的 Browser 路径，不把先前失败推断为版权不足，不修改出版社规则或生产代码。

- 用户提供的 PDF：<https://pubs.rsc.org/cp/article-pdf/17/7/4799/3560186/c4cp05552g.pdf>
- 文章页：<https://pubs.rsc.org/cp/article/17/7/4799/434121/Recent-progress-in-theoretical-and-computational>
- DOI 入口：<https://doi.org/10.1039/c4cp05552g>

使用当前生产构建、Cloak `146.0.7680.177.5`、真实模型 `qiuzk/gpt-6-luna`。
复用前轮真实 Crossref 元数据缓存；隔离 Application、catalog、Profile 与资产目录。
模型接收实际截图与观察；没有编排 RSC 专用点击脚本，没有复制或读取用户 Cookie。
前三次测试使用不同入口的新 Profile，随后复测 DOI/PDF，并复用本轮自己建立的 Profile 做对照。
测试时间为 2026-10-05 10:23—10:29（北京时间）。

## 现场证据

| 尝试 | 入口 / 会话                          | 观察结果                                                                                                                       | 证据子目录                   |
| ---- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| 1    | DOI / 新 Profile                     | 第二次模型调用出现 `agent-remote`；该次不能用来判断 RSC 最终访问结果                                                           | `rsc-doi-browser-R8Gswg`     |
| 2    | 用户文章页 / 新 Profile              | 模型等待并点击验证控件，网站自动进入静默认证链；`id.rsc.org` 连接失败，返回 `browser-navigation-failed`                        | `rsc-article-browser-3wMfgN` |
| 3    | 用户 PDF 直链 / 新 Profile           | 同样进入静默认证链并在 `id.rsc.org` 连接失败；未收到 PDF                                                                       | `rsc-pdf-browser-IGNuMk`     |
| 4    | DOI / DNS 恢复后、新 Profile         | 静默认证继续运行，`OIDCLoginCompleted` 返回 HTTP 429；最终为 `browser-rate-limited`                                            | `rsc-doi-browser-prlCXQ`     |
| 5    | PDF 直链 / DNS 恢复后、新 Profile    | 认证回调成功跳转，`ArticlePdfHandler.ashx` 返回 HTTP 429；运行超过四分钟仍未返回，诊断进程树被终止                             | `rsc-pdf-browser-YdcLir`     |
| 6    | PDF 直链 / 复用尝试 4 的隔离 Profile | 距上次 PDF 接口 429 约三分钟；不再经过验证与认证跳转，PDF 直链直接返回 HTTP 429，无 `Retry-After`；0 次模型调用，约 3.5 秒返回 | `rsc-pdf-browser-UmRCfU`     |

尝试 2、3、4、5 中，模型动作均为等待和点击验证控件；后续认证跳转由网页自动发起。
它们没有到达正文 PDF 按钮供模型观察、点击的阶段。尝试 5 在终止进程树的诊断干预后才写出结果，不能算作正常完成的失败验收；
已确认其最后主文档响应为 429、没有 Intake 接纳事件，具体停滞阶段尚未定位。
本轮没有下载入库成功，不把用户手动成功记成 Agent 成功。

首轮跳转链（省略所有 query 值）：

```text
文章页 / PDF 直链
  → Cloudflare 验证页
  → pubs.rsc.org/ExternalAuthentication/SilentOIDCLogin
  → sso.rsc.org/connect/authorize
  → sso.rsc.org/External/Silent
  → id.rsc.org/authorize
  → 浏览器 ERR_EMPTY_RESPONSE
```

独立系统 DNS 检查在 10:22 得到 `id.rsc.org: EAI_AGAIN`；10:24 再查，系统 A/AAAA/CNAME
解析恢复，随后连续三次 `lookup` 均成功。恢复后的真实 Browser 日志也包含 `id.rsc.org/authorize`
的 HTTP 302，证明该故障具有时间变化，不能描述为永久不可达。

DNS 恢复后，认证回调链经过 `auth0-signin`、`SilentCallback`、`UniversalCallback`、
`OIDCLogin`；DOI 复测在 `OIDCLoginCompleted` 收到 429，PDF 复测则进一步到达
`HTTPHandlers/ArticlePdfHandler.ashx` 后收到 429。这两类证据与早期 DNS 失败必须分别记录。

## 已定位的通用实现问题

1. `network/policy.ts` 的 `resolveDestination` 把 resolver 异常转换成通用网络准入失败，
   丢失 DNS 暂态错误分类；代理关闭连接后，浏览器只看到 `ERR_EMPTY_RESPONSE`。
2. `browser/page-runtime.ts` 的 `snapshotDocument` 遇到浏览器内部错误页就抛出
   `BrowserPageNavigationError`；Agent 得不到可操作的导航失败观察。
   `browser/article-flow.ts` 保留错误分类后终止流程，不能让模型在预算内选择等待、返回或重试。
3. `browser/boundary.ts` 的拒绝合同固定为 `retryable: false`，临时 DNS 失败与限流也落入这一结果。
   若要调整，应按合同影响处理生产者、消费者与调度，而非在 RSC 分支中反复刷新。

当前 429 逻辑已有一次受约束重试：GET、有效 `Retry-After`、剩余预算足够时才重试。
尝试 6 明确没有该响应头，诊断记录显示 `retry_at: null`、`retried: false`。
因此不能把本轮全部归因于“没有等待”，也不能无依据增加高频重试。

## 结论与未证实事项

手动成功证明文章存在可行访问路径。新隔离会话曾在静默认证依赖的 DNS 处失败，DNS 恢复后又收到
真实 HTTP 429；复用隔离会话虽然跳过了认证链，仍未消除 429。没有 PDF 字节进入验收，
因此本轮不是文章身份校验、PDF reader 或入库拒绝导致的失败。

尚未取得手动浏览器的网络证据，无法证明其与运行机器拥有相同出口、DNS、浏览器状态或站点风控待遇。
429 本身也不能区分请求频率、出口 IP、会话或浏览器特征触发的策略；不能断言其具体风控原因。
生产 Host 本身使用持久 Profile；每次创建新 Profile 是前轮隔离测试的方法，不能写成产品永久不保留会话。

下一步应以相同机器、出口和独立持久 Profile 做人工/Agent 对照，并完善通用导航失败观察、
DNS 错误分类和可延期重试语义。无需新增 RSC URL 拼接或专用 selector。

## 证据与验证范围

临时证据根目录：`/tmp/sciretriever-rsc-diagnosis-20261005-ip71sf9w/`。
各尝试有 `result.json`；过程保留 `events.jsonl`、观察和截图。
尝试 5 单独保存 `diagnostic-termination.json`；其 `browser-rate-limited` 结果在诊断干预后才写出，
耗时约 250 秒。`results.jsonl` 包含六次记录，其中只有五次未经终止干预正常返回。

本次为真实诊断与文档记录，没有生产源码、依赖或数据合同变化；未重跑 Quick/Full。
前轮 Full 结果见 [通用修复验证报告](browser-generic-repair-validation-2026-10-05.md)，
其通过不能替代本次外部网站成功验收。
