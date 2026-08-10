# PDF 获取路径参考实现调研

- 最后核对：2026-08-07
- 文档性质：外部工具与参考实现 Notes
- 相关目标设计：[Acquisition 技术设计](../architecture/technical/acquisition.md)、[Network 技术设计](../architecture/technical/network.md)

本文记录两个本地参考项目和 Zotero 官方实现如何发现、下载并验证文献 PDF，重点回答不同访问路径之间是否存在稳定优先级。本文只提供后续讨论的事实依据，不批准新的 provider、浏览器、代理、凭据、配置或产品能力，也不把参考工具的状态、验证阈值和失败模型写成 SciRetriever 合同。

本轮只读源码、文档和测试，没有连接 Zotero、真实供应商、机构登录或浏览器会话，没有下载 PDF，也没有读取本地浏览器 profile、Cookie、缓存、测试语料或凭据。两个本地快照均位于仓库外：

```text
/workplace/home/duanjw/project/third_party/zotero-fulltext-downloader-2026-08-03
/workplace/home/duanjw/project/third_party/scansci-pdf
```

引用本地证据时，路径分别相对于上述两个快照根目录；这些机器相关路径不是 SciRetriever 的运行依赖。

## 1. 核心结论

三个参考实现没有共同遵守一套“公开来源 -> 授权 Provider API -> 浏览器”的现成顺序：

| 参考实现 | 实际主路径 | 是否具有硬阶段优先级 |
|---|---|---|
| Zotero Full-Text Downloader 本地快照 | OpenAlex/Unpaywall 正式版候选 -> 持久化 Chrome；Elsevier API 是未接入标准主链的可选 helper | 开放来源到浏览器有硬回退；授权 API 没有闭环成为中间阶段 |
| ScanSci PDF 当前 checkout `5e4a6f2` | 公开 API/MCP 把 OA、授权 API、出版商直链、浏览器等来源放入并发竞速，失败后再做机构访问；CLI 另有一条近似串行路径 | 公开 API/MCP 没有三段式硬优先级；CLI 有不同但不完全一致的顺序 |
| Zotero Desktop 9.0.6 | DOI 页面 -> 条目 URL -> OA -> custom resolver；每项内部先 direct URL、后 landing page | 有确定顺序和首个成功短路，但不是 OA 优先，也没有统一授权 Provider API 层 |
| Zotero Connector 5.0.211 | 当前页面 Translator 附件 -> OA -> automatic custom resolver | 有确定顺序；授权访问主要来自真实浏览器会话，而不是出版商 API 层 |

SciRetriever 当前目标设计已接受：

```text
第一层：公开来源
第二层：已配置且已授权的 Provider API
第三层：受控浏览器访问
```

