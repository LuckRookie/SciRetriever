# 化学合成主题：修复与真实复验

本记录接续[首次真实测试](chemical-synthesis-live-test-2026-10-07.md)。用户要求修复该轮暴露的问题；本轮沿用同一文献库、原来 10 篇论文、正式 Public → 已配置 API → Browser 调度及 `qiuzk/gpt-6-luna`，没有强制跳过公开层。

## 修复范围

1. 公共 HTTP 的能力边界与失败分开：不带限流反馈的 403、只能返回非 PDF 的静态页面流程，以及 Network 明确报告的重定向上限，可以交给后续已配置路线。401、429、Retry-After、临时网络/服务及系统失败保留阻断语义；同层更早的未解决错误不能被后来的不可用声明覆盖。修改依据及边界已写入 [ADR 0015 §7](../architecture/decisions/0015-publisher-aware-tiered-pdf-acquisition.md#7-升级暂停与熔断语义)。
2. PDF 直链提示与媒体类型不再覆盖实际内容：返回 HTML 时寻找通用静态 PDF 链接，真实 PDF 仍由 reader 检查。静态候选先通过 URL 语法、scheme/port 准入；不合规则的附带链接不进入网络队列。DNS、私有地址及重定向仍在实际请求前验证。端口预筛选与已获准 landing 一致，保留合法非 443 HTTPS 下载。
3. 保留 HTTP/Network 原因：`NetworkHttpError` 增加有限原因与有界 Retry-After 反馈，公开/授权获取及元数据适配器形成对应稳定失败，不把 429 和读取超时描述成无效记录。授权 API 的明确权限拒绝仍不转成 Browser 准入；未知/schema/存储/取消异常不被伪装成正常 miss。Unpaywall 的 DOI 路径分段编码及联系邮箱传递使用既有 Network 边界。
4. Metadata 的 4 MiB 响应预算实际传到读取层，消除隐藏的 1 MiB 截断；请求明确使用 30 秒超时。DataCite 使用有界的 25 条默认页，避免一次返回 100 条完整记录导致读取超时，逐来源原始扫描上限不变。
5. Semantic Scholar 的数字 PubMedCentral ID 规范化为 `PMC…`；DataCite 摘要换行规范化为空格，原始输入 hash 保留，NUL 等非法控制字符仍拒绝。Crossref 显式按 score 降序；arXiv 对各词/显式短语使用 `all:` 和 AND，不加入主题专用规则或语义过滤。
6. 发现批次、FTS 与显式 ID 的交集在 Storage 读取领域记录前落实；补全快照只扩展所选记录的版本成员。批次外无效旧记录不再阻断本批次，所选记录及应读取版本仍严格校验。没有修改或迁移旧数据。
7. Full 发现并修复共享 HTTP 校验与 MinerU 已有 128 MiB 响应预算的冲突；每个调用方自己的较小预算继续执行。凭据撤销测试保留“撤销后不发新请求”和原始 authentication cause，更新为新的稳定路线错误；组装测试使用已有 source seam 产生明确离线失败，并断言没有 DNS 请求，取消对真实 fixture DOI 的意外依赖。

没有增加依赖、数据库 schema、用户配置字段或出版社点击规则。模型、机构网络、PDF 身份 `unverified` 及不可变资产合同保留。API key 存在不会暗中启用来源；本次配置为 Acquisition Auto，实际 API 集合为空，新增 8 份 PDF 均由 Browser 获得，不能据此声称真实 Elsevier/Wiley API 下载已经验证。

## 真实复验结果

原 10 篇文献现有 **9 份 PDF**：原有 arXiv 1 份，本轮 Browser 新增 8 份。所有 9 份均经正式导出、SHA-256 对照及 `pdfinfo` 再检查。下载阶段的文章身份仍为 `unverified`，可读性检查不等同于内容身份核验。

| 来源 | DOI | 获取路径 | 字节数 / 页数 | 本轮结论 |
| --- | --- | --- | --- | --- |
| Nature | `10.1038/s41586-021-03213-y` | Browser | 4,945,308 / 12 | 最后针对性复测成功 |
| Nature Biotechnology | `10.1038/s41587-025-02861-z` | Browser | 2,535,703 / 2 | 新增 PDF 入库 |
| ACS Chemical Reviews | `10.1021/acs.chemrev.9b00818` | Browser | 86,403,738 / 56 | 新增 PDF 入库，约 86 MB 文件正常交付 |
| ACS Omega | `10.1021/acsomega.6c01698` | Browser | 2,582,248 / 13 | 新增 PDF 入库 |
| Wiley | `10.1002/mgea.5` | Browser | 4,179,394 / 23 | 新增 PDF 入库 |
| Wiley | `10.1002/anie.1677569` | Browser | 2,569,814 / 10 | 新增 PDF 入库 |
| Elsevier | `10.1016/j.ejmech.2023.115164` | Browser | 14,509,475 / 33 | 新增 PDF 入库 |
| RSC | `10.1039/d3cs00689a` | Browser 已进入 | — | 验证阶段触发 `pdf-browser-rate-limited`，没有 PDF |
| arXiv | `10.1039/d2sc02763a`；`2203.11444` | arXiv | 3,097,825 / 24 | 复用已有 PDF，没有重复下载 |
| Science Advances | `10.1126/sciadv.aeg7124` | Browser | 513,423 / 3 | 新增 PDF 入库 |

统计口径：第一次完整 cohort 新增 7 份、复用 1 份、失败 2 篇；随后修复静态候选预筛选并单独复测 Nature，新增第 8 份。这是同一 10 篇集合的两次运行汇总，不是声称 10 篇在最后版本一次运行全部成功。最终端口校正不改变这批 HTTPS:443 样本的路线，另有非 443 回归覆盖。两轮共记录 21 次真实 Browser 模型调用，全部原样转交正式 AgentRuntime；采集器仅记录安全的状态与动作种类，不替换决策或获取结果。

Nature 中间失败已具体定位：主 PDF 发生有界重定向耗尽，随后 HTML 上的附带 CDN PDF 链接包含公共 URL 规则不接受的编码分隔符，原逻辑将这些链接的本地路径错误覆盖主路径的可交接结果。最终修复在静态候选提取时排除不可准入 URL，没有按 Nature/CDN hostname 编写规则，也没有将任意 NetworkPolicyError 转为可升级。

RSC 已进入通用 Agent，保存了两次 `CHALLENGE` 观察；最终由 Browser 运行时报告限流，未继续人工重复请求。此轮没有保存具体限流响应头，所以不报告 Retry-After 数值，也不将其归为“无版权”或先前另一个 RSC 样本的 DNS 故障。

原发现批次 `96b594df-5cd7-48e3-a2c6-f3dc358f032a` 已通过正式 `library.search` 返回全部 35 条记录，未再触发批次外 `abstract` 校验错误。

下载 Application 关闭后，又使用独立 `createQueryApplication` 重新打开同一库：35 条批次记录、9 份主 PDF 均可读取，9 个持久化 hash 与导出记录一致；结果不是仅存在于下载进程内。

## 元数据的独立只读复查

| 来源 | 修复前证据 | 修复后证据 |
| --- | --- | --- |
| OpenAlex | 约 1.9 MiB 响应在隐藏 1 MiB 上限附近截断 | 完整读取 1,901,163 字节，扫描/转换 10/10 |
| Semantic Scholar | 同一前 10 条中 5 条因数字 PMCID 拒绝 | 扫描/转换 10/10 |
| DataCite | 100 条页读取超时；缩页后另发现摘要换行问题 | 默认 25 条页，扫描/转换 10/10，约 4.56 秒 |
| CORE | 外部 429 被描述为无效记录 | 外部仍可返回 429，准确报告 `metadata-provider-rate-limited` |
| Crossref / arXiv | 排序与多词查询导致弱相关/跨主题结果 | 对照真实请求验证 score 排序及显式 AND 查询，仍不保证所有合法记录语义相关 |

这些探测不向真实库额外发布 observation，不能把结果计为新增 30 条入库。CORE 的限流属于外部状态，不宣称代码修复使其解除。

## 验证状态与证据

- Metadata/Network 直接测试：25 文件 / 107 项通过。
- API/Unpaywall 直接测试：19 项通过，含回环 TLS 的真实 Network 传输。
- 查询回归：新 2 项、相关既有 27 项通过。
- 最后静态链接/端口、Public/API/Browser 交接与来源错误集成回归：3 文件 / 48 项通过。
- Full 的 3 个回归收尾后，相关组装/凭据/Agent Network 直接测试 3 文件 / 40 项通过。
- 最终 `VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 pnpm full` **通过，退出码 0**：193 个测试文件 / 1,319 项通过，15 个文件 / 39 项条件跳过；Vitest 用时 283.92 秒。Quick（格式、ESLint、源码与测试 strict 类型）及 TypeScript/Web 构建均通过。条件跳过不计为真实运行通过；真实 Browser 证据使用上面的实际模型与 PDF 发布记录。
- 前两次 Full 因真实复测/独立审查发现需追加修复而主动中断（130），另一次 Full 完整运行发现上述 3 个回归，这些前序运行不计为通过。最后 424 个源码/测试/依赖文件的冻结 hash 全部保持一致。
- 两次真实 Application 均正常关闭，临时/待写/native/staging/preparation 当前字节计数归零；历史 peak 不是未清理资源。

本机证据目录：`/tmp/sciretriever-chemical-fix-20261007/`：

- `combined-result.json`：10 篇汇总及 9 份 PDF 的 hash、页数、来源和导出路径。
- `result.json`、`completion.json`、`trace.jsonl`：首轮正式 cohort 与 HTTP/模型观察。
- `scoped-query.json`：正式发现批次查询 35 条。
- `persisted-verification.json`：重新打开独立查询入口后的持久化结果核对。
- `nature-diagnosis.jsonl`：Nature 中间失败的有限调用栈/状态诊断；没有签名参数值。
- `nature-final/result.json`、`nature-final/trace.jsonl`：Nature 的最终针对性复验。
- `pdfs/` 与 `nature-final/pdfs/`：正式导出副本。
- `closed.json`、`nature-final/closed.json`：资源收束结果。
- `source-manifest.json`：最终源码/测试/依赖文件的 SHA-256 清单。
- `full-delivery.log`：最后一次 Full；`full.log`、`full-final.log` 保存主动中断的前序运行；`full-delivery-before-regression-fixes.log` 保存发现 3 个回归的完整运行。

元数据探测证据保留在首次目录 `/tmp/sciretriever-chemical-synthesis-20261007-yrnWhG/` 的 `metadata-network-after.jsonl`、`semantic-record-diagnosis.jsonl`、`metadata-relevance-probe.jsonl`、`metadata-page-probe.jsonl`、`datacite-record-diagnosis.jsonl` 和 `datacite-default-after.jsonl`。其中 `metadata-network-before.jsonl` 两条迟到 close 事件标签错用了下一来源，必须按同次 HTTP 事件和时间对应，不单独用该标签判定来源；后续记录已固定捕获来源，原证据未改写。

未扩大本轮到所有 API 产品的实网验收。审查另发现 Wiley API opaque DOI path、DataCite/OpenAlex DOI lookup 的编码与 Network 路径边界存在旁支兼容问题；这些不是本轮主题查询或当前 Auto PDF 路线，未放宽规则或启用额外来源，也未声称其真实 lookup/API 下载通过。无 Git 提交、配置/DNS/凭据修改或数据库迁移。

## Sci-Hub 独立真实复测

用户追问 Sci-Hub 后，核实上一轮 Auto 路线未包含该来源，trace 中 Sci-Hub 请求数为 0。当前 Auto 的显式来源列表为 arXiv、Europe PMC，另组装直接链接和 DOI landing；不能将上一轮结果描述为包含 Sci-Hub 的全来源验收。

本次将原批次 Nature 论文 `10.1038/s41586-021-03213-y` 的真实元数据通过正式 identity 入口接纳到隔离临时库，仅注册生产 `ConfiguredSciHubSource`，使用正式 Entry 下载、Network、文件验收、发布和导出链路；未启用其它来源或 Browser，也未修改个人配置或真实库。

- `sci-hub.ru` 文章页返回 HTTP 200 / HTML，随后同站文件请求返回 HTTP 200 / PDF。
- 正式结果为 `acquired`，provenance 来源为 `sci-hub`，文件大小 4,945,308 字节。
- 导出 SHA-256 与入库记录一致：`007c91498f3c3ed24b1b3d15c1fef8ec66a469d01ff7100e4c0775134d5dec9d`；与此前 Browser 获取的该论文文件 hash 也一致。
- 首镜像成功后没有请求备用 `sci-hub.kr`，不宣称两个镜像均已验证。
- Application 关闭后所有当前文件资源计数归零。本次未修改源码，不重复运行 Full。

证据目录：`/tmp/sciretriever-scihub-check-20261007-T5qQxm/`，包含 `run.mjs`、`trace.jsonl`、`result.json`、`article.pdf` 和 `closed.json`。这证明当前实现能通过 Sci-Hub 完成该样本的真实下载与入库，不代表任意论文覆盖率或长期镜像稳定性。此前 10 月 4 日 PLOS 样本遇到文件服务器 504 的记录仍有效，两次结果不矛盾。
