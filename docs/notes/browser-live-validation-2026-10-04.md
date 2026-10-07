# PDF 获取真实验证：2026-10-04

## 验收目标与方法

本次按 [ADR 0023](../architecture/decisions/0023-generic-browser-agent-executor.md) 验证：
给定文献元数据，优先用公开路径和已配置的 API 获取 PDF，剩余目标由同一 Browser Agent
利用当前机器 IP 可获得的权限，以观察、点击、等待的通用流程尝试下载。
不为出版社增加 selector、点击脚本或下载 URL 猜测规则。

成功必须同时满足实际取得 PDF、Acquisition/Intake 验收、提交 `primary-pdf`、导出文件并核对
catalog 中的 SHA-256。页面可打开、模型点击 PDF、HTTP 200 或 PDF response 均不单独算成功。

本次分开记录两个实验：

1. **自动全链路**：真实 Crossref lookup → 身份接纳 → 正式 `databaseCompletion.run(ASSET_READY)`
   → 自动 Public/API/Browser 选择 → Library → 导出/hash 核对。采用与用户当前一致的 acquisition
   `auto` 模式；此模式自动选择 arXiv、Europe PMC 及必需的 direct/DOI landing 路线，
   不会仅因已有凭据就启用 Wiley/Elsevier API。
2. **独立 Browser 诊断**：对同一文章单独调用生产 Browser delivery → 正常 acceptance receipt
   → Library → 导出/hash 核对，用于分辨“没有进入 Browser”和“Browser 自身失败”。
   该实验通过不能当作自动全链路通过。

模型固定为 `qiuzk/gpt-6-luna`，实际使用已有 Configuration/Credential owner 加载的模型和
AgentRuntime。隔离 Application 中的模型占位注册只满足 readiness，模型调用完整转发给真实
配置的运行时；没有预制动作或自动修正模型输出。Browser 使用经过验证的 CloakBrowser
`146.0.7680.177.5`。每个案例有独立临时 catalog、资产目录和 Browser profile，使用本机 IP，
没有复制用户 Cookie，也没有使用用户的真实 catalog。

这验证了生产模块间的真实调用链，不包含 Workbench UI 自动操作，也不等同于用户已有登录
Profile 的复用验收。每个出版社的一篇样本只能证明该文章在本次网络和时间窗口下的结果。

## 证据与复现

本次证据根目录：`/tmp/sciretriever-live-matrix-20261004/`。
运行器为 `run.mjs`，额外公开/API 路径为 `other-routes.mjs`，原始结果为 `results.jsonl`。
每个案例保留 `result.json`、脱敏 `events.jsonl`、模型动作、每轮 observation/screenshot；
对捕获失败的专项复核另观察传输与 Intake，并在临时目录保留原本会被丢弃的候选字节用于核查，
不改变正式接纳或拒绝结果；
成功案例另有 `accepted.pdf` 及隔离 catalog。PDF、catalog、个人配置与凭据均不进入仓库。
临时证据目录不是长期归档，下面记录的结论不依赖把真实文献提交到 Git。

示例命令（需要本次临时运行器、当前已构建源码、已安装 Browser 和现有模型配置）：

```bash
node /tmp/sciretriever-live-matrix-20261004/run.mjs full nature
node /tmp/sciretriever-live-matrix-20261004/run.mjs browser nature
```

诊断只观察页面、动作、HTTP 状态、隧道时间及捕获事件，不改变请求/点击逻辑。
URL query 值、Cookie、Token、请求头不写入报告；记录参数名用于解释 URL 准入失败。

初始 Browser 进程曾加载修复前的 Crossref lookup；其 metadata lookup 失败后，运行器通过同一
Network 边界取得真实 Crossref 响应，再用生产 converter 解析，结果中明确记录了这一差别。
修复后的自动全链路全部使用新的正式 lookup。Wiley、AMS、Copernicus、World Scientific
先前样本的 Crossref 404 不计为出版社下载失败，后续使用真实 Crossref 查询确认的替代文章。

## 出版社结果

表格采用同一样本的最后一次可复核结果；复测前后的差别单独注明，所有历史尝试仍保留在
`results.jsonl`。首轮自动全链路为 3/23，Copernicus 的诊断复测成功后为 4/23。
这不是成功率抽样研究，也没有通过更换失败文章来提高通过数。

