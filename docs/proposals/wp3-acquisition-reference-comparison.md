+++
document_type = "proposal"
status = "under-review"
created = "2026-07-24"
updated = "2026-07-24"
+++

# WP3 全文获取三方方案对比

本文记录 Zotero、`scansci-pdf` 与 SciRetriever 目标架构在全文候选发现、下载执行、页面回退、浏览器会话、内容验收和资产保存方面的对比，作为 WP3 设计评审输入。

本文是评估记录，不描述当前已发布行为，也不授权修改已经批准的[文献库执行计划](../planning/literature-library-execution.md)。理想产品合同仍以[需求规格](../specs/requirements.md)和[系统设计](../specs/system-design.md)为准；当前实现覆盖见[实施进度](../governance/implementation-progress.md)。

## 1. 证据边界

- Zotero 结论来自 2026-07-24 对客户端提交 `ea4b301f733c3eb30d8a2a6e346687485b4e19cd`、translators 提交 `424cfbe720650d51f710f4d9cbf9f4118673c719` 和官方 translator 文档的核对。Zotero 托管 OA 服务的服务端排序不在已审计客户端代码中，因此不推断其内部实现。
- `scansci-pdf` 结论来自工作区参考快照提交 `5e4a6f20ee32b16c0fcb52e37b66ca7a0b31edc5`；该快照相对 SciRetriever 仓库根目录位于 `../../../third_party/scansci-pdf`。本次核对了其中的 `fetcher.py`、`sources/__init__.py`、`publisher_pdf_router.py`、`pdf_utils.py`、`browser_engine.py`、`publisher_batch.py` 和 `network.py`。
- SciRetriever 结论区分 2026-07-24 owner 确认的两级调度、批准 WP3 计划下的实现处置和当前代码事实。本文仍是对比提案，不取代 README 或实施进度。
- 三方没有在相同 DOI、凭据、网络、超时和成功判据下进行对照实验，因此本文比较架构和失败语义，不比较下载成功率。

## 2. 三方流程概览

### 2.1 Zotero

Zotero 有两条相关但不同的路径：保存当前网页时由 web translator 产生条目和附件；已有条目执行 Find Available File 时，由 attachment resolver 生成下载候选。

Find Available File 的默认 resolver 顺序为 `doi`、`url`、`oa`、`custom`。候选可以是直接文件 URL，也可以是 `pageURL`。当 `pageURL` 返回 HTML 时，Zotero 把 document 交给匹配的 web translator，从 translator 产出的附件中继续寻找 PDF。下载器限制候选数量，对单个 URL 做有界退避重试，并通过内容 sniffing 只接受预期 PDF/EPUB，成功后导入 Zotero attachment storage 并关联条目。

这个方案的关键特征是 resolver 与 downloader 分离、候选数量有界、landing page 复用站点 translator，以及文件和文献库条目一体化。它的限制是客户端依赖 Zotero 托管 OA 查询，PDF 验收侧重文件类型，没有提供 SciRetriever 所需的内容寻址不可变证据链和强文章身份验证。

### 2.2 `scansci-pdf`

`scansci-pdf` 当前存在两套获取编排：

1. `PaperFetcher.fetch()` 依次尝试缓存、开放来源、Elsevier API、DOI 解析、CARSI、出版社直链、browser 和机构访问。
2. `sources.fetch()` 先让 free sources 在 15 秒预算内竞速，失败后让 institutional sources 在 30 秒预算内竞速；两层结束后再等待 2 秒并扫描目录接收 late browser output。

它从 `citation_pdf_url`、链接、iframe、embed、object、script 和出版社路径规则中发现候选，并使用 publisher profile 构造或过滤 Elsevier、IEEE、APS、PLOS、MDPI 等站点的 PDF URL。浏览器层基于 CloakBrowser/Playwright，支持持久 profile、登录态、cookies/localStorage、响应捕获、browser fetch、DOM 链接发现和点击下载。