这是 SciRetriever 自己明确的访问成本和副作用顺序，而不是对 Zotero 或某个下载器现状的直接复制。Acquisition 必须按阶段短路：前一层全部候选耗尽后才启动下一层；仅给所有候选设置不同分数、再同时启动，不能表达这个优先级。正式合同见 [Design 4.4](../architecture/design.md#44-acquisition)与 [Acquisition 技术设计](../architecture/technical/acquisition.md)。

## 2. 两种优先级不能混写

当前讨论涉及两个不同维度。

### 2.1 路径层级

路径层级回答“使用什么访问上下文取得 PDF”：

1. **公开来源**：不需要 provider secret 或登录浏览器状态即可使用的直接 URL、开放仓储、预印本服务、OA resolver 和普通公开落地页；
2. **授权 Provider API**：必须使用 operator 配置的 API key、institution token、内容 entitlement 或其它 provider 专属授权；
3. **受控浏览器**：需要真实网页执行环境、已存在的机构/订阅会话、页面 Translator、点击或下载事件才能取得 PDF。

授权 API 和浏览器会话是两种独立授权上下文。API key 有效不代表全文 entitlement 成立；浏览器中已经登录也不代表同一 provider API 获得授权。

### 2.2 同一层内部的候选顺序

候选顺序回答“同一种访问路径里先试哪个 locator”。例如公开层内部仍可能存在：

- Metadata observation 已经提供的直接主 PDF URL；
- arXiv、Europe PMC 等公共文献服务的直接 PDF；
- Unpaywall、OpenAlex、Semantic Scholar 等发现的 OA locator；
- 公开出版社或仓储 landing page；
- 同一 URL 由多个 resolver 重复返回后的去重顺序。

这类顺序不能反过来把浏览器候选提前到公开候选之前。路径层级应先决定允许启动的 source 集合，再在该集合内排序和逐个尝试。

## 3. Zotero Full-Text Downloader 本地快照

### 3.1 实际标准流程

该项目以 Zotero collection 和 Zotero parent key 为任务身份，不是独立的通用 DOI 下载库。标准流程为：

```text
Zotero collection 审计
  -> 已有非补充 PDF 的 parent 默认不进入队列
  -> 对缺 DOI/URL 的记录使用 Crossref 保守补 DOI
  -> OpenAlex + 可选 Unpaywall 发现 publishedVersion PDF
  -> 公开 HTTP 候选依次下载和验证
  -> 未成功且具有 DOI 的记录进入持久化 Chrome
  -> 从 doi.org 落地页发现 PDF 控件并监听下载
  -> 验证后形成 checkpoint
  -> 下载与 Zotero 附件写入是两个阶段
```

关键证据：

- 下载队列字段和 Zotero parent identity：`zotero-fulltext-downloader/scripts/zotero_pdf_retriever.py:359`；
- Crossref 只为无 DOI/URL 记录恢复 DOI：`zotero-fulltext-downloader/scripts/route_unknown_titles.py:127`、`:215`；
- OpenAlex 与可选 Unpaywall 是标准公开发现源：`zotero-fulltext-downloader/scripts/strict_published_router.py:86`、`:114`、`:163`；
- OA 候选按 publisher host、Unpaywall/OpenAlex 和 URL 长度排序：`zotero-fulltext-downloader/scripts/strict_published_router.py:193`、`:199`；
- 未成功记录生成浏览器回退审计：`zotero-fulltext-downloader/scripts/strict_published_router.py:435`；
- 浏览器只自动处理有 DOI 的记录，并从 `https://doi.org/{doi}` 开始：`zotero-fulltext-downloader/scripts/browser_queue_runner.py:139`、`:177`。

### 3.2 浏览器路径

标准打包流程使用 Playwright CLI 管理的 headed、persistent Chrome session，而不是无状态 HTTP 或普通 headless browser：

- runner 以指定 profile 启动或复用持久 session：`zotero-fulltext-downloader/scripts/browser_queue_runner.py:94`、`:123`；
- worker 从 PDF meta、可见链接、iframe、embed 和 object 中评分候选：`zotero-fulltext-downloader/scripts/browser_batch_worker.js:123`、`:160`；
- 下载事件必须在导航或点击前监听；原生 PDF viewer 只尝试一次可见 Download 控件：`zotero-fulltext-downloader/scripts/browser_batch_worker.js:177`、`:213`；
- 没有下载事件时不重放短期签名 URL，而是进入人工检查：`zotero-fulltext-downloader/scripts/browser_queue_runner.py:220`。

机构登录 Cookie 由 Chrome profile 自己使用。代码没有导出 Cookie，也没有把请求 header、token 或带 query 的签名 URL写入 checkpoint；持久化 URL 会去除 query 和 fragment。

### 3.3 授权 API 不是标准中间阶段

项目存在 Elsevier 授权 helper：

```text
Article Retrieval API view=FULL
  -> 解析非 supplement PDF EID
  -> Content Object API
  -> 临时文件验证
```

证据位于 `zotero-fulltext-downloader/scripts/elsevier_authorized_retriever.py:243`、`:302`、`:387`。但它没有被标准工作流自动安排在 OA 和 Chrome 之间，成功状态也不是标准 importer 接受的 `DOWNLOADED_VALIDATED + publishedVersion`，见：

- `zotero-fulltext-downloader/scripts/merge_checkpoints.py:106`；
- `zotero-fulltext-downloader/scripts/zotero_attachment_importer.py:142`。

因此，这个快照支持“OA 失败后回退浏览器”，但不能作为“授权 API 已经稳定位于两者之间”的实现证据。

### 3.4 验证比 SciRetriever 当前下载边界更严格

它要求最低字节数、PDF header、`startxref`、`%%EOF`、pypdf 可读、至少两页、非补充材料信号以及 DOI 或标题/出版物/年份匹配，见 `zotero-fulltext-downloader/scripts/ingest_downloads.py:71`、`:105`、`:117`。

这些阈值是该工具的正式版 Zotero 附件策略，不属于 SciRetriever 已接受的 PDF 基本检查。SciRetriever 已决定把“只有一页或没有实际文献内容”等判断留到 MinerU 后的 LLM Analysis；本 Notes 不建议复制这些阈值。

## 4. ScanSci PDF 当前 checkout

### 4.1 同一仓库存在两条下载管线

公开 API、MCP 和顶层 `scansci_pdf.download()` 使用：

```text
cache/index
  -> arXiv 特例
  -> 多来源并发竞速
  -> 机构访问竞速
  -> late capture
  -> 失败指导
```

入口见 `src/scansci_pdf/__init__.py:48` 和 `src/scansci_pdf/sources/__init__.py:559`。

Typer CLI 的 `fetch`、旧式 `batch` 和搜索后抓取使用另一条 `PaperFetcher` 管线：

```text
全文 cache
  -> arXiv / Unpaywall
  -> Elsevier API
  -> DOI resolve
  -> CARSI
  -> 构造出版商 PDF URL
  -> browser
  -> WebVPN / EZProxy
```

入口和顺序见 `src/scansci_pdf/cli.py:379`、`src/scansci_pdf/fetcher.py:170`。因此不能只根据 README 或某一个入口概括整个项目的优先级。

### 4.2 公开 API/MCP 的第一阶段是混合竞速

第一阶段同时构造并运行：

- Unpaywall、OpenAlex、Semantic Scholar、DOAJ、Europe PMC、CORE、PMC 等公开/OA 来源；
- Crossref 和出版商页面的普通 HTTP 发现；
- Elsevier 授权 API；
- 出版商专用 URL 和浏览器策略；
- 当前 SciRetriever 设计未采纳的其它来源。

来源构造见 `src/scansci_pdf/sources/__init__.py:290`，publisher tools 见 `src/scansci_pdf/sources/publishers.py:668`。当前默认 `download_strategy="fastest"`，见 `src/scansci_pdf/config.py:31`。

当前本地树没有已编译 racing extension，因此 Python fallback 把全部来源一次性提交到线程池，首个成功者胜出：`src/scansci_pdf/sources/__init__.py:371`。即便配置名为 `oa_first`，它也只是改变列表拼接和提交顺序，不会等全部 OA 来源失败后再启动授权 API 或浏览器。因此这种 racing 不能作为硬优先级实现。

### 4.3 公开/OA 发现和候选内部顺序

该项目覆盖了多种可借鉴的候选发现方式：

- Unpaywall 内部把 repository URL 排在 publisher URL 前，默认最多尝试两个：`src/scansci_pdf/sources/unpaywall.py:14`；
- Semantic Scholar 使用 `openAccessPdf.url`，必要时根据 arXiv ID 形成 arXiv PDF：`src/scansci_pdf/sources/semantic_scholar.py:116`；
- Crossref 先使用记录中的 PDF link，也可以从 DOI landing page 的 meta、link、iframe/embed 和脚本中发现候选：`src/scansci_pdf/sources/crossref.py:16`；
- CORE 递归收集 payload locator 并限制候选数量：`src/scansci_pdf/sources/core_api.py:13`；
- 出版商 router 依次使用出版商专属推导、模板 URL、通用 URL 和 HTML discovery：`src/scansci_pdf/publisher_pdf_router.py:88`、`:133`。

这些机制说明同一公开层内部仍需要 URL 去重、补充材料排除、候选数量上限和首个成功短路，但不证明不同访问层应该同时启动。

### 4.4 授权 API 和浏览器路径

Elsevier 在公开 API/MCP 与 CLI 中有两套不同实现，均大致采用：

```text
Article Retrieval FULL XML
  -> 提取并排序 attachment/object EID
  -> Content Object API
  -> PDF 检查
```

公开 API/MCP 实现见 `src/scansci_pdf/publisher_strategies.py:2309`、`:2425`；CLI 实现见 `src/scansci_pdf/sources/elsevier_api.py:20` 和 `src/scansci_pdf/fetcher.py:704`。两者的 direct PDF fallback、重试和成功标准并不完全一致。

浏览器路径通常先尝试 direct URL，再进入浏览器。浏览器内部依次尝试网络响应捕获、带 credentials 的 in-browser fetch、DOM PDF link、点击下载控件以及带 Cookie 的 HTTP 回退，见：

- `src/scansci_pdf/publisher_strategies.py:1616`；
- `src/scansci_pdf/browser_engine.py:431`；
- `src/scansci_pdf/institutional/publisher_batch.py:1444`、`:1730`。

普通 Phase 1 browser 使用临时 context 并从文件导入 Cookie；批量机构路径才主要复用 persistent browser profile。不能把整个项目概括成“所有浏览器下载都复用同一个已登录 profile”。

### 4.5 不能直接借鉴的部分

当前项目同时包含额外来源、代理轮换、Cookie 文件和多种浏览器 profile 管理。它们不是 SciRetriever 当前 requirements、ADR、design 或 technical 已批准的能力，本 Notes 不把它们转换成配置、provider、fallback 或访问策略。

其验证也不统一：主 HTTP 下载检查 PDF magic、EOF 和可疑小文件，但 cache、late capture 和某些旧文件路径只检查存在或最低大小。这个差异说明所有 access path 最终必须汇入同一个接纳边界，不能让某个快速路径绕过统一 PDF 基本检查。

## 5. Zotero 官方实现

本节以 Zotero Desktop `9.0.6` 和 Zotero Connector `5.0.211` 的官方标签、源码、测试和用户文档为依据。后续主分支变化不反写成这些版本的行为。

### 5.1 Desktop “Find Available PDF”

Zotero Desktop 的 resolver 顺序明确是：

```text
DOI 页面
  -> 条目 URL
  -> OA 查询
  -> custom resolver
```

官方源码：

- [`getFileResolvers()` 默认顺序](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/attachments.js#L1258-L1315)；
- [`downloadFirstAvailableFile()` 按顺序短路](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/attachments.js#L1927-L1947)。

DOI 路径从 `https://doi.org/{doi}` 开始，普通 HTTP 跟随 redirect；如果最终是 HTML，则运行 Zotero Web Translator 提取附件 URL，再以页面 URL 作为 Referer 下载：

- [DOI resolver](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/attachments.js#L1280-L1288)；
- [页面请求、redirect 和 HTML 处理](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/attachments.js#L2079-L2226)；
- [Translator 提取附件 URL](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/utilities_internal.js#L1336-L1368)。

Zotero OA 查询使用自己的私有 Unpaywall mirror。官方源码明确要求非 Zotero 项目直接使用 Unpaywall，不能把 Zotero 私有 `/oa/search` 当作 SciRetriever provider：

- [`getOpenAccessPDFURLs()`](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/utilities_internal.js#L1294-L1333)；
- [官方 Unpaywall 集成说明](https://www.zotero.org/blog/improved-pdf-retrieval-with-unpaywall-integration/)。

Custom PDF Resolver 支持简单 GET/POST、HTML selector 或 JSON mapping，但没有完整的 credentials、headers、OAuth 或 secret lifecycle 合同，因此不能等同于统一授权 Provider API 框架：

- [Custom PDF Resolvers](https://www.zotero.org/support/kb/custom_pdf_resolvers)。

### 5.2 Zotero Connector

Connector 保存当前网页时，优先使用 Web Translator 返回的 PDF 附件；该附件不存在或失败后，才回退到 OA 和允许自动运行的 custom resolver：

- [Translator 附件优先、OA fallback](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/translation/translate_item.js#L146-L193)；
- [OA 后追加 automatic custom resolver](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/translation/translate_item.js#L345-L427)。

Connector 在真实浏览器扩展上下文中取得附件，能够使用当前浏览器 Cookie、partitioned Cookie、referrer 和机构代理 URL：

- [读取 Cookie、设置 referrer 并请求附件](https://github.com/zotero/zotero-connectors/blob/5.0.211/src/common/itemSaver_background.js#L204-L237)；
- [机构代理检测](https://www.zotero.org/support/connector#institutional_proxy_detection)；
- [Translator attachment 与 proxy 规则](https://www.zotero.org/support/dev/translators/coding#attachments)。

因此，Zotero 中“已有机构/订阅访问”的主要路径是 Connector 利用用户当前浏览器会话，而不是 Desktop 统一调用出版社 API。

### 5.3 Zotero 不是通用无头浏览器下载器

普通 DOI/URL 页面通过 HTTP、redirect、DOM 和 Translator 处理，不会为每家出版社启动 Playwright、Selenium 或 Chrome Headless。只有普通下载遇到 403 或非 PDF，并且 URL 命中 Zotero 维护的 challenge registry 时，才进入内嵌 `HiddenBrowser`：

- [普通下载失败后的 BrowserRequest fallback](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/attachments.js#L1169-L1208)；
- [challenge registry](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/browserRequest.js#L28-L60)；
- [HiddenBrowser 加载和 PDF 捕获](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/browserRequest.js#L398-L533)。

必要时 Zotero 会打开可见窗口让用户处理 challenge。更准确的描述是“少数已知站点的隐藏浏览上下文 fallback”，不是“普遍模拟用户访问全部出版社网页”。

### 5.4 验证与失败

Desktop 下载到临时文件后主要读取前 1000 字节做 MIME sniff，确认 PDF/EPUB 类型；它不判断页数、正文长度、封面页或语义完整性：

- [文件类型检查和临时文件清理](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/attachments.js#L1169-L1238)。

这与 SciRetriever 当前“下载阶段做基本检查、内容有效性留给 MinerU 后的 Analysis”更接近。Zotero 还执行 URL 去重、HTTPS、redirect 预算、逐域间隔、`Retry-After` 和连续失败限制：

- [URL 归一化和去重](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/attachments.js#L1951-L1972)；
- [redirect 预算](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/attachments.js#L2088-L2165)；
- [逐域调度和失败限制](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/attachments.js#L1643-L1745)。

所有候选失败后不建立附件，也不保留一个完整的逐候选业务对象；这与 SciRetriever 已接受的 `NoPrimaryPdf` 边界相近。

## 6. 对 SciRetriever 当前目标设计的参考

以下结论已被当前 design/technical 采用；本 Notes 仍只保存参考依据，发生冲突时以 Accepted ADR、design 和 technical 为准。

### 6.1 三个阶段应由 Acquisition 编排，而不是写进 Provider

`PdfSource` 仍只负责发现和获取自己的候选。Acquisition 依据 source 的已配置访问路径把它放入公开、授权 API 或浏览器阶段，并执行：

```text
公开阶段全部耗尽
  -> 才启动授权 API 阶段
  -> 全部耗尽后才启动浏览器阶段
```

Provider 不返回“我应该排第几”，也不把浏览器、授权和开放状态混入 `LiteratureMetadata`。

### 6.2 同一个外部机构可以具有多个访问 adapter

例如一个出版社可能同时具有：

- Metadata 返回的公开 PDF/landing `AssetHint`；
- 需要 API key 和内容 entitlement 的授权 API；
- 需要现有登录状态的浏览器页面。

三者不应挤进一个带大量可选参数的调用。它们可以共享 provider identity 和 Network，但由不同 source adapter 声明各自访问路径。

### 6.3 所有阶段必须汇入同一个 PDF 接纳边界

参考实现中最常见的缺陷是 cache、late capture、浏览器和 API 各自使用不同成功标准。SciRetriever 不应因为候选来自公开、授权 API 或浏览器而改变基本检查：

- 非空；
- 实际 PDF；
- 文件结构可读取；
- 页面结构可打开；
- 候选与目标 Literature 存在已知获取依据。

HTTP 200、浏览器 download event、provider API 成功、`.pdf` 扩展名和 OA 声明都不能直接形成 `Asset`。

### 6.4 浏览器是最后阶段，不等于盲目点击

Zotero 和两个本地参考都使用 provider/domain 特定 Translator、selector、URL 推导或页面信号。可借鉴的最小边界是：

- 从 DOI 或已保存 landing page 开始；
- 只在已允许 host 和 navigation budget 内运行；
- 先监听 response/download，再触发导航或点击；
- 下载事件只产生临时字节；
- 浏览器 Cookie、profile、header、签名 URL 和页面对象不进入 `PdfCandidate`、数据库或日志；
- 登录、MFA 或必须人工完成的 challenge 不能被普通自动流程解释成无条件可绕过步骤。

### 6.5 公开来源的内部顺序

当前目标顺序为：

1. 已保存且声明或未排除为主 PDF 的直接文件 `AssetHint`；
2. arXiv、Europe PMC 等公共全文服务；
3. Unpaywall、OpenAlex、Semantic Scholar 等 OA locator；
4. 普通 HTTP landing-page discovery。

同一 Literature 的 Source 串行短路；不同 Literature 可以在 Network 进程内共享准入下有界并发。具体 `VersionRole` 兼容规则和单一 resolver 的候选上限仍由后续实现讨论，不能破坏三阶段硬顺序。

### 6.6 进程内共享访问准入

路径层级决定 Acquisition 使用哪类能力，ADR 0012 的访问 scope 决定当前进程中的真实请求何时允许执行。二者正交：公开 `AssetHint` 指向出版社网页时仍使用该出版社的 `web` scope；同一 provider 网页普通 HTTP 与浏览器在当前进程独占，并在完整结束后至少冷却 30 秒；授权 API 使用独立 scope 并按供应商真实规则运行。动态限速状态只存在于内存，不提供跨进程或跨重启保证。正式长期边界见 [ADR 0012](../architecture/decisions/0012-process-local-provider-access-scheduling.md)。

### 6.7 不从参考项目复制的内容

本文不建议或授权复制：

- Zotero 私有 OA API；
- 第三方工具的固定字节数、页数、正文长度或版本验收阈值；
- shadow-library、代理轮换、Tor 或反检测路径；
- 读取、导出或持久化用户浏览器 Cookie；
- 根据历史速度让高成本浏览器与公开来源同时竞速；
- 把逐候选失败、浏览器登录状态或 provider pause 变成 Literature 的第二套状态。

## 7. 后续核对清单

实现三段式优先级与进程内共享访问准入时应逐项确认：

- [ ] “公开”“授权 Provider API”“受控浏览器”的归类规则唯一且不会由 provider 自行漂移；
- [ ] 一个 provider 的不同访问 adapter 可以独立启用、readiness 检查和退役；
- [ ] 前一阶段成功后，后一阶段尚未启动或能够被可靠取消且不能 late accept；
- [ ] 同层候选去重不会错误删除需要不同授权上下文的同 URL；
- [ ] 公开 landing page 的普通 HTTP/Translator 解析与真实浏览器访问边界清楚；
- [ ] 所有阶段共用 Network URL/DNS/redirect/origin/预算和脱敏政策；
- [ ] 所有 adapter 声明 provider/channel/service scope；Metadata 与 Acquisition 在当前进程共享真实 API quota，同一 provider 网页跨模块、批次和文献目标独占并至少冷却 30 秒；
- [ ] 所有阶段共用 Acquisition PDF 基本检查和不可变发布；
- [ ] 浏览器 profile、Cookie、header、短期签名 URL 和页面对象不进入业务 Model 或 durable state；
- [ ] 授权 API 的 key 存在、API entitlement 和目标内容 entitlement 没有被混为一项；
- [ ] 测试只使用本地受控页面和 fixture，不连接真实供应商、机构登录或用户语料。

## 8. 证据边界

- Zotero Full-Text Downloader 结论只适用于 2026-08-03 本地快照；该目录没有可用于说明上游版本的 Git commit，本轮以实际源码为准。
- ScanSci PDF 结论只适用于本地 checkout `5e4a6f2`；公开发行包可能包含当前源码树没有的构建产物。
- Zotero 结论以官方 `9.0.6` 和 Connector `5.0.211` 标签为准；主分支后续行为需重新核对。
- 本文没有测量真实成功率、覆盖率、下载速度、授权范围或站点稳定性。
- 本地参考项目的 README、技能说明和源码存在差异时，本文以当前源码行为为事实，并把文档声明只作为辅助证据。