| 出版社 / DOI                                                 | 自动全链路        | 独立 Browser                    | 本次失败位置与原因                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ----------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nature<br>`10.1038/nature14539`                              | 失败              | 成功，2,964,524 B；4 次模型调用 | 自动路径：HTTP PDF hint 被 HTTPS-only transport 抛 TypeError，未进入 Browser。独立 Browser 成功。                                                                                                                         |
| SpringerLink<br>`10.1007/s12055-024-01728-3`                 | 成功，1,386,174 B | 成功，1,386,174 B；4 次模型调用 | 两条实验路径均成功；自动路径直接取得 PDF，不调用模型。                                                                                                                                                                    |
| ACS<br>`10.1021/acsami.4c13590`                              | 失败              | 失败；1 次模型调用              | 自动路径 403，未升级 Browser；独立 Browser 的 Cloudflare 页上模型首次调用即 Stop/cancel，随后空候选等待被报告成 timeout。                                                                                                 |
| RSC<br>`10.1039/c4cp05552g`                                  | 失败              | 失败；9 次模型调用              | 自动路径 403，未升级 Browser；独立 Browser 已过 challenge 并点击 PDF，但 SilentOIDCLogin 返回 429，后续操作未获 PDF，外层截止取消。                                                                                       |
| Wiley<br>`10.1002/advs.202200547`                            | 失败              | 成功，2,920,403 B；6 次模型调用 | 自动路径 403，未升级 Browser；同一篇文章独立 Browser 成功。旧 DOI 的 Crossref 404 已排除，不计为下载失败。                                                                                                                |
| Elsevier（订阅样本）<br>`10.1016/0003-2670(70)80042-3`       | 失败              | 失败；0 次模型调用              | 自动路径与独立 Browser 均在 LinkingHub 跳转失败：query 参数 key 被本地 Network 策略拒绝；0 次模型调用。                                                                                                                   |
| Elsevier（OA 样本）<br>`10.1016/j.apsadv.2021.100072`        | 失败              | 失败；0 次模型调用              | 与订阅样本相同，LinkingHub 的 key 参数被本地拒绝。OA 属性不能绕过这一公共导航错误。                                                                                                                                       |
| AIP<br>`10.1063/5.0341530`                                   | 失败              | 失败；1 次模型调用              | 自动路径 403；Browser 首次已点击 PDF，但 PDF 请求 ERR_EMPTY_RESPONSE 后 snapshot 超时；复测模型 Stop 携带非空 revision，被动作 parser 拒绝。                                                                              |
| IOP<br>`10.1088/1742-6596/2977/1/012017`                     | 失败              | 失败；0 次模型调用              | 自动 HTTP 路径转到 PerfDrive，未交付 PDF且未升级；Browser 本次文章响应 200，但 openPage 等待 DOMContentLoaded 超时，0 次模型调用，不能把该 Browser 失败写成已进入 PerfDrive。                                             |
| Oxford Academic<br>`10.1093/ced/llae535`                     | 失败              | 失败；3 次模型调用              | 自动路径 403；Browser 已通过 challenge 并点击 PDF，PDF 请求曾连接关闭，最终 watermark 下载地址的 token 参数被本地 Network 拒绝。                                                                                          |
| Science / AAAS<br>`10.1126/sciadv.ads8033`                   | 失败              | 失败；7 次模型调用              | 自动路径 403。Browser 复测：viewer response.body 无法读取、206 被拒绝；随后原生下载已取得 1,169,747 B / 10 页 PDF，但 Intake 只查第一页 DOI，判 uncertain 并丢弃。全文目标 DOI/标题均匹配；最终候选 timeout，不是无权限。 |
| PLOS<br>`10.1371/journal.pmed.0020124`                       | 成功，255,629 B   | 失败；0 次模型调用              | 自动路径成功；强制独立 Browser 的入口等待 DOMContentLoaded 超时，0 次模型调用。公开直下成功不能算 Browser 成功。                                                                                                          |
| APS<br>`10.1103/PhysRevLett.116.061102`                      | 失败              | 失败；2 次模型调用              | 自动路径已返回文章 HTML 200，但未交付可接纳 PDF且未升级；Browser 通过验证后，截图等待字体超过 5 秒，snapshot 失败。                                                                                                       |
| ACM<br>`10.1145/3065386`                                     | 失败              | 失败；5 次模型调用              | 自动路径 403。Browser 已原生下载 2,570,670 B / 7 页 PDF；第一页 DOI 被排版抽取为 10.1145/ 30 6 5 3 8 6，当前正则未归一化，Intake 判 uncertain 丢弃。标题/三位作者匹配；不是没有点击下载。                                 |
| IEEE<br>`10.1109/5.726791`                                   | 失败              | 失败；0 次模型调用              | 自动路径因 HTTP DOI landing 被 Network 拒绝；Browser 导航到 HTTP 文章地址时代理返回 502，0 次模型调用。                                                                                                                   |
| Annual Reviews<br>`10.1146/annurev-statistics-042720-125902` | 失败              | 失败；6 次模型调用              | 自动路径 403。Browser 已原生下载 626,235 B / 23 页 PDF；PDF 中 DOI 在连字符处换行，pdftotext 把行末连字符删掉，抽取值少一个 -，Intake 判 uncertain 并丢弃。已渲染第一页核对实际 DOI。                                     |
| AMS<br>`10.1090/proc/14032`                                  | 失败              | 失败；0 次模型调用              | 自动路径文章 HTML 200，后续候选未交付可接纳 PDF且未升级；Browser 的 openPage 等待 DOMContentLoaded 超时，0 次模型调用。                                                                                                   |
| Copernicus<br>`10.5194/gmd-16-4937-2023`                     | 成功，7,667,870 B | 失败；0 次模型调用              | 自动路径复测成功（7,667,870 B），首次交付失败仍保留；独立 Browser 入口等待 DOMContentLoaded 超时，必要 CDN 隧道排队，0 次模型调用。                                                                                       |
| Frontiers<br>`10.3389/fnins.2019.00425`                      | 成功，9,134,381 B | 成功，9,134,381 B；6 次模型调用 | 自动公开路径和独立 Browser 均成功，交付相同 hash 的 9,134,381 B PDF。                                                                                                                                                     |
| MDPI<br>`10.3390/s19092045`                                  | 失败              | 成功，4,607,534 B；3 次模型调用 | 自动路径 403，未升级 Browser；独立 Browser 成功（4,607,534 B），通过网站下载接口交付，未添加 MDPI 专用点击程序。                                                                                                          |
| PNAS<br>`10.1073/pnas.1118373109`                            | 失败              | 成功，1,092,997 B；5 次模型调用 | 自动路径 403，未升级 Browser。独立 Browser 首次未交付，复测成功：viewer 的 response.body 报 No data found，之后原生下载取得 1,092,997 B，正式入库/hash 通过。复测成功不抹去首次失败。                                     |
| Royal Society<br>`10.1098/rspa.2012.0459`                    | 失败              | 失败；1 次模型调用              | 自动 PDF 路径 403，另一路 DOI landing 被 Network 拒绝；Browser 的 challenge 页上模型首次即 Stop/cancel，最终被报告成候选 timeout。                                                                                        |
| World Scientific<br>`10.1142/S0219024910006066`              | 失败              | 失败；1 次模型调用              | 自动路径 403，未升级 Browser；Browser 的 challenge 页上模型首次即 Stop/cancel，最终被报告成候选 timeout。                                                                                                                 |