下载后检查 `%PDF-`、`%%EOF`、最小大小，并用大小和页数启发式拒绝疑似封面或 preview。其覆盖能力和机构会话能力较强，但两套编排存在重复语义；late capture 不满足真实 loser cancellation；文件名/JSON cache 不是内容寻址的不可变资产关系；文章身份核对只在部分 publisher router 规则中较强。

### 2.3 SciRetriever WP3 目标

SciRetriever 从 `WorkVersion` 的 primary PDF 资产缺口出发：

```text
WorkVersion primary PDF gap
  -> direct official + publisher + open + configured Sci-Hub race
  -> bounded landing-page translator after tier 1 exhaustion
  -> configured browser path after translator exhaustion
  -> content and article identity validation
  -> immutable RawAsset linked to WorkVersion
  -> optional XML / HTML according to config
```

所有路径必须经过 HTTPS 或获批等价 transport、DNS/redirect 检查、有限 timeout、有界读取、敏感 header 处理、内容与身份验证、不可变发布和 redaction。重复命令按 `WorkVersion`、资产角色和内容 hash 收敛；race loser 不得 late accept；失败以 overall reason/action 和脱敏 per-source details 表达。

## 3. 能力矩阵

| 维度 | Zotero | `scansci-pdf` | SciRetriever WP3 判断 |
|---|---|---|---|
| 产品中心 | 文献条目及附件 | DOI/URL 到本地文件 | `WorkVersion` 及其版本资产 |
| 候选模型 | resolver 产生 direct URL 或 `pageURL` | 多来源函数和 publisher profile 产生 URL，缺少单一稳定候选契约 | 定义 provider-neutral runtime candidate；可携带受控请求字段或 auth reference，但只持久化脱敏投影，并保持 resolver 与 executor 分离 |
| 第一层调度 | 静态 resolver 顺序和有限候选尝试 | free sources 竞速，随后 institutional sources 竞速；另一入口使用全顺序 pipeline | 保留已批准的同层进程内竞速，但明确 provider 竞速与 provider 内候选回退的关系 |
| Landing page | 匹配 web translator 后提取附件 | 通用 HTML 提取加 publisher-specific 规则 | 采用受限、fixture 驱动 translator；不执行任意页面脚本 |
| Browser | 普通浏览器/Connector 环境与受限 BrowserRequest | 持久 profile、SSO/机构登录、DOM 操作、响应捕获和反检测 | 独立 adapter，默认关闭，显式配置，凭据和 session 不进入 durable state |
| 候选上限与重试 | 下载器限制候选数量，并对 URL 做有界退避 | 来源级 timeout、网络重试和分层预算较多，但策略分散 | 在共享 executor 中定义候选预算、重试分类和 per-host 预算 |
| PDF 验证 | MIME/content sniff，接受预期文件类型 | magic、EOF、大小、页数/preview 启发式 | 保留现有强验证并增加目标文章身份核对；不得只信 MIME 或 URL |
| loser 行为 | 有界顺序尝试，不以目录扫描补收结果 | timeout 后仍有 late capture | 明确禁止 late accept；winner 接受后必须取消或安全排空 loser，且 loser 不能发布 |
| 存储 | attachment storage 与条目关联 | 输出目录、文件名和 JSON/文本索引 | hash 寻址的不可变 RawAsset，catalog 只存相对路径、hash、关系和 provenance |
| 诊断 | 面向附件创建和用户错误 | 来源标签、guidance 和部分 attempt 数据 | overall/per-source 稳定错误分类，所有 URL、query、header 和 session 信息先脱敏 |
| 许可边界 | Zotero 与 translators 为 AGPLv3 | Apache-2.0 | Zotero 只借鉴行为并清洁重实现；复用第三方代码前单独核对许可证和 NOTICE |

## 4. 可吸收设计

### 4.1 从 Zotero 吸收

