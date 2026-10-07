# Browser 通用修复与真实验证（2026-10-04—05）

## 范围与验收口径

按本轮用户要求，验证给定元数据后的独立 Browser 通道，不重新验收公开 URL/API 的自动路由。
覆盖 22 个出版社/平台、23 篇真实文章（Elsevier 含订阅与 OA 两个样本）。元数据使用前轮真实
Crossref 响应缓存。使用当前机器出口 IP、新建隔离 Profile，没有复制用户 Cookie；所有测试文献、
PDF、catalog、截图与日志都在系统临时目录，不进入用户 Library 或 Git。

模型始终为 `qiuzk/gpt-6-luna`，浏览器为已验证 Cloak `146.0.7680.177.5`。隔离 Application 的
Agent 调用转接配置 owner 组装的真实 Runtime，传入实际目标、页面观察和截图，由真实模型返回动作；
没有按出版社生成动作脚本。每项“成功”都实际经过 Browser 下载、Intake PDF reader、Candidate
acceptance、primary-pdf publication 和文件导出/hash 核对。下载文件保持“文章身份未验证”；
运行记录中的 `verified: true` 仅表示 PDF 文件头与导出 SHA-256 一致，不表示文章内容身份已检验。

这是修复过程中的现场采样：初轮完整跑全部样本，随后对失败样本和 Nature 控制样本复测。
最后的观察/表单修复再次验证 Copernicus、Elsevier、Nature 和 IEEE；并未在每次内部改动后重跑所有出版社。
一次成功也不构成该出版社所有文章或长期稳定性的保证。

## 通用修复

设计依据见 [ADR 0030](../architecture/decisions/0030-browser-transport-and-progress.md)。

- 临时 Browser URL 与无凭据持久 locator 分开；正常编码路径、`key`/`token` 等临时 query 和
  HTTP 跳转可运行，来源、模型观察与日志继续去除 query/fragment，公网 DNS/IP/端口边界保留。
  移除把全部 multipart 误作文件上传的规则，页面可提交正常表单；本地文件选择继续被动作边界和
  file chooser 限制。IEEE 的 AWS WAF `mp_verify` 正是受此旧规则影响。
- CONNECT 连接建立后释放请求 permit，存活连接独立设容量和空闲超时；流量刷新超时，不再把
  多次 TLS 请求累计字节当成一份 PDF。只在已准入地址集合中选择 IPv4/IPv6，避免首个 IPv6
  不可达便放弃全部地址。
- 导航 commit 后交接可观察页面，不等待所有子资源/字体。窗口尺寸暂为零、上下文因导航销毁时
  重新观察；工作台也恢复这种暂态。字体截图失败且有敏感输入时保留 DOM、丢弃截图，不泄漏输入。
- 模型工具改为六种动作的严格判别联合；保留每种动作自己的字段。坐标是当前 viewport 的 CSS
  像素，越界动作反馈实际边界，未执行的动作不记成成功点击；近期动作与点击落点反馈帮助模型恢复。
- 观察仅提取可见正文，排除 hidden/noscript/输入内容；控件名称支持 aria-label、title 和图片 alt。
  无历史记录的子标签页可返回原文章页；重复输入改为等待，固定冷却及总预算保留。
- 文件验收通过即结束生产探索并交付，不继续等待模型 Stop。真实捕获与空候选队列分开，已经接纳
  的候选不会被后续 viewer 故障掩盖；202 等不完整/错误页面上的 Stop 不成为正常 PDF 耗尽。
- 429 只在 GET、有效 Retry-After、剩余预算允许且尚未重试时等待重试一次；否则保留限流原因。
  真实限流、导航失败、验证页模型停止和预算耗尽分别报告。

没有新增出版社 selector、URL 拼接策略、依赖、数据库表或用户配置迁移。

## 现场结果

**最新累计结果：23 篇中 20 篇正式入库，3 篇未取得 PDF。**