案例证据索引（目录位于上述临时证据根目录）：

| 出版社               | 自动全链路目录                 | 独立 Browser 目录                 |
| -------------------- | ------------------------------ | --------------------------------- |
| Nature               | `nature-full-eJn3OR`           | `nature-browser-1Gdfp2`           |
| SpringerLink         | `springer-full-CxKhgn`         | `springer-browser-9kZ5Xd`         |
| ACS                  | `acs-full-kxzSR8`              | `acs-browser-LvmOuC`              |
| RSC                  | `rsc-full-XEHevi`              | `rsc-browser-nhLsVN`              |
| Wiley                | `wiley-full-SoyeLE`            | `wiley-browser-1GmB6x`            |
| Elsevier（订阅样本） | `elsevier-full-oGt9sk`         | `elsevier-browser-kHkaxO`         |
| Elsevier（OA 样本）  | `elsevier-oa-full-aLan9I`      | `elsevier-oa-browser-xMUvrp`      |
| AIP                  | `aip-full-UqKG36`              | `aip-browser-WJmPU6`              |
| IOP                  | `iop-full-QRZ5Qz`              | `iop-browser-k7CYsD`              |
| Oxford Academic      | `oxford-full-BcJtLK`           | `oxford-browser-BD5uZo`           |
| Science / AAAS       | `science-full-fwP8r1`          | `science-browser-xttz0G`          |
| PLOS                 | `plos-full-HETJO0`             | `plos-browser-7t61U9`             |
| APS                  | `aps-full-wUJane`              | `aps-browser-aUbbjW`              |
| ACM                  | `acm-full-OuQWpz`              | `acm-browser-cIyHDj`              |
| IEEE                 | `ieee-full-M69gYO`             | `ieee-browser-EYDS9q`             |
| Annual Reviews       | `annual-reviews-full-BOQ7b5`   | `annual-reviews-browser-8eqCpU`   |
| AMS                  | `ams-full-MfOt5H`              | `ams-browser-kwoLvr`              |
| Copernicus           | `copernicus-full-aNypeo`       | `copernicus-browser-k9U7dt`       |
| Frontiers            | `frontiers-full-vNHz8O`        | `frontiers-browser-r3GI58`        |
| MDPI                 | `mdpi-full-JW4HBd`             | `mdpi-browser-gIM52H`             |
| PNAS                 | `pnas-full-S903Fr`             | `pnas-browser-xfr1l7`             |
| Royal Society        | `royal-society-full-hTo8QW`    | `royal-society-browser-TRZ9TG`    |
| World Scientific     | `world-scientific-full-eKF02H` | `world-scientific-browser-umIUqo` |

