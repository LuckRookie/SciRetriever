# PDF 下载真实测试与当前问题汇总

2026-10-10（北京时间）在[主题发现与种子扩展测试](topic-seed-live-validation-2026-10-10.md)之后，继续按用户要求测试正式 PDF 下载。源码基线仍为 `b30af24eee78933bc0775cd3ac6b5d0b2ee15439`，本轮没有修改产品实现。

**主样本 9 篇，默认启动成功 2 篇；显式提供已有的已验证 Cloak runtime 后，再成功 4 篇，最终 6/9 正式入库。另测 arXiv 直链成功，Sci-Hub 获取同一篇 ACS 综述也成功。** 所有正式发布的 8 份 PDF 均通过重开读取、字节数、SHA-256 和 `pdfinfo` 检查，涵盖 7 篇不同文献；不能将同一 ACS 文章的两条成功路线算成两篇文献。

Browser 的真实操作链路在本轮有成功证据。当前主要缺口集中于启动配置、元数据与下载路线的衔接，以及授权 API 的协议实现；RSC 限流和 Springer 登录页面另行保留为访问结果，不推断为机构没有版权。

## 执行方式与边界

- 主样本来自刚完成的真实主题发现，覆盖 Beilstein、Nature、MDPI、ACS、Wiley、RSC、Elsevier、Springer 书籍章节和 ChemRxiv。人工选择不同站点与文献类型，不能据此估计总体成功率。
- 正式 `createApplication` → `DatabaseCompletionService.run(ASSET_READY)` → Public/API/Browser → Candidate 文件验收 → 不可变发布 → Library 读取/导出。
- Configuration owner 在内存中将 catalog、artifact root 指向上一轮隔离测试目录；不读写原有用户 catalog，不修改个人配置。凭据继续由正式 owner 按请求授权，没有打印、复制或修改凭据。
- 主测试沿用当前 Auto 来源集合；实际为 direct、arXiv、Europe PMC、DOI landing 和 Browser。Elsevier/Wiley 虽有凭据，本次默认 Auto 没有选中这两个 API；Sci-Hub 默认也未选中。后续在独立临时 catalog 中显式启用来源测试，没有修改用户的长期来源选择。
- 默认进程没有 `SCIRETRIEVER_CLOAK_BUNDLE`，因此 Browser runtime 不可用。第二轮通过已有公开组装参数传入验证成功的 Cloak `146.0.7680.177.5`，没有改写 readiness 或绕过 bundle 校验。
- Browser 使用实际 `qiuzk/gpt-6-luna`、生产 Host、当前机器出口及应用管理的 Browser profile。没有人工代点、脚本预设模型答案或按出版社增加点击规则；没有复制其他浏览器的 Cookie。Browser 内部仍使用项目 Network 管理的 CONNECT 通道。
- 所有真实测试与离线 Vitest 分开运行。未调用解析或分析，也没有执行 Git 提交。

## 主样本结果

| 出版社 / 平台 | DOI | 默认启动 | 提供 runtime 后的最终结果 |
| --- | --- | --- | --- |
| Beilstein | `10.3762/bjoc.21.200` | 成功，DOI landing 普通 HTTP 获取 | 20 页，1,833,649 字节；未启动 Browser |
| Nature Communications | `10.1038/s41467-026-72420-w` | 成功，DOI landing 普通 HTTP 获取 | 12 页，2,499,297 字节；未启动 Browser |
| MDPI | `10.3390/molecules24112122` | Browser runtime 不可用 | Browser 成功，38 页，7,822,343 字节，3 次模型调用 |
| ACS Chemical Reviews | `10.1021/acs.chemrev.6b00057` | Browser runtime 不可用 | Browser 成功，92 页，27,142,058 字节，3 次模型调用 |
| Elsevier Molecular Catalysis | `10.1016/j.mcat.2023.113549` | Browser runtime 不可用 | Browser 成功，7 页，1,261,039 字节，6 次模型调用 |
| ChemRxiv | `10.26434/chemrxiv.11573400.v1` | Browser runtime 不可用 | Browser 成功，8 页，1,264,823 字节，4 次模型调用 |
| Wiley | `10.1002/adsc.201800405` | Public 中的 API 地址返回 400 | 原失败保留，未进入 Browser；详见下文路线衔接问题 |
| RSC | `10.1039/c6cc04636c` | Browser runtime 不可用 | 2 次模型调用，观察到 challenge，最终 `pdf-browser-rate-limited`；没有继续重试 |
| Springer 书籍章节 | `10.1007/978-981-97-8205-5_3` | Browser runtime 不可用 | 8 次模型调用，多次观察到 `LOGIN_REQUIRED`，Agent 最后主动停止，`pdf-browser-agent-stopped` |

第一轮约 38 秒。Browser 复跑约 5 分钟，共 26 次真实模型调用，6 篇中成功 4 篇；这是给定样本与本次访问条件的结果。Springer 的登录页面尚不足以证明该章节没有订阅权限；本轮没有输入校园用户名或邮箱。RSC 的最终回执保留了限流码，但没有保留具体响应地址、状态细节和 Retry-After，不能从本轮证据进一步解释每一次认证跳转。