1. resolver 只产生有限候选，下载、验证、重试和存储由共享 executor 负责。
2. 候选同时表达 direct URL 与 `pageURL`，并携带最小的 resolver、referrer policy、media hint 和 access method 元数据。
3. 同一 resolver 内支持多个候选顺序回退，避免第一个 location 失败后直接放弃该来源。
4. translator 只在直接路径耗尽后运行，并以站点 fixture 约束输出。

Zotero 托管 OA 服务、客户端附件目录模型和 AGPL 实现代码不直接进入 SciRetriever。

### 4.2 从 `scansci-pdf` 吸收

1. `citation_pdf_url`、标准 link/meta、受控 JSON、iframe/embed/object 和稳定 URL 模板的候选发现思路。
2. 声明式 publisher profile，以及补充材料过滤、DOI/PII/article-number 文章匹配规则。
3. PDF magic/EOF、大小和 preview 检查，作为现有 SciRetriever validation 的补充测试样本。
4. browser response capture、共享认证 context 和 publisher batch profile 的能力拆分方式。

两套顶层 pipeline、timeout 后目录扫描、mutable filename cache、凭据/session 混入通用流程和默认反检测行为不应吸收。

### 4.3 SciRetriever 必须保留

1. `WorkVersion` 资产所有权和 primary/supplemental role 边界。
2. secure transport、DNS pinning、重定向复检、有界读取和敏感 header 处理。
3. 内容 hash、create-if-absent 不可变发布、相对路径和 provenance/lineage。
4. race loser 不 late accept，失败与 PDF missing 不计为成功。
5. 前台显式 selector、Ctrl+C cooperative stop 和幂等 backfill，不恢复 task-centered durable control state。

## 5. 与当前 WP3 计划的对照

### 5.1 已经对齐

| 对比结论 | 当前计划状态 |
|---|---|
| 以版本资产缺口为目标，而不是下载 task/job | WP3 已明确切换为 `WorkVersion` 资产缺口 |
| direct race 后才运行 translator，translator 后才运行 browser | WP3、FR-11 和 system design 三处一致 |
| browser 必须显式配置并具有独立安全设计/fixture | 计划已有原则性要求 |
| 所有来源共享 validation、immutable acceptance 和 redaction | 计划验收门已明确 |
| loser 不得 late accept | 计划明确拒绝 `scansci-pdf` 式 late capture |
| primary PDF 与 XML/HTML 角色分开 | 计划和 FR-10/FR-11 已明确 |
| overall failure 与 losing-source diagnostics 分离 | 计划和 FR-12 已明确 |

因此，三方对比没有推翻 WP3 的三层总体顺序，也不要求回到旧 task-centered orchestrator。

### 5.2 已确认的两级调度

Owner 于 2026-07-24 确认第一层采用两级调度：配置的 providers 进行有界竞速；每个 provider 的 resolver 输出在 provider 内去重并按确定性顺序逐个交给共享 candidate executor，当前候选失败后才回退到下一个候选。全部 providers 的全部 URL 不扁平化为无界竞速。translator 和 browser 继续分别属于第二、第三层。

当前 `CandidateResolver`、`CandidateExecutor` 和 `WorkVersionAcquisitionService` 已落实该模型：入口、资产所有权、幂等选择和诊断均围绕 `WorkVersion` backfill，不依赖已删除的旧 task-centered orchestrator。

### 5.3 已落实的实现处置

Owner 于 2026-07-24 单独确认的是 5.2 的两级调度。以下细节不是逐项获得新的 owner 批准，而是在已批准 WP3 计划、安全边界和责任规格内完成的实现处置；当前行为以代码、README 和实施进度为准：