成功文件 SHA-256（不同实验交付相同 hash 时仅列一次）：

| 出版社 / 路径          | 字节数    | SHA-256                                                            |
| ---------------------- | --------- | ------------------------------------------------------------------ |
| nature / browser       | 2,964,524 | `f17b7ad8a7a638da6df4a20515077097ce50156892f17a125072533fd14bf835` |
| springer / browser     | 1,386,174 | `87ddb1dfadb00df1072274a2dc80c9ece51a0f986b85ce4eb327dfe245f676d1` |
| plos / full            | 255,629   | `ffc1005680cb620eec4c913437dfabbf311b535cfe16cbaeb2faec1f92afc362` |
| frontiers / full       | 9,134,381 | `d663d37b7ff3cd3b1c6e54ff024cb16b914cbdf97f58ab65ab85ac2ea92285bb` |
| arxiv / isolated-route | 2,215,244 | `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697` |
| wiley / browser        | 2,920,403 | `ad66174cf96061ca44f7e85dd8876de96f8ac31c9416f6d98d54ceeec98556f4` |
| mdpi / browser         | 4,607,534 | `ee6117a8e59ed0bd2459f69dacc43f2eb8195a88cae7b0a0a96ba55b0e472bca` |
| copernicus / full      | 7,667,870 | `61709fbbe8f653af62b26957e259ec850cf1a5665a40bb83ea9cfef03c67fadc` |
| pnas / browser         | 1,092,997 | `19893282fa46d28410b2db524fb6adfd8d778c68aeccf32bb6d7ba3aa6af42c4` |

## 其他 PDF 路径