## 独立路线与重复运行

### arXiv

以 `2203.11444` 通过正式 arXiv metadata lookup 接纳 *Root-aligned SMILES: A Tight Representation for Chemical Reaction Prediction*，再执行正式 `ASSET_READY` 补全。

- 由已接纳 metadata 中的 arXiv PDF 直链获取，发布 provenance 的 source 为 `direct`。
- 24 页、3,097,825 字节，SHA-256 为 `c34b6b8d59db4a1ada8379e658ac5ca5b05c8c1e321accfdeb04dfe6c1a7a32f`。
- 未启动 Browser、零模型调用。
- 对同一 Literature 再执行补全，返回 `already-satisfied`；该重复运行区间没有 HTTP、下载或模型调用事件。

### Sci-Hub

在独立临时 catalog 接纳 ACS 综述的已有真实 observations，仅启用生产 `ConfiguredSciHubSource`，使用正式 Entry、Network、文件验收与发布。

- `10.1021/acs.chemrev.6b00057` 成功入库，来源为 `sci-hub`。
- 92 页、26,709,933 字节，SHA-256 为 `3ddac2e801affa227407bedb5892b56bf28ffeadfdd0343c8b5e8dc129254058`。
- 与 Browser 获取的同文献文件字节不同，两份均为 92 页；没有合并或覆盖已发布文件。
- 这是独立路线测试，不表示当前 Auto 会自动使用 Sci-Hub，也不证明所有镜像和所有文章均可用。

### 授权 API

使用正式组装的 Elsevier/Wiley client、当前凭据和生产 Network，在独立 catalog 测试；没有自行取出 token 或构造认证 header。

| 检查 | 结果 |
| --- | --- |
| 显式注册 Elsevier/Wiley 来源，基于现有真实元数据调用 Source | 两者都 ready，但下载候选均为 0；只含该 API 的正式 Entry 返回 `exhausted` |
| Wiley 同 DOI 直接调用生产 client 的诊断对照 | API 返回 302，Network 因 `maxRedirects=0` 报 `redirect-limit`；未取得文件 |
| Elsevier 同 DOI 直接调用生产 client 的诊断对照 | API 返回 400；服务端错误为 `INVALID_INPUT` / `No resource identifier provided` |
| Elsevier 将 DOI 放入资源路径的对照 | 相同凭据、同一 Network，FULL XML 返回 200；直接 PDF 表示也返回 200，但文件只有 1 页 |

Elsevier 当前 client 构造 `/content/article/doi?view=FULL&doi=...`。对照使用 `/content/article/doi/{encoded-doi}?view=FULL` 后资源可识别，证实本次 400 的请求格式问题。这个对照没有修改生产 client，也没有将所得文件正式入库。

特别注意：Elsevier 对照 PDF 是该文献的第 1 页，249,731 字节；Browser 取得的完整文件有 7 页。**HTTP 200、PDF 可读和 DOI 正确都不能证明全文完整。** 后续应按 API 的 FULL XML / MAIN object 产品语义验证完整获取链，不应新增“单页即无效”或逐文章 DOI 匹配门。本轮没有完成修正 URL 后的 MAIN object 全链路验证，不声称 API 正式下载成功。

## 汇总：需要修复的现有实现问题

下表合并前一轮元数据与种子测试；每项均有真实请求或当前正式流程证据。优先处理这些阻碍，不据此扩展新的基础设施。

| 环节 | 已确认问题 | 实际影响 / 修复方向 |
| --- | --- | --- |
| 元数据接纳 | Crossref 展示文本没有处理换行、回车 | 100 条中 9 条转换失败；在 adapter 规范化外部文本，保持中性合同边界 |
| 主题限制 | Europe PMC 将 `year_from/year_to` 当成独立 API 参数 | 请求 2015–2025，仍接纳 97 篇 2026 文献；正确转换出版年份查询语法 |
| 引用分页 | Europe PMC 将响应 `offSet` 当累计记录偏移 | references 第一页和 citations 第二页被拒；按各接口协议解析分页 |
| 引用目标 lookup | Europe PMC 混淆 source、record ID、DOI | 已取得关系却查不到目标；按 ID 类型构造字段查询 |
| 引用接口 | Semantic Scholar 的引用 `fields` 错误 | 正式请求 400；仅调整 fields 的对照返回 64 条 |
| 引用调度 | 先完整扫描关系，再处理目标，预算终态阻止 lookup | 取得 50 条关系和附带元数据，最终新增 0 篇；让有界扫描产生可接纳结果 |
| 元数据到 PDF | Crossref 的 API 链接被声明为 `access_status=open`、通用 direct 文件 | Wiley API 被匿名访问，返回 400；该失败使后续 API/Browser 无法接手。应保留访问方式语义，不能统一将所有 400 当成可忽略 |
| API 适用性 | 只按既有 hint 的精确 origin 判断 DOI 是否属于 API；公开 DOI 落地的访问证据未有效交给 API | Wiley 的 `advanced.onlinelibrary.wiley.com`、Elsevier 的 `api.elsevier.com` hints 都未生成候选；API 已配置却被判不适用。需要打通可信访问证据的传递，不靠 DOI prefix 猜出版社 |
| Elsevier API | Article Retrieval 的资源标识放错位置 | 服务端明确 400 / 无资源标识；应按路径参数合同构造 URL，并复验 MAIN object 完整 PDF |
| Wiley API | 授权 transport 禁止全部重定向 | 真实 API 302 无法完成；需要按供应商已知跳转合同处理目标和凭据剥离，不能全局放开转发 |
| 失败反馈 | API 400 被降为 `response-schema`；Browser 限流/主动停止只有通用原因，回执 `retryable=false` | 用户难以判断应改请求、等待冷却还是处理访问条件；应在本次运行报告保留所属边界可确认的状态、原因和重试条件 |