| 出版社/平台 | DOI | 最后结果 / PDF 字节 | 模型调用 | 证据目录 |
| --- | --- | --- | ---: | --- |
| Nature | `10.1038/nature14539` | 成功，2,964,524 字节 | 2 | `nature-browser-gJemlW` |
| SpringerLink | `10.1007/s12055-024-01728-3` | 成功，1,386,174 字节 | 2 | `springer-browser-i50qAx` |
| ACS | `10.1021/acsami.4c13590` | 成功，1,003,225 字节 | 4 | `acs-browser-j7ygpY` |
| RSC | `10.1039/c4cp05552g` | 认证域名 id.rsc.org 解析失败；EAI_AGAIN / ESERVFAIL | 2 | `rsc-browser-1xrlXt` |
| Wiley | `10.1002/advs.202200547` | 成功，2,920,402 字节 | 6 | `wiley-browser-B1kIKU` |
| Elsevier 订阅 | `10.1016/0003-2670(70)80042-3` | 抵达吉林大学用户名/密码登录页时达到文章预算 | 11 | `elsevier-browser-9fHyVo` |
| Elsevier OA | `10.1016/j.apsadv.2021.100072` | 成功，2,501,466 字节 | 3 | `elsevier-oa-browser-jvVpVu` |
| AIP | `10.1063/5.0341530` | 成功，9,773,670 字节 | 5 | `aip-browser-p93khp` |
| IOP | `10.1088/1742-6596/2977/1/012017` | 成功，5,341,907 字节 | 3 | `iop-browser-ocgK0L` |
| Oxford | `10.1093/ced/llae535` | 成功，937,249 字节 | 5 | `oxford-browser-TNFWar` |
| Science / AAAS | `10.1126/sciadv.ads8033` | 成功，1,169,741 字节 | 7 | `science-browser-kLKoq2` |
| PLOS | `10.1371/journal.pmed.0020124` | 成功，255,629 字节 | 2 | `plos-browser-IT6Qch` |
| APS | `10.1103/PhysRevLett.116.061102` | 成功，862,757 字节 | 4 | `aps-browser-EcX3LP` |
| ACM | `10.1145/3065386` | 成功，2,570,670 字节 | 5 | `acm-browser-gOmm2A` |
| IEEE | `10.1109/5.726791` | 成功，930,388 字节 | 5 | `ieee-browser-gsuzdz` |
| Annual Reviews | `10.1146/annurev-statistics-042720-125902` | 成功，626,603 字节 | 4 | `annual-reviews-browser-2maWbu` |
| AMS | `10.1090/proc/14032` | 成功，200,948 字节 | 3 | `ams-browser-PTR6sD` |
| Copernicus | `10.5194/gmd-16-4937-2023` | 成功，7,667,870 字节 | 1 | `copernicus-browser-0VgZc9` |
| Frontiers | `10.3389/fnins.2019.00425` | 成功，9,134,381 字节 | 1 | `frontiers-browser-mAf4Hs` |
| MDPI | `10.3390/s19092045` | 成功，4,607,534 字节 | 3 | `mdpi-browser-IB9zgB` |
| PNAS | `10.1073/pnas.1118373109` | 成功，1,093,003 字节 | 5 | `pnas-browser-e9FCi1` |
| Royal Society | `10.1098/rspa.2012.0459` | 成功，474,832 字节 | 4 | `royal-society-browser-myoO9P` |
| World Scientific | `10.1142/S0219024910006066` | 文章要求登录或购买；当前会话未取得全文 | 5 | `world-scientific-browser-xcCs2g` |

## 根因与剩余边界

- **RSC**：最后一次正常点击验证控件后，认证链依次经过 `pubs.rsc.org`、`sso.rsc.org`，在
  `id.rsc.org` 处出现 `ERR_EMPTY_RESPONSE`。进一步独立检查系统 resolver 得到 `EAI_AGAIN`，
  DNS A/AAAA 查询均为 `ESERVFAIL`，证据为 `rsc-dns-diagnostic.json`。本轮原因是当前环境无法
  解析认证域名；不能把它沿用解释成此前的 429，也不能宣称是版权拒绝。429 条件重试另由离线
  合成服务直接验证，没有靠触发真实限流反复测试。