| 路径                                  | 真实结果                              | 已定位原因 / 范围                                                                                                                                                                     | 证据目录                  |
| ------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| arXiv `1706.03762`                    | 成功，2,215,244 B，正式入库/hash 通过 | 直接 URL，无 Browser、无模型调用                                                                                                                                                      | `arxiv-route-xgYDK8`      |
| Europe PMC `PMC1182327`               | 失败                                  | `europepmc.org/articles/PMC1182327?pdf=render` 返回 403 HTML                                                                                                                          | `europe-pmc-route-V7pdQF` |
| Elsevier 已配置 API                   | 失败                                  | `/content/article/doi` 请求返回 400 XML：`INVALID_INPUT / No resource identifier provided`。当前代码把 DOI 放入 query，服务端未识别到文章标识；上层又将该原因压缩成 `response-schema` | `elsevier-route-RSxeOr`   |
| Wiley 已配置 TDM API                  | 失败，未发出 HTTP 请求                | `/articles/10.1002%2Fadvs.202200547` 在 Network 准入处触发 `network-policy`，属于编码路径与网络合同冲突                                                                               | `wiley-route-ezSDxK`      |
| Sci-Hub 镜像（使用上述 PLOS OA 文章） | 失败                                  | `sci-hub.ru` 返回 200 并解析出 PDF；文件所在 `sci-hub.red` 返回 504；第二镜像 `sci-hub.kr` 返回 HTML 200，但没有交付可接纳 PDF                                                        | `sci-hub-route-EGL2dv`    |
| CORE                                  | 未进行真实下载                        | 当前没有配置 API 凭据，不能算通过                                                                                                                                                     | `other-readiness.json`    |
| Unpaywall                             | 未进行真实下载                        | 当前没有配置 contact，不能算通过                                                                                                                                                      | `other-readiness.json`    |

API 验证通过已有 Configuration/Credential owner 在运行时授权，报告只记录凭据是否可用，
不保存凭据值。为测试被 auto 模式跳过的具体路线，API/镜像实验显式选择单一 production Source，
仍经过正式候选交付、acceptance、Library 和导出核对；它们不计入自动全链路成功数。

## 已证实的公共问题

1. **低成本路径失败不一定进入 Browser。**
   `entry/pdf-acquisition.ts` 只允许正常耗尽或明确声明的低风险不可用升级。
   常见候选下载失败变成 `pdf-route-delivery-failed`，整个目标停在模型调用之前。
   这保留了 ADR 0015 的旧升级约束，却使 ADR 0023 新增的“未解决目标进入 Browser”目标
   在常见真实场景下落空。需要细分低层失败的可升级语义，同时保留取消、存储故障和限流的含义。
2. **候选 URL 合同不一致。**
   Nature 元数据中的 HTTP PDF hint 可以成为候选，但 Public transport 要求 HTTPS，
   创建 transport 时抛出 TypeError，最终成为 `pdf-acquisition-contract`，没有尝试 Browser。
   Wiley API 把 DOI 的斜杠编码为 `%2F`，却被 Network 路径准入拒绝，请求没有发到服务端。
3. **浏览器导航复用了不适合临时页面交接的 URL 限制。**
   Elsevier 普通 LinkingHub 跳转含 `key`，Oxford PDF 临时下载地址含 `token`，均被敏感 query
   策略拒绝。网络请求的短期准入和 URL 的日志/持久化应分开定义；不能通过记录或放行所有
   任意 URL 来解决，也不应逐出版社添加例外。IEEE 的 HTTP 入口则与 HTTPS-only 网络策略冲突。
4. **页面就绪和代理资源生命周期过严。**
   `host.openPage` 等待 `domcontentloaded`，30 秒超时就关闭页面，模型没有观察已部分显示页面
   的机会。截图/viewport 等待失败也会结束流程。Browser proxy 只有 4 个并发 permit，permit
   却由整个 CONNECT 隧道占有，并有从创建起算的 30 秒硬超时。IOP 日志显示 DOI、正文、广告等
   隧道占用 permit，必要静态资源排队且发送字节数为零。这支持资源饥饿机制，但本轮未做改变
   隧道策略后的对照实验，不能把它当作所有页面超时的唯一原因。
5. **模型 wire schema 与动作语义仍有缺口。**
   严格 Provider schema 要求声明的字段全部在 `required` 中，未用字段为 null。
   修复前只有 `kind` 必填会被真实 Provider 以 HTTP 400 拒绝。
   恢复 required 后调用成功，但 flat nullable schema 仍允许 `Stop` 携带非空 `revision`；
   本次 AIP 就因此被严格动作 parser 拒绝。此前 ACS 的额外 `viewport_version` 也是同类问题，
   不能解释为“模型省略 null 字段”。需要在 schema/动作转换边界统一合同。
