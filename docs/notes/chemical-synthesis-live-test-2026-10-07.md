# 化学合成主题真实检索与 PDF 获取测试

后续修复及同批论文复验见[修复验证记录](chemical-synthesis-fix-validation-2026-10-07.md)；下文保留首次运行的原始失败事实。

2026-10-07 按用户明确要求，使用当前服务器网络、现有 Configuration/Credential owner、正式 Application 和当前配置的文献库执行真实主题发现与 PDF 补全。本轮结果是 **35 条新增元数据，选取的 10 篇论文中 1 篇 PDF 正式入库，9 篇失败**。失败目标在公开获取层终止，没有进入授权 API 或 Browser；不能把本轮作为 Browser 操作能力验收通过。

## 范围与执行方式

- 主题关键词：`chemical synthesis`；7 个已配置 Auto 元数据来源各扫描最多 10 条原始记录。
- 使用 `TopicDiscoveryService.run`，发现批次 ID 为 `96b594df-5cd7-48e3-a2c6-f3dc358f032a`。
- 从真实返回的元数据中人工选取 10 篇主题相关论文，覆盖 Nature、ACS、Wiley、Elsevier、RSC、Science 和 arXiv。排除语音合成、图像合成等误召回；因此下载样本不是随机样本，不能推算总体成功率。
- 正式 `DatabaseCompletionService.run`，目标为 `ASSET_READY`；没有解析或分析。
- 使用当前配置的现有 v2 Catalog，不执行迁移，不更改配置、DNS 或凭据，不复制个人 Cookie/Profile。
- Browser 配置为 `qiuzk/gpt-6-luna`，核验 Cloak `146.0.7680.177.5`；本轮目标均在公开层结束，未启动 Browser。
- 首轮没有替换 Provider、Network、模型或获取路线。9 个失败目标随后做一次保留原行为的诊断复测，只在临时进程包装 Tiered/Agent 调用和订阅 Node HTTP diagnostics，记录状态码及错误，不绕过 Public/API、不强制 Browser、不改变返回值。

## 元数据结果

| 来源 | 首轮结果 | 新增记录 | 复查证据 |
| --- | --- | ---: | --- |
| Crossref | 达扫描上限 | 10 | 多条相关性较弱，结果不等于精确短语匹配 |
| Semantic Scholar | 部分记录接纳，来源报告失败 | 5 | 首轮 `metadata-record-invalid`；后续独立复查为 HTTP 429，不能用复查替代首轮根因 |
| arXiv | 达扫描上限 | 10 | 存在语音、图像等 synthesis 误召回 |
| Europe PMC | 达扫描上限 | 10 | 获得化学合成相关论文及综述 |
| OpenAlex | 失败 | 0 | 复查收到 HTTP 200，随后 `network-http`；更底层原因尚未确定 |
| DataCite | 失败 | 0 | 复查收到 HTTP 200，随后 `network-http`；更底层原因尚未确定 |
| CORE | 失败 | 0 | 复查 HTTP 429，最终却报告 `metadata-provider-unexpected` / 无效记录 |

发现回执为 `PARTIAL`，`accepted_count=35`，`matched_count=0`。本轮新增的 35 条记录均通过正式逐篇 `library.detail` 读取。

发现后的 `library.search({query:{discovery_run_ids:[...]}})` 抛出 `invalid-contract`，字段路径为 `abstract`。检查实现发现：Storage 的普通 `librarySnapshot` 先读取全库文献并解析合同，Literature 再按查询条件过滤；即使指定发现批次，也可能受批次外不符合当前合同的数据影响。本轮改用已发布 discovery receipt 中的文献 ID 逐篇读取，继续执行下载，没有修改旧数据。这是测试调用方式的显式调整，不是声称原列表查询通过。

## 逐篇 PDF 结果