源代码定位：

- [Crossref observation 转换](../../apps/server/src/providers/crossref/record.ts)
- [Europe PMC adapter](../../apps/server/src/providers/europe-pmc/metadata.ts)
- [Semantic Scholar adapter](../../apps/server/src/providers/semantic-scholar/metadata.ts)
- [引用发现协调](../../apps/server/src/entry/discovery.ts)
- [通用 API target 选择](../../apps/server/src/providers/shared/acquisition-locators.ts)
- [Elsevier API client](../../apps/server/src/providers/elsevier/acquisition.ts)
- [授权 Network 组装](../../apps/server/src/acquisition/assembly.ts)
- [API 响应转换](../../apps/server/src/providers/shared/authorized-pdf.ts)

## 配置与访问条件

这些事实单独处理，不能统称为解析 bug：

1. **Browser 安装与启动参数未连接。** 已有经验证的本地 runtime，但当前进程没有指向它；默认启动的 Browser 路线不可用。显式提供同一 runtime 后，真实模型与正式下载均能执行。需要整理实际启动入口的 runtime 配置。
2. **已配置凭据不等于来源已启用。** 当前 Auto 没有 Elsevier/Wiley API 和 Sci-Hub；测试仅在临时运行中显式启用。此行为符合当前来源选择规则，需要明确实际运行的来源清单。
3. **RSC 本次限流。** 本轮保留失败，没有继续冲击该站，也没有通过另一身份绕过冷却。
4. **Springer 章节本次停在登录流程。** 模型执行 8 次后主动停止；机构 IP 对该章节是否可用仍需单独核实。
5. **文件有效性与全文完整性不同。** Elsevier 1 页对照不作为全文成功；保持下载阶段文章身份 `unverified`，在供应商产品语义和后续解析阶段处理完整度、身份信息。

## 验证与产物

- 8 份正式入库 PDF 在 Application 关闭后通过独立 Query Application 重新读取全部字节，大小和 SHA-256 均与 catalog 一致。
- `pdfinfo` 验证 8 份正式文件均可读、未加密，页数为 7–92；单独的 Elsevier API 对照文件为 1 页，未入库。
- 各轮 Application 关闭后，`temporary_bytes`、`pending_write_bytes`、`native_bytes`、`staging_bytes`、`preparation_bytes` 均为 0；peak 字段只记录历史峰值。
- 另运行 `acquisition-public-sources`、`acquisition-authorized`、`acquisition-source-failures`，**3 个 Vitest 文件、39 个测试通过**。与元数据轮的 12 个测试一样，离线通过不能替代上述真实失败事实。
- 未修改产品代码、schema、依赖或长期配置，因此没有重跑 Quick/Full。本轮仅新增验证记录并检查文档 diff、链接；没有覆盖全部出版社、所有 API 产品或长期稳定性。

证据目录：`/tmp/sciretriever-live-discovery-20261009-GHy0tc/pdf-check/`。目录 UTC 日期与本报告的北京时间日期不同。

| 证据 | 内容 |
| --- | --- |
| `baseline-result.json`、`baseline-trace.ndjson` | 9 篇默认启动结果、普通 HTTP 状态与原始路线失败 |
| `ready-result.json`、`ready-trace.ndjson` | 显式 runtime 后 6 篇复跑、26 次真实模型调用与正式终态 |
| `routes-results.json`、`routes-trace.ndjson` | API readiness、候选数量及生产 client 对照 |
| `elsevier-control.json` | 原请求 400 的服务端原因、正确资源路径 200 的响应摘要 |
| `scihub-result.json`、`arxiv-result.json` | 两条独立路线的正式接纳与 arXiv 重复运行 |
| `final-summary.json`、`pdfinfo.json` | 合并逐篇结果、8 份文件重开校验、页数与字节数 |
| `*-closed.json`、`offline-tests.log` | 资源释放和 39 个离线测试的结果 |
| `pdfs/` | 8 份正式发布文件的导出副本；另外的 API 单页对照存放在该目录之外 |

API 测试脚本最初沿用已迁移的 Sci-Hub 导出位置，执行到 Sci-Hub 初始化时失败；该脚本错误已更正，Sci-Hub 用独立脚本完成正式复测，不计入产品故障。所有运行 catalog、PDF、模型输出和临时脚本均未加入仓库；临时目录可能由系统清理。