6. **捕获状态、停止和 deadline 没有形成一致闭环。**
   当前设计将 action 后的 PDF 累积到 capture batch，同时 observation 对模型仍显示 `NONE`，
   prompt 却要求捕获后停止。成功的 Nature、Springer、Wiley 仍反复点击直到预算退出。
   正式 flow 在 controller 停止后统一再等 30 秒候选，空 batch 没有表达“已终止且无候选”，
   因此 ACS 的主动 Stop 最终显示成 candidate-timeout。模型调用/动作等待也可能越过剩余
   controller budget，最终被外层取消。Science 复测同时记录 viewer `response.body()` 的 CDP
   `No data found for resource with given identifier` 异常，以及后续原生文件被 Intake 误拒绝；
   完整传输、归属验收、capture batch 与外层取消必须分别报告，不能仅根据 HTTP 200 宣称成功。

7. **Browser Intake 的身份证据不足，完整正确 PDF 也会被丢弃。**
   Science 复测实际下载了 1,169,747 B、10 页的原生 PDF。`BrowserCandidateIntake` 调用
   `assessPdfIdentity`，后者通过 `readPdfTool` 仅提取第一页文字。第一页不含目标 DOI，返回
   `uncertain`；Bootstrap 随即 abandon 候选，最后外层显示 candidate-timeout。
   保留的文件全文包含目标 DOI，规范化文本也匹配目标标题。这是已复现的误拒绝，不能归因于
   出版社无权限。元数据已传给 Agent，但 Intake 的 target 仍只有 identifier/version，尚未
   实现 ADR 0023 的通用 DOI/标题/作者与受控捕获关联证据验收。
   证据：`science-browser-xttz0G/events.jsonl` 的 `intake-assessment`、同目录
   `captured-2fd9f717eea6a56957cc377dff7ceeab1116f2cf39f4530163d1978193380ece.pdf`。

   ACM 复测同样已经原生下载 2,570,670 B、7 页 PDF。第一页存在 DOI，但文本抽取结果为
   `DOI:10.1145/ 30 6 5 3 8 6`，正则没有处理排版空白，仍判 `uncertain`。规范化标题和三位
   作者均匹配目标。证据为 `acm-browser-cIyHDj/identity-diagnostic.json` 和同目录捕获文件。

   Annual Reviews 复测原生下载 626,235 B、23 页 PDF。第一页视觉上写有正确 DOI，
   `042720-` 与 `125902` 分两行；`pdftotext` 默认去掉行末连字符，产生
   `10.1146/annurev-statistics-042720125902`，与目标相比少一个 `-`，Intake 再次判 `uncertain`。
   `annual-reviews-browser-8eqCpU/first-page.png`、`identity-diagnostic.json` 和捕获 PDF
   共同证实了这一排版/提取问题，不是出版社拒绝文件传输。

这些问题集中在公共合同和生命周期，不能用增加各出版社的点击规则解决。当前 ADR 的 capture
隐藏语义与 prompt 也需要一并校正，不能只将所有问题归因于页面变化或 Cloudflare。

## 本轮修复与工程验证

为使真实测试能继续，本轮修复两个公共阻塞：

- 恢复 Browser strict tool schema 所有字段必填、未使用字段为 null，消除 Provider HTTP 400。
- Crossref lookup 对 DOI 各路径段编码，保留 `/`，避免生产 Network 在发请求前拒绝 `%2F`。
  在已有真实 TLS loopback 对象图测试中加入带多级斜杠 DOI 的 lookup 验证。

没有修改依赖、数据库 schema、用户配置或凭据，没有添加出版社页面规则。本轮未把上述全部
结构问题修复；真实失败仍保留为失败。工作树已有的其他 Browser/Acquisition 修改来自此前工作，
不能把整个 diff 都归为本轮新增。

| 验证                                                    | 结果                                                           | 证据文件               |
| ------------------------------------------------------- | -------------------------------------------------------------- | ---------------------- |
| 直接回归：Browser decision、Crossref、metadata assembly | 3 文件、23 测试通过                                            | `regression-tests.log` |
| 标准 `pnpm full`（含 Quick、全部标准 Vitest、构建）     | 166 文件通过、5 跳过；1000 测试通过、12 跳过；构建通过         | `full-standard.log`    |
| 启用 Cloak 的并行 Full                                  | 8 测试失败、1004 通过；出现 timeout/null observation，不算通过 | `full-cloak.log`       |
| 对 opt-in Browser/工作台/MinerU loopback 测试串行重跑   | 8 文件、15 测试全部通过                                        | `cloak-serial.log`     |