- **IEEE（最终已成功）**：HTTP/IPv6 修复后仍曾返回 HTTP 202 空白页。补抓全部子资源发现
  AWS WAF 的 `challenge.js`、`inputs` 都返回 200，而页面 `mp_verify` multipart 提交被本地
  Host 的 Content-Type 规则拦截（`ERR_BLOCKED_BY_CLIENT.Inspector`）。通用表单准入修复后，
  正常进入文章/PDF 流程，5 次模型调用，930,388 字节/47 页正式入库。早期观察中的
  “JavaScript is disabled”来自 noscript 文案，不能据此断言浏览器关闭了 JavaScript。
- **World Scientific**：已通过验证并进入文章；显示 fulltext 需 sign in/purchase，包含机构登录
  和购买选项。当前隔离 Profile/IP 未直接取得全文，模型停止；未输入凭据、支付或改变机构身份。
- **Elsevier 订阅样本**：临时 `key` 跳转已通过，修复后曾进入文章及 `Access through your organization`
  页面。最后复测通过当前机构访问按钮到达吉林大学 `Web登录服务`，页面明确要求校内邮箱用户名
  和密码，此时达到 120 秒文章预算，返回 `browser-flow-budget-exhausted`。当前隔离 Profile 没有
  该登录会话，不能把它解释成仍被本地 `key` 规则阻止；没有输入凭据。Elsevier OA 样本已入库。

Copernicus 原先失败的点击落在 PDF 链接旁边的文件大小文字，随后又误点无名称的许可图标。
通用控件命名与点击反馈修复后，一次模型调用点击真实 PDF 控件，下载 7,667,870 字节/20 页并入库；
没有为该站写特定坐标、selector 或 URL 请求。

修复期间另发现工具字段的 `0–16384` 安全上限说明诱导模型按该范围缩放截图坐标，导致中间几次
RSC/Elsevier/Copernicus 复测无效。这一说明已删除，坐标语义回到当前 viewport 的 CSS 像素，
增加越界反馈并复测。中间失败日志保留，不计成成功或出版商拒绝。

## 工程验收与证据

- `pnpm full` 最终通过：Quick（格式、lint、源码/测试 strict 类型检查）、167 个通过测试文件中的
  1,020 项测试，以及构建全部通过；另有 5 文件/12 项按配置跳过。
  日志：`full-multipart.log`。
- 设置已验证 Cloak bundle，串行运行 `browser-production-loopback.test.ts` 与
  `production-workbench-loopback.test.ts`：2 文件/5 项全部通过。覆盖 native download、viewer、
  编码路径/临时 token query 的跨域下载与正式入库，以及工作台真实人工接管。
  日志：`cloak-multipart.log`。
- 直接回归覆盖两种 IP 地址族回退、空闲 CONNECT 不占请求队列、活动流量不被固定连接寿命切断、
  multipart 页面表单、延迟脚本/字体与可见文字、窗口暂态、popup 返回、严格模型动作、越界反馈、
  202 停止分类、429 条件重试，以及已接纳候选不被 viewer 故障掩盖。
- `git diff --check` 与新增 ADR/报告相对链接检查通过。没有修改依赖或 `pnpm-lock.yaml`。

本轮现场共保留 45 次尝试，按每篇最后结果汇总于 `latest-results.json`；历史尝试未覆盖。
失败样本复测、坐标说明修复和完整资源诊断都包含在这 45 次中。

现场证据根目录：`/tmp/sciretriever-browser-generic-20261004/`。`results.jsonl` 保留所有尝试；每个
案例目录有 `result.json`、`events.jsonl`、模型 observation、截图和成功导出的 `accepted.pdf`。
其中没有把 token/query 参数值写入导航日志。真实文件不进入合成 Harness。

早期 Full 曾有一次与 Browser 无关的 database-completion-chunks 5 秒超时；该文件独立复测 18 项
通过，随后完整 Full 重新执行，不修改或放宽该测试的 timeout。Cloak 测试还暴露并修复了窗口
暂为零时工作台提前报错的问题；最终按相同测试入口重新验收。

未测试 API/Public/Sci-Hub 的新行为，也未使用真实用户 catalog、原 Profile Cookie 或解析后的
文章身份验证。本次没有 Git commit、push、PR 或依赖锁文件修改；工作区既有改动保留。
