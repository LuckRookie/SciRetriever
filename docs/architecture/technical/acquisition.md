# Acquisition 模块技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 设计责任：[设计文档 4.4](../design.md#44-acquisition)
- 产品需求：[R3 文献资产获取](../requirements.md#r3-文献资产获取)
- 运行边界：[ADR 0013](../decisions/0013-decoupled-discovery-and-database-maintenance.md)
- Provider 与凭据：[ADR 0014](../decisions/0014-capability-scoped-providers-and-local-credentials.md)、[Configuration 技术文档](configuration.md)

本文定义目标 `src/sciretriever/acquisition/` 的 PDF 候选发现、下载、基本检查和当前主资产提交。下载阶段只确认文件和获取关系的基本有效性，不严格判断正文完整性。

## 1. 目标结构

```text
acquisition/
  api.py
  service.py
  manual.py
  rules.py
  ports.py
  sources/
```

- `api.py` 提供单个 `Literature` 的 PDF 获取操作；
- `service.py` 组织候选发现、尝试、基本检查和发布；
- `manual.py` 接纳用户明确绑定到具体 Literature 的本地 PDF 内部副本；
- `rules.py` 实现协议无关的 PDF 基本检查和当前主资产决定；
- `ports.py` 声明 asset source、临时获取、原子资产发布和自动获取耗尽事实 publication/clear 能力；
- `sources/` 保存来源专属 API 或浏览器适配器。

## 2. 输入与公开结果

### 2.1 自动获取

公开 API 接收具体 `Literature` 的中性 `LiteratureMetadata`、稳定标识符、当前 MetadataObservation 中的 Provider record identity 与 `AssetHint[]`、当前资产事实和本次运行临时排除的 candidate key 集合。它们只用于形成当前适用 Source 和候选，不把完整 vendor 对象带入 Acquisition。正常业务结果严格是二选一：

```text
AcquisitionResult =
    AcquiredPrimaryPdf
  | NoPrimaryPdf

AcquiredPrimaryPdf
  asset: Asset
  relation: LiteratureAsset
  candidate_key: str

NoPrimaryPdf
```

`AcquiredPrimaryPdf` 表示不可变 PDF 字节、该 Literature 的唯一 `primary-pdf` 关系和已有自动获取耗尽事实的清除都已经安全提交；只完成下载或临时检查不能返回它。`candidate_key` 仅供当前 Entry 操作更新内存 tried set，不进入持久化关系。

`NoPrimaryPdf` 是无字段结果，但只能在以下条件全部成立后返回：当前元数据和已配置自动能力下的公开来源、已授权 Provider API 与受控浏览器路径已经正常遍历；没有候选、正常返回“未找到”、浏览器流程正常结束但没有下载，或候选非 PDF、为空、损坏等预期未命中已经收敛；并且该 Literature 的 `AutomaticPdfAcquisitionExhaustion` 已经安全提交。它不暴露或持久化原因枚举与逐候选详情。

用户中断、Network 传输或 API 错误、权限或配置错误、数据库或文件系统无法安全提交、并发变化导致提交条件失效，以及共享 Network readiness/policy/coordinator 本身不可用，都属于本次操作失败而不是第三种 Acquisition 业务结果。这些问题必须保留脱敏异常链并交给 Entry 的错误边界，不能返回 `NoPrimaryPdf`，也不能建立耗尽事实。因此只有已经完整收敛并提交耗尽事实的 `NoPrimaryPdf` 可以支持 MetaLiterature 切换版本。

公开 API 不暴露 URL client、HTTP response、Browser page/download、临时绝对路径或来源私有对象。

### 2.2 手动 PDF 接纳

手动接纳是与自动获取并列的独立 API。Entry 必须先把用户选择解析为一个具体 `LiteratureId`，并以只读方式打开用户输入文件；Acquisition 把字节复制到 owner-only 临时文件后再执行统一检查。输入路径和文件 handle 是适配边界值，不进入 Pydantic 业务 Model、provenance 或 Catalog。

成功结果为：

```text
AcceptedManualPdf
  asset: Asset
  relation: LiteratureAsset
```

`relation.role` 必须为 `primary-pdf`，`relation.source_url` 为空，provenance 使用 `source_kind = "user"` 和稳定 `source_name = "manual-pdf"`，并以内部复制字节的 SHA-256 作为输入 hash。只有内部不可变 Asset 和唯一关系都已经提交后才能返回成功。

以下情况直接形成稳定输入验证错误，不返回 `NoPrimaryPdf`：用户文件不存在或不可读、基本 PDF 检查失败、目标 Literature 不存在，或者该 Literature 已有当前主 PDF。文件发布、事务或 stale 复检失败仍是系统错误。手动接纳不产生 `PdfCandidate`、candidate key、tried set 或 `AcquisitionPath`，因此没有第四个自动阶段，也不是 `AcquisitionResult` 的第三个分支。

Acquisition 只复制用户字节，不移动、改名、截断、覆盖或删除用户原文件。成功只形成 `ASSET_READY` 并清除已有自动获取耗尽事实；Parsing 与 Analysis 由后续独立数据库补全操作发起。

## 3. PdfSource Port 与三阶段

本节只描述自动获取。手动接纳不注册 `PdfSource`，也不进入下列阶段。

`PdfSource` 根据 `Literature` 的中性 `LiteratureMetadata`、稳定标识符、Provider record identity 和 `AssetHint` 判断自己是否适用，再形成并执行临时获取动作。一个外部机构可以具有多个独立 Source，例如 metadata 返回的公开线索、授权内容 API 和浏览器页面流程；它们共享 provider identity 和 Network，但不能挤进一个带大量可选参数的调用。

目标 Acquisition 能力范围覆盖：

```text
arxiv
crossref
semantic-scholar
openalex
europe-pmc
unpaywall
elsevier
springer
wiley
datacite
core
sci-hub
```

这里使用稳定 Provider key；`springer` 表示 Springer Nature，`sci-hub` 只表示 operator 明确配置且获准的 locator。这里的“覆盖”表示相应服务能够贡献 PDF 字节、直接 locator、落地页或受控内容路径，并不要求每个名称都复制一套下载 adapter。Crossref、OpenAlex、DataCite 等 Metadata adapter 已经给出 `AssetHint` 时，由通用公开 Source 消费同一线索；不为名称对称再实现只转发相同 URL 的 Source。Web of Science 和 OpenCitations 当前不作为原文来源。以上是目标矩阵，不证明当前代码或安装产品已经接入。

`direct` 只是消费已保存 locator 的通用公开 Source，不是 Provider；手动 PDF 是用户明确绑定 Literature 的独立接纳操作，也不是 Provider 或第四种 `AcquisitionPath`。

Acquisition 把每个 Source 放入一个且仅一个运行阶段：

```text
AcquisitionPath =
    "public"
  | "authorized-provider-api"
  | "controlled-browser"
```

阶段由 Acquisition 配置与对象图决定，不由 Provider 响应或 `AssetHint.access_status` 决定。Source 可以使用：

- 已持久化并在使用时重新验证的 URL；
- 稳定标识符对应的来源 API；
- 供应商记录提供的资产线索；
- 受控浏览器页面流程。

概念 Port 为：

```text
PdfSource
  name: str
  acquisition_path: AcquisitionPath
  is_applicable(
    metadata,
    identifiers,
    provider_record_identities,
    asset_hints,
    resolved_landing_origin
  ) -> bool
  acquire(
    literature,
    metadata,
    identifiers,
    asset_hints,
    excluded_candidate_keys
  ) -> zero-or-more TemporaryPdf
```

`is_applicable` 是无 I/O、无副作用的本地判断，只解释调用方已经提供的证据；它不能为了决定是否适用而偷偷请求 Provider。DOI landing origin 尚未知时，由公开阶段的通用 DOI 安全解析动作先经过 Network 取得，并只作为当前进程路由证据使用，不持久化为新的文献事实。Source 在发起每个真实请求前计算并检查 candidate key；失败动作在 Source 内清理并继续，不向公开 API 输出逐候选原因。Source 只产生临时结果，不能发布 Asset、建立 `primary-pdf` 关系或改变 Literature 状态。

Source 适用性证据按以下顺序解释：

1. 来源明确给出的 direct-file 或 landing-page `AssetHint`；
2. arXiv ID、PMCID、Elsevier PII 等来源明确的稳定定位；
3. MetadataObservation provenance 中的 Provider record identity；
4. DOI 经 Network 安全解析后的实际 landing origin；
5. publisher 字符串或单独 DOI 前缀只能产生待核实的弱候选，不能单独使内容 API 适用。

“谁返回元数据”不等于“谁拥有原文”。Scopus 返回 Wiley 文献时，不能仅因 observation 来自 Elsevier 就调用 Elsevier Content API；Crossref 返回 Elsevier 文献时，如果 DOI 实际安全落地到 Elsevier 且其它 readiness 满足，则可以调用适用的 Elsevier Source。

### 3.1 AssetHint 合同

`AssetHint` 表示 Metadata 供应商在一次 observation 中返回的单个资产访问线索。它不是已经下载的资产，也不是候选尝试记录。精确 schema 为：

```text
AssetHint
  url: str
  kind: AssetHintKind
  media_type: str | None
  asset_role: AssetRole | None
  version_role: VersionRole | None
  access_status: str | None
  license: str | None

AssetHintKind = "direct-file" | "landing-page"
AssetRole = "primary-pdf" | "supplementary-pdf" | "xml" | "html" | "supplementary"
VersionRole = "published" | "accepted-manuscript" | "preprint" | "other"
```

字段含义为：

| 字段 | 含义 |
|---|---|
| `url` | 供应商返回的绝对访问地址；同一 observation 中的不同地址分别形成不同线索 |
| `kind` | `direct-file` 表示供应商声明地址直接指向文件，`landing-page` 表示需要从页面继续发现或触发下载 |
| `media_type` | 供应商声明的媒体类型，例如 `application/pdf`、`text/html` 或 `application/xml`；未知时为空 |
| `asset_role` | 地址所指向的主 PDF、补充 PDF、XML、HTML 或其它补充资产；供应商没有明确说明时为空 |
| `version_role` | 地址所对应的正式发表版、作者接受稿、预印本或其它版本；供应商没有明确说明时为空 |
| `access_status` | 供应商在 `MetadataObservation.provenance.observed_at` 观察到的开放、受限或其它访问状态；使用开放字符串 |
| `license` | 供应商返回的许可证标识或许可证 URL；没有可靠信息时为空 |

Provider identity、provider record identity 和 `observed_at` 由所属 `MetadataObservation.provenance` 提供，不在每个 `AssetHint` 中重复。`AssetHint` 不保存请求 header、cookie、凭据或 vendor 私有对象；`url` 仍是不可信外部输入，每次 HTTP、redirect 或浏览器导航都必须重新经过 Network policy。

`kind`、`media_type`、`asset_role` 和 `version_role` 都是供应商声明的线索，不是 Acquisition 已验证的事实。`access_status` 和 `license` 描述具体访问渠道，不属于 `LiteratureMetadata`；它们也不证明链接当前可访问、响应是 PDF 或内容有效。

### 3.2 候选与 Source 边界

`PdfCandidate` 表示当前运行中一次可识别、可排除的获取动作，不再假设所有动作都是一个可由通用 fetcher 直接请求的 URL。公开 URL、需要多步请求的 Provider API 和需要导航/点击/捕获的浏览器流程都由各自 Source 执行。候选精确合同为：

```text
PdfCandidate
  candidate_key: str
  source_name: str
  acquisition_path: AcquisitionPath
  declared_media_type: str | None
```

`PdfCandidate` 只存在于当前获取运行中。`candidate_key` 是当前运行 tried set 使用的非空稳定键，不是资产 ID、数据库身份或跨运行失败记录；它由 source、path 和不含凭据的来源内定位身份确定。同一 URL 在匿名 HTTP、授权 API 和浏览器上下文中可以形成不同 key，因为三者可能取得不同字节。`source_name` 标识具体 Source，`acquisition_path` 只表达这次获取的访问阶段；`declared_media_type` 只是来源声明，不能替代字节检查。

候选不保存或暴露 URL query secret、请求 header、cookie、凭据、API object ID、浏览器对象、页面 action 或其它 vendor 私有值，也不携带失败原因。Source 私有定位与多步动作留在 adapter 边界，不能用裸字典或 vendor model 扩展 `PdfCandidate`。明确为补充材料、XML 或 HTML 的线索不会形成主 `PdfCandidate`；补充资产走独立角色，不得伪装成主 PDF。

Source 取得字节后向 Acquisition Service 交付 Port 内部临时结果：

```text
TemporaryPdf
  candidate: PdfCandidate
  content: bounded byte stream or owner-only temporary artifact
  safe_source_url: str | None
  provenance: Provenance
```

`TemporaryPdf` 不是业务 Model，不进入公开 API或数据库。`safe_source_url` 只在能够去除凭据、敏感 query 和 fragment 时提供；`provenance` 记录具体 source 和输入 hash，不复制 Cookie、header、浏览器 profile 或页面对象。普通 HTTP 直接下载、多步授权 API 和浏览器 download/response 捕获都必须交付同一种临时结果，随后由 Acquisition 执行统一 PDF 基本检查。

Acquisition 先从项目目标能力中筛出“生产 Source 已实现、普通配置已启用、凭据与 AccessPolicy readiness 通过、对当前 Literature 适用”的集合，再按以下硬顺序处理：

1. **公开来源**：先尝试 `kind = "direct-file"` 且声明或未排除为主 PDF 的 `AssetHint`，再按配置顺序尝试公共全文服务、OA locator 和普通 HTTP landing-page discovery；
2. **已授权 Provider API**：只调用 operator 已配置且 readiness 通过、并有强适用证据的内容 API Source；API key 存在、API 认证和目标内容 entitlement 分别判断；
3. **受控浏览器**：从 DOI 或已保存 landing page 开始，使用 provider/domain 专属页面规则和 operator-managed profile 捕获临时下载；登录、MFA 或 challenge 不解释为可以绕过的步骤。

前一阶段全部当前适用 Source 耗尽后才能启动下一阶段；阶段和 Source 之间不并发竞速。未启用或对当前 Literature 不适用的 Source 不属于本次耗尽集合。已启用但缺少生产实现、必需普通参数/凭据/AccessPolicy，或者运行时出现 Network、认证、授权、quota 和服务错误时，必须返回稳定失败，不能伪装成本次耗尽。明确标记为补充材料、XML 或 HTML 的线索不能作为当前主 PDF 接纳。供应商声明的 `application/pdf` 可以提高同阶段候选顺序，但不能替代实际下载和基本检查。任一候选完整提交后立即停止全部后续来源。

`AssetHint` 不增加 `acquisition_path`、`requires_browser` 或 `requires_authorization`。它保存来源当时声明的线索；同一线索可以先匿名尝试，之后由相应授权或浏览器 Source 使用，但每次真实访问仍受自己的 Network scope 和 candidate key 约束。

每个 `sources/<source>/` 负责 endpoint、请求字段、AccessScope 和供应商访问政策声明、quota/`Retry-After` 解释、候选解释、页面 selector、点击步骤和来源失败转换。普通 HTTP、API SDK 和浏览器执行必须经过 Network 的共享访问准入。

来源适配器不能把候选直接写成当前主 PDF，也不能执行 Literature 身份判断、正文语义判断或状态推进。

### 3.3 Asset 与 LiteratureAsset

候选通过基本检查后形成两个不同的持久化事实：

```text
Asset
  asset_id: AssetId
  sha256: Sha256
  size_bytes: int
  media_type: str
  path: RelativeArtifactPath

LiteratureAsset
  literature_asset_id: LiteratureAssetId
  literature_id: LiteratureId
  asset_id: AssetId
  role: AssetRole
  provenance: Provenance
  source_url: str | None
```

`Asset` 只描述不可变文件事实。`size_bytes` 非负，`path` 是配置存储根下的规范化相对路径；Asset 不携带 Literature ID、资产角色、当前状态、来源 URL、版本角色或 provenance。

`LiteratureAsset` 表达具体 Literature 与 Asset 的角色和获取来源。`source_url` 只在能够安全保留时保存规范化、脱敏 URL；凭据、敏感 query 和 fragment 不能进入。来源身份、观察时间和输入 hash 由关系的 `provenance` 表达。关系不复制 `Literature.version_role`，也不增加 `is_current`。

同一 Literature 最多存在一项 `role = "primary-pdf"` 的 `LiteratureAsset`；这项唯一关系本身就是当前主 PDF。补充角色可以有多个，但不驱动 Parsing、Analysis 或 Literature 状态。相同 Asset 字节可以被不同关系复用，文件事实和文献归属不能因此混为一个对象。

## 4. 获取流程

```text
Literature + 当前 LiteratureMetadata + AssetHint[]
  -> public Sources 串行尝试
       ├─ 全部耗尽：authorized-provider-api Sources 串行尝试
       │    └─ 全部耗尽：controlled-browser Sources 串行尝试
       ├─ Network/API/权限/配置错误或取消：终止本次获取，不形成耗尽
       └─ 任一 Source 取得 TemporaryPdf
            -> 执行统一 PDF 基本检查
                 ├─ 不通过：清理临时结果，继续当前阶段
                 └─ 通过：计算 hash，形成 Asset 与 LiteratureAsset
  -> Storage 不可变发布 Asset
  -> 原子提交唯一 primary-pdf 关系并清除已有耗尽事实
       ├─ 成功：AcquiredPrimaryPdf
       └─ 系统提交错误：抛出，不转换为 NoPrimaryPdf

全部当前自动路径正常结束且候选均未成功
  -> 提交 AutomaticPdfAcquisitionExhaustion(literature_id)
       ├─ 成功：NoPrimaryPdf
       └─ Storage 错误：抛出，不转换为 NoPrimaryPdf
```

一个候选正常未命中、没有浏览器下载、格式错误或基本检查失败时清理临时结果并继续其它候选，不把详情带入下一个候选或数据库。Network/API/权限/配置错误和取消意味着至少一条当前路径没有正常完成，必须终止或向上传播，不能在尝试其它候选后伪装成完整耗尽。不同候选可以有各自来源，但同一 `Literature` 只有一个主 PDF 驱动解析。候选通过基本检查并完整提交后立即形成 `ASSET_READY`，不等待正文内容判断。补充 PDF 或其它相关文件可以保存为补充资产，但不驱动 Parsing、Analysis 或 Literature 状态。

单个 Literature 内的 Source 和候选串行短路；Entry 可以有界并行处理不同 Literature。并发吞吐来自不同目标和不同 AccessScope，不来自同一文献的跨阶段竞速。等待 Network permit 不等于候选失败，不改变阶段顺序，也不形成新的 Acquisition 结果。

### 4.1 手动接纳流程

```text
具体 Literature + 只读用户文件
  -> 预检 Literature 当前没有 primary-pdf
  -> 复制字节到 SciRetriever owner-only staging
  -> 对 staging 副本执行统一 PDF 基本检查
       ├─ 不通过：删除 staging，返回输入验证错误
       └─ 通过：形成 Asset 与 source_kind=user 的 LiteratureAsset
  -> Storage create-if-absent 发布内部字节
  -> 事务内复检 Literature 和唯一 primary-pdf 条件
       ├─ 成功：建立关系、清除已有耗尽事实并返回 AcceptedManualPdf
       └─ 失败：系统错误；用户原文件保持不变
```

用户文件从始至终不属于 Storage staging 或 ArtifactStore，不参加对账与回收。只有复制后的内部字节可以在后续明确 `NoUsableContent` 清理中删除。

## 5. PDF 基本检查

自动获取和手动接纳的内部副本执行同一组基本检查：

1. 实际字节非空，并通过字节嗅探确认是 PDF，而不是空响应、HTML、JavaScript 或其它格式；
2. 标准 PDF reader 能够打开文件；
3. 页面树可读取且至少有一页；需要密码但没有可用密码、因而无法读取的加密 PDF 不能通过；
4. 自动候选来自目标 `Literature` 的 `AssetHint`、稳定标识符或已配置文献来源；手动文件由用户明确选择具体 Literature，两种路径都不能无依据地关联字节。

轻微不规范但仍能由 reader 正常打开并读取页面树的 PDF 可以接纳。检查失败时立即清理 `TemporaryPdf`，不形成 `Asset`、`LiteratureAsset` 或候选级失败事实，并继续下一个候选。

以下信号不能单独代表成功：

- HTTP `200`；
- Browser download event；
- `.pdf` 文件扩展名；
- HTTP `Content-Type`；
- 网页声称提供全文；
- 响应文件名或 Content-Disposition。

本阶段不比较标题、作者、年份或 DOI，不设置固定最小页数、最小字节数或正文字符数，也不判断是否提取到正文、是否只有封面、目录、标题/元数据、摘要、错误提示或正文是否完整。PDF 是否包含属于当前目标 Literature 的实际文献内容由 Analysis 根据 parser-neutral `ParserResult` 判断，不能写成 MinerU 专属规则。

## 6. 发布与并发复检

基本检查通过后，Service 形成独立 `Asset` 和 `LiteratureAsset` 发布请求。Storage 先不可变发布字节，再在短事务中复检：

- Literature 仍存在；
- 当前统一元数据仍与获取输入一致；
- 当前主 PDF 没有被另一结果替换；
- Literature 尚未具有与当前主 PDF 对齐的有效 `CONTENT_READY` 内容；
- 发布的文件 hash 与请求一致。

只有文件发布、唯一 `primary-pdf` 关系和已有自动获取耗尽事实清除都成功后，Service 才返回 `AcquiredPrimaryPdf`。Stale 结果拒绝建立关系并作为系统提交错误返回；已发布但未引用的相同内容由 Storage 对账处理。发布失败、事务失败、hash 冲突或 stale 都不能降级为 `NoPrimaryPdf`。

手动接纳走同一发布、耗尽事实清除和复检边界，但成功返回 `AcceptedManualPdf`。它还必须复检目标从调用开始到提交时都没有主 PDF；竞争产生主 PDF 时拒绝手动结果，不能覆盖。手动关系的 `source_url` 固定为空，机器绝对输入路径不参与去重键、hash 或 provenance。

全部当前自动路径正常结束且没有主 PDF 时，Acquisition 使用独立短事务幂等写入 `AutomaticPdfAcquisitionExhaustion(literature_id)`，成功后才返回 `NoPrimaryPdf`。用户明确重试该 Literature 时，Entry 通过 Acquisition 公开操作先清除该事实，再发起新的自动获取；清除失败属于 Storage 错误。该事实不携带来源、原因、候选、时间、次数或配置快照。

## 7. 无效内容清理协作

Analysis 返回结构有效且明确的 `NoUsableContent` 时，Entry 协调 Acquisition/Storage 撤销当前主 PDF 关系并删除 PDF、对应 ParserResult 和待验收结果，再继续其它候选。该结果表示 ParserResult 没有属于目标 Literature、足以说明该文献实际研究、论证、综述、讨论或报告了什么的内容；一页 PDF 不自动无效。

如果当前主 PDF 来自手动接纳，清理只作用于 ArtifactStore 中的 SciRetriever 内部副本、关系和派生结果；用户原文件不在数据库中，也绝不能由此流程删除。手动来源没有自动 candidate key，清理后是否再次手动接纳只能由用户明确发起。

清理后不保留该次 `PdfCandidate`、逐候选失败、无效决定、主 PDF 的 `LiteratureAsset` 或其获取 provenance；Asset 字节不存在其它有效关系时一并回收，存在其它关系时只删除当前 Literature 的关系。原始 `MetadataObservation` 及其 `AssetHint` 仍是先前已经取得的来源事实，不附加本次失败标记。本次 Report 只需要表达仍未获得可用内容。Entry 在本次运行的内存 tried set 中记录稳定 candidate key，避免立即选择同一候选；新运行不恢复 tried set，允许从当前元数据重新发现。ParserResult 乱码、截断、只剩资源引用或不足以判断，以及 Parser 或 LLM 调用失败，都不属于内容无效，必须保留 PDF。

一旦 Literature 已经形成与当前主 PDF 对齐的有效 `CONTENT_READY` 内容，普通候选发现不得自动替换该主 PDF。替换已接纳内容所依据的资产属于单独的显式产品变化，不由本候选循环隐式触发。

同次操作内再次获取仍从公开阶段开始，但跳过本次 tried set 中的 candidate key，因此会先耗尽剩余公开候选，再进入授权 API 和浏览器。后续新操作不恢复 tried set；如果该 Literature 已有自动获取耗尽事实，只有用户明确重试或新的 MetadataObservation 清除该事实后才会再次自动获取。新进程不恢复上一进程的 provider 冷却、`blocked_until` 或 API 窗口；当前进程仍在运行时，重试不能绕过 ADR 0012 的共享准入。

## 8. Network、凭据和资源

- Source adapter 使用 Network 的 HTTP 或 Browser；
- 普通配置只表达 Source 启用、顺序、产品与 AccessPolicy；Provider secret 由根级 configuration 从固定 `~/.sciretriever/credentials.toml` 私有解析，再由 Bootstrap 注入具体 Source；
- Source 的本地 readiness、真实认证和具体 Literature 全文 entitlement 是三个不同判断；`config test` 最多验证当前服务 readiness，不能证明任意文献可下载；
- Source 声明稳定 `provider_name`、`api`/`web` channel、必要的 `service_name`、允许 origin 和经过核对的访问政策；
- 所有 Source、Metadata、Parsing 和 Analysis 共用 `bootstrap.py` 为当前进程组装的 Access Coordinator；adapter 不建立局部 limiter，也不能让 vendor SDK 绕过准入；
- 同一供应商网页普通 HTTP 与受控浏览器共享 `web` scope，在当前进程最多一个活动流程，完整结束后至少冷却 30 秒；授权 API 使用独立 scope 并服从供应商真实规则；
- 公开 `AssetHint` 指向出版社网站时仍受该出版社网页 scope；不同来源落到同一最终 host 时还共享实际 host 预算；
- `Retry-After`、quota 响应和 `blocked_until` 由 adapter 解释、Access Coordinator 执行；等待 permit 不转换为 `NoPrimaryPdf`；
- 所有 redirect 和最终下载主机继续受 URL/DNS/origin policy；
- Provider quota 的含义属于 source adapter，进程内执行和 host 预算属于 Network，目标并发属于 Entry；
- PDF 响应使用有界流式读取和硬大小上限；
- 临时文件位于 owner-only 临时目录，并在成功、失败、取消后清理；
- 凭据不进入来源 provenance、URL、文件名、数据库或用户输出。

## 9. 验收

直接测试至少覆盖：

- 目标 Acquisition 矩阵按项目目标、生产实现、用户启用、readiness 和当前 Literature 适用性逐层选择；Web of Science/OpenCitations 不作为原文来源，已有 AssetHint 由通用公开 Source 消费而不复制转发 adapter；
- Source 本地适用性依次解释 AssetHint、来源稳定定位、Provider record identity 和安全解析后的 DOI landing origin；publisher 字符串、单独 DOI 前缀或 MetadataObservation 来源都不能独立证明内容 API 适用；
- Scopus 返回的 Wiley 文献不会误路由到 Elsevier Content API，而 Crossref 返回且 DOI 实际落地到 Elsevier 的文献可以选择就绪的 Elsevier Source；
- 实际字节非空、reader 可打开、页面树可读取且至少一页的 PDF 成功，轻微不规范但可正常读取的文件不被过度拒绝；
- 空响应、截断、损坏、非 PDF 字节和无可用密码的不可读加密 PDF 失败；
- HTTP 成功但内容错误不能接纳；
- `.pdf` 后缀、文件名、HTTP `Content-Type`、Content-Disposition 或 Browser download event 都不能替代字节与 reader 检查；
- 候选与 Literature 没有依据关系时拒绝；
- 自动 `AcquisitionResult` 只接受 `AcquiredPrimaryPdf` 或无字段 `NoPrimaryPdf`；没有候选、正常未命中、浏览器流程正常结束但无下载及无效 PDF 可以收敛到后者且不携带原因；Network/API/权限/配置错误、取消和共享 Network readiness/coordinator 错误向外传播，不能形成耗尽；
- `NoPrimaryPdf` 只有在三阶段全部当前路径正常结束且最小 `AutomaticPdfAcquisitionExhaustion` 已提交后返回；该事实只有 LiteratureId，不保存来源、原因、候选、时间、次数或配置快照；
- 手动 PDF 要求明确具体 Literature，先复制到内部 staging 再执行相同基本检查；成功返回只含已提交 Asset/LiteratureAsset 的 `AcceptedManualPdf`，且 provenance 为 user/manual-pdf、source URL 为空；
- 手动文件不存在、不可读、不是有效 PDF、目标不存在或已有主 PDF 时形成输入验证错误，不进入 `NoPrimaryPdf` 或第三个自动结果；竞争产生主 PDF 时拒绝而不覆盖；
- 手动接纳不创建 PdfCandidate、candidate key、tried set、第四个 AcquisitionPath 或输入绝对路径记录，只达到 `ASSET_READY`、清除已有自动获取耗尽事实，不自动继续 Parsing/Analysis；
- 成功、失败、取消、stale 和后续 NoUsableContent 清理均不移动、修改或删除用户原文件，只能清理 SciRetriever 内部副本；
- 文件发布、数据库提交、耗尽事实提交、hash 冲突或 stale 失败作为系统错误传播，不能返回 `NoPrimaryPdf`；只有 Asset、唯一 `primary-pdf` 关系和已有耗尽事实清除都提交后才能返回 `AcquiredPrimaryPdf`；
- `AssetHint` 的直接文件和落地页语义、可选字段及封闭角色被正确解析；
- 同一 Literature 的不同 `AssetHint` 分别保留 URL、媒体类型、资产角色、版本角色、`access_status` 和 `license`，且这些值不进入 `LiteratureMetadata` 或替代 PDF 基本检查；
- `PdfCandidate` 只存在于当前运行，只保存 candidate key、source、acquisition path 和声明媒体类型，不要求 URL，也不保存 header、cookie、凭据、API object、页面 action、私有对象或失败详情；补充材料、XML 和 HTML 不成为主 PDF 候选；
- 普通 HTTP、多步授权 API 和浏览器捕获都先形成相同的 `TemporaryPdf`，不能绕过统一基本检查；
- `Asset` 只保存不可变文件事实；`LiteratureAsset` 保存 Literature、角色、脱敏来源和 provenance，不复制 Literature version role 或增加 `is_current`；
- 公开直接主 PDF 线索优先；公开来源耗尽后才启动授权 Provider API，授权 API 耗尽后才启动受控浏览器，成功后不继续任何来源；
- 同一 Literature 的不同阶段和 Source 串行且不进入候选竞速，不同 Literature 可以在进程内共享访问准入下有界并发；
- 同一 provider 可以分别注册公开线索、授权 API 和浏览器 Source，阶段由 Acquisition 决定且不写入 `AssetHint`；
- header、cookie、凭据和 vendor 私有对象不能进入或随 `AssetHint` 持久化；
- 一个候选正常未命中或基本检查失败后继续下一个；Network/API/权限/配置错误和取消不能被后续候选掩盖为完整耗尽；
- 未启用或不适用 Source 不进入本次耗尽集合；明确启用但缺少生产实现、必需参数/凭据/AccessPolicy，或真实认证、授权、quota、服务失败都不能形成 `NoPrimaryPdf` 或自动获取耗尽；
- 同一 Literature 最多存在一个 `primary-pdf` 关系，且该唯一关系就是当前主 PDF；
- PDF 通过基本检查后立即形成 `ASSET_READY`，不等待 LLM 内容判断；
- 基本检查只验证非空实际 PDF 字节、reader 可打开、页面树至少一页和候选归属依据，不比较题名/作者/年份/DOI，不判断正文/摘要/目录/封面或学术内容，也不使用固定页数、字节数或正文字符数；
- 重复相同字节复用，不同字节不能覆盖；
- Stale metadata 或当前资产变化时拒绝发布关系；
- Browser 下载不能绕过基本检查；
- 同一供应商网页普通 HTTP/Browser 在当前进程跨模块、用户操作和文献目标独占，流程结束后至少冷却 30 秒；该供应商 API 和其它 provider scope 可以独立推进；
- Metadata 与 Acquisition 使用同一 API quota 时共享 scope；API `Retry-After` 和 quota 阻塞对所有调用方生效；
- redirect 到新的 provider/host 不能绕过目标网页 scope 或 host 预算，公开状态不形成限速豁免；
- 当前进程内的失败、超时和取消不能泄漏网页 permit 或清空仍有效的冷却/`blocked_until`；新进程不恢复这些动态状态；
- Analysis 明确返回 `NoUsableContent` 时完成清理并可继续候选；一页完整短文不因页数被直接判无效；
- 同次运行使用临时 tried set 避免立即重试，新运行允许重新发现且数据库不保存无效 candidate/source/decision；
- 新 MetadataObservation、成功自动或手动主 PDF、用户明确重试都会清除自动获取耗尽事实；全库自动补全默认跳过仍有该事实的 Literature；
- Parser/LLM 调用失败、ParserResult 乱码/截断/只有资源引用或无法判断时不删除 PDF；
- 无效候选不留下候选级长期详情；Analysis 明确无内容后的清理移除当前关系和无效资产信息，但不篡改原始 MetadataObservation/AssetHint；
- 已有有效 `CONTENT_READY` 内容时不自动替换主 PDF，补充资产不驱动 Parsing、Analysis 或状态。

凭据、readiness 和 `config test` 测试使用临时凭据文件、fake adapter 与本地 Network，不读取真实用户配置，也不访问真实供应商。

HTTP 和 Browser 测试使用本地受控站点，不连接真实供应商。