1. **候选字段边界。** execution URL、page URL、request header/query、referrer、auth-context reference 和 expiry 只存在于 runtime candidate；durable provenance 与 diagnostics 只保留脱敏投影。
2. **候选预算。** 每个来源在 resolver 输出校验、稳定排序和 URL/role 去重后最多执行 8 个候选；provider 内顺序回退，provider 间有界竞速。
3. **Translator 边界。** 仅解析固定静态 HTML whitelist：`citation_pdf_url`、受控 `link`、`iframe`、`embed`、`object` 和具有 PDF 证据的 `a`；不执行任意脚本，并要求精确 landing/PDF host allowlist。
4. **Browser session。** adapter 默认关闭；源 profile 必须是现有 owner-only 目录且位于 storage tree 外。每次 browser candidate execution 都在当前 invocation 内以 owner-only 临时目录制作有大小/文件数上限的副本，headless persistent context 只使用副本，不调用 `storage_state`，结束后清理；不支持交互登录或 CAPTCHA。
5. **文章身份。** exact DOI 或保守标题/作者/年份佐证可通过；明确 mismatch 和无法确认（包括无法确认的扫描件）都 reject，不进入 immutable acceptance，也不声称 OCR。
6. **候选诊断。** 输出和 catalog 只保存稳定、脱敏的来源/tier/candidate outcome、reason/action、winner 和 accepted asset reference；不保存原始 URL、query、header、profile/session 或响应正文。

## 6. 后续复核重点

后续 provider API、HTML 结构或 browser runtime 变化时，应复核 runtime-only 敏感字段、8 候选上限、静态 translator whitelist、精确 host allowlist、profile-copy 清理、身份拒绝规则和脱敏 diagnostics。任何放宽都必须先更新责任 spec、安全 fixture 和准入记录，不能仅修改 adapter。

## 7. 当前处置

已确认并实现现有 WP3 总体顺序和候选执行基础：provider 间进行有界竞速，每个 provider 内由共享 executor 对去重后的候选做确定性顺序回退；resolver 可进行有界 lookup/landing 请求，runtime candidate 可携带受控凭据引用或请求字段，但 durable diagnostics 必须脱敏。translator 作为第二层 resolver，browser 作为隔离的第三层 adapter。所有 winner 必须先通过内容和文章身份验证，再由现有不可变接收边界发布。

两级调度已经同步到责任规格和执行计划，具体实现处置见 5.3。本文仍保持 `under-review`，因为仓库的 proposal 状态表示评估材料生命周期，不用 `completed`/`accepted` 追踪实现完成；WP3 完成事实只记录在实施进度中。

## 8. 证据索引

### SciRetriever

- [需求规格 FR-10 至 FR-12](../specs/requirements.md#6-全文获取)
- [系统设计 Acquisition 流](../specs/system-design.md#5-acquisition-流)
- [WP3 执行计划](../planning/literature-library-execution.md#wp3版本全文获取与独立-backfill)
- `src/sciretriever/acquisition/`
- `src/sciretriever/network/secure.py`
- `src/sciretriever/storage/coordinator.py`

### `scansci-pdf`

- `../../../third_party/scansci-pdf/src/scansci_pdf/fetcher.py`
- `../../../third_party/scansci-pdf/src/scansci_pdf/sources/__init__.py`
- `../../../third_party/scansci-pdf/src/scansci_pdf/publisher_pdf_router.py`
- `../../../third_party/scansci-pdf/src/scansci_pdf/pdf_utils.py`
- `../../../third_party/scansci-pdf/src/scansci_pdf/browser_engine.py`
- `../../../third_party/scansci-pdf/src/scansci_pdf/publisher_batch.py`
- `../../../third_party/scansci-pdf/src/scansci_pdf/network.py`

### Zotero

- [Attachment resolvers and downloader](https://github.com/zotero/zotero/blob/ea4b301f733c3eb30d8a2a6e346687485b4e19cd/chrome/content/zotero/xpcom/attachments.js)
- [Document-to-attachment translator bridge and OA lookup](https://github.com/zotero/zotero/blob/ea4b301f733c3eb30d8a2a6e346687485b4e19cd/chrome/content/zotero/xpcom/utilities_internal.js)
- [Zotero translators](https://github.com/zotero/translators/tree/424cfbe720650d51f710f4d9cbf9f4118673c719)
- [Custom PDF resolvers](https://www.zotero.org/support/kb/custom_pdf_resolvers)
- [Translator attachments](https://www.zotero.org/support/dev/translators/coding#attachments)