串行通过不抹去并行运行失败，也不能替代真实出版社验收。标准 Full 通过说明已有离线质量门禁
通过，不能推出“所有出版社 PDF 下载已经完成”。

## 验收判断

**当前实现尚未达到可靠、通用的 PDF 兜底获取目标，本轮出版社矩阵验收不通过。**

本轮覆盖 22 家出版社、23 个文章样本。自动全链路成功 4/23，独立 Browser 诊断成功 6/23。
自动成功的 4 篇均由公开路径交付；本轮自动 Browser 兜底没有成功样本。另有 Science、ACM、
Annual Reviews 3 篇已由 Browser 下载完整文件，但未通过当前身份验收，不能计为正式成功。
这些比例仅描述本轮样本，不是全出版社成功率统计。独立 Browser 证明同一套 Agent/执行器确实
能完成不同站点的下载与正式入库；它不能补算自动全链路失败。

下一步应优先修正已下载 PDF 的身份误拒绝，并统一低层失败升级、浏览器临时导航准入、
页面/隧道生命周期、动作 schema 与捕获/停止合同，再用相同样本验证。不应继续新增逐出版社点击脚本，也不能把增加等待时间
当作这些公共问题的完整修复。

## 后续修订：取消下载阶段文章身份门

Owner 随后确认了 [ADR 0029](../architecture/decisions/0029-unverified-pdf-acquisition.md)：
有效 PDF 正常入库，文章身份标记为未验证；检验留待解析阶段，不能阻断下载。
上面的出版社矩阵保留为修改前的真实记录，不因本次修改而改写其历史结果。

本次使用上轮已经捕获、被旧身份门拒绝的原始 PDF，重放生产
`BrowserCandidateIntake → CandidateAcceptanceService → publication → Library`，
并关闭、重开隔离 Application，导出文件核对原 hash。此验证不重新访问出版社或调用模型，
证明的是实际文件在新的验收/发布链路中的结果，不是新一轮 Browser 网站成功率。

| 文章                                                      | 字节数    | 页数 | 发布、重启读取与 hash | 文章身份标签 |
| --------------------------------------------------------- | --------- | ---- | --------------------- | ------------ |
| Science `10.1126/sciadv.ads8033`                          | 1,169,747 | 10   | 通过，`ASSET_READY`   | `unverified` |
| ACM `10.1145/3065386`                                     | 2,570,670 | 7    | 通过，`ASSET_READY`   | `unverified` |
| Annual Reviews `10.1146/annurev-statistics-042720-125902` | 626,235   | 23   | 通过，`ASSET_READY`   | `unverified` |

新回执的 `identity` 明确持久化为 `unverified`；详情的 `article_identity_status` 为 `unverified`。
现阶段尚未实现解析阶段的身份检验，因此解析完成也保持该标签，不自动宣称内容已核验。
无需迁移用户 catalog 或改写既有文件。旧 accepted 回执可按原内容重放，旧详情缺少标签时保守
投影为未验证。下载不再依赖 `pdftotext`，PDF reader、任务绑定、CAS、取消、大小/hash 和不可变发布约束保留。

证据：`/tmp/sciretriever-unverified-pdf-20261004/real-pdf-replay-results.json`，
复验脚本 `replay-real-pdfs.mjs` 与隔离发布目录均在同一临时目录。合成 Harness 没有读取这些真实文件。

本次修订的工程验收：相关测试首批 103 项通过；更新旧身份门断言后，正式 `pnpm full` 的 Quick、
166 个通过文件中的 1003 项测试及构建全部通过，另有 5 文件 / 12 项按配置跳过。
设置已验证 Cloak bundle 后串行运行 `browser-production-loopback` 与 `production-workbench-loopback`，
2 文件 / 5 项全部通过，包含无可提取文字 PDF 的 CDN 下载、正式补全入库和工作台人工控制链路。
已安装包的生产用户旅程还验证未验证 PDF 可以进入解析，解析完成后标签仍为 unverified。
日志分别位于本次证据目录的 `full-final.log`、`cloak-loopback.log`。


通用运行时、网络与跨出版社修复的后续实测，见 [2026-10-05 验证报告](browser-generic-repair-validation-2026-10-05.md)。本文件原矩阵保留为修复前历史证据。