| 出版社 / 来源 | 文章 | DOI | 结果与证据 |
| --- | --- | --- | --- |
| Nature | Bayesian reaction optimization as a tool for chemical synthesis | `10.1038/s41586-021-03213-y` | 失败；落地 HTML 为 200，后续 PDF 路径多次 302/303，未交付 PDF。现有错误封装未保留足以判定最终跳转失败原因的细节 |
| Nature Biotechnology | Long-read sequencing and chemical synthesis access previously hidden antibiotics | `10.1038/s41587-025-02861-z` | 失败；落地 HTML 为 200，后续 PDF 路径多次 302/303，未交付 PDF；最终底层原因仍需细化 |
| ACS Chemical Reviews | Chemical Synthesis of Single Atomic Site Catalysts | `10.1021/acs.chemrev.9b00818` | 失败；DOI 跳转后 HTTP 403，返回 HTML |
| ACS Omega | Carbamate-Bearing Carbohydrates: Natural Occurrence, Pharmacological Relevance, and Chemical Synthesis | `10.1021/acsomega.6c01698` | 失败；Europe PMC PDF 路线和 DOI 路线均返回 HTTP 403 HTML |
| Wiley | Development of high-throughput wet-chemical synthesis techniques for material research | `10.1002/mgea.5` | 失败；已有直链及 DOI 路线返回 HTTP 403 HTML |
| Wiley | The Stubborn Persistence of Toxic Solvents in Chemical Synthesis | `10.1002/anie.1677569` | 失败；DOI 路线返回 HTTP 403 HTML |
| Elsevier | Chemical synthesis of oligosaccharides and their application in new drug research | `10.1016/j.ejmech.2023.115164` | 失败；已有 PDF 候选实际返回 HTTP 200 HTML；DOI landing 无可交付静态 PDF。先前 direct 失败使整个公开层保留失败 |
| RSC | Biocatalysis: landmark discoveries and applications in chemical synthesis | `10.1039/d3cs00689a` | 失败；已有直链及 DOI 路线返回 HTTP 403 HTML。本次不是先前 RSC 样本的 DNS 诊断 |
| arXiv / RSC 论文预印本 | Root-aligned SMILES: A Tight Representation for Chemical Reaction Prediction | `10.1039/d2sc02763a`；arXiv `2203.11444` | 成功；实际获取的是 arXiv 版本，24 页、3,097,825 字节，正式发布与导出 hash 一致 |
| Science Advances | Rule-breaking in chemical synthesis | `10.1126/sciadv.aeg7124` | 失败；Europe PMC PDF 路线和 DOI 路线均返回 HTTP 403 HTML |

9 个失败样本诊断复测仍为 0/9；不能将两轮当成 19 篇不同文章。403 只证明相应普通 HTTP 请求被拒绝，不能单凭状态码认定机构没有版权，也没有足够证据将每个 403 都认定为 Cloudflare。

成功 PDF 的 SHA-256 为 `c34b6b8d59db4a1ada8379e658ac5ca5b05c8c1e321accfdeb04dfe6c1a7a32f`。正式接纳和 `exportArtifact` 均成功；额外运行 `pdfinfo` 确认 24 页、未加密。文章身份按现有合同保持 `unverified`，没有把文件可读等同于文章身份已核验。

## 当前链路问题

1. **升级条件使 API 和 Browser 无法接手这批目标。** `EntryPdfAcquisitionService.acquireCohortInternal` 仅把 `exhausted` 传到下一层。公开获取的 403、候选返回 HTML、静态 PDF 获取失败被包装为 `candidate-download-failed`，继而成为 `route-failure`；目标直接进入失败分区。配置中存在 Elsevier API 凭据不能改变这个前置条件，本次未调用 Elsevier API，不能评估该论文的 API entitlement。
2. **错误分类丢失事实。** 普通 HTTP 状态、响应类型和具体网络原因在多层包装后丢失，最终只剩 `pdf-route-delivery-failed`。元数据层还将已观察到的 429 和 Network 错误呈现为“无效记录”。这不利于区分限流、来源不适用、普通 HTTP 不能交付与真实权限拒绝。
3. **检索范围与数据读取范围不一致。** 发现批次查询仍先解析全库，批次外合同问题会使本次列表不可读；逐篇读取证明本轮新增记录可以正常消费。
4. **主题召回需要单独评价。** 35 条接纳记录不是 35 篇精确主题相关文献；Crossref/arXiv 的当前排序和查询方式出现明显误召回。

当前升级行为可在 [PDF 获取指南](../guides/pdf-acquisition.md) 和 [获取协调实现](../../apps/server/src/entry/pdf-acquisition.ts) 对照。修复应先明确普通 HTTP 路线能力不足与限流、系统错误、需要操作员处理的拒绝之间的通用合同，保留 429/Retry-After 等事实，再调整升级判断；不能简单把所有错误当正常 miss，也不能增加出版社专用点击补丁。

本轮是用户授权的真实运行与诊断，没有修改产品代码，没有通过跳过公开层来展示 Browser 成功，也没有重跑代码 Full。既有 Browser 单独验收仍是其原范围内的证据，不替代本轮完整路线的失败事实。

## 证据与产物

本机测试目录：`/tmp/sciretriever-chemical-synthesis-20261007-yrnWhG/`。

- `discovery.json`：正式主题发现回执。
- `papers.json`：35 条新文献的逐篇元数据、ID 和来源。
- `selected.json`：10 篇选定样本及下载前状态。
- `completion.json`、`result.json`：首轮补全结果和正式 PDF 导出校验。
- `pdfs/09.pdf`：成功 PDF 的可读导出副本；库内原始资产继续保留。
- `retry/trace.jsonl`：9 个失败目标诊断复测的 HTTP 状态与 tier 终态；没有模型调用事件。
- `retry/completion.json`、`retry/result.json`：复测回执。
- `metadata-diagnosis.jsonl`：4 个失败元数据来源的独立只读复查。
- `closed.json`、`retry/closed.json`：Application 关闭后的文件资源计数为零；peak 字段为历史峰值。

临时目录可能被系统清理，正式接纳的元数据和成功 PDF 已保留在当前配置的文献库。本报告不包含凭据、Cookie、签名 URL、响应正文或 PDF 字节；没有执行 Git 提交。
