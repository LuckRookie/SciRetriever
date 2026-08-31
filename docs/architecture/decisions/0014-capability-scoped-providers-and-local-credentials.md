# ADR 0014：按能力接入 Provider 与本地凭据管理

- Status: Accepted
- Date: 2026-08-10
- Last amended: 2026-08-28
- Supersedes: none
- Superseded by: none
- Amends: [ADR 0012](0012-process-local-provider-access-scheduling.md)、[ADR 0013](0013-decoupled-discovery-and-database-maintenance.md)
- Amended by: [ADR 0015](0015-publisher-aware-tiered-pdf-acquisition.md)、[ADR 0017](0017-shared-agents-and-controlled-browser-agent.md)、[ADR 0021](0021-provider-model-registry-and-direct-task-selection.md)、[ADR 0022](0022-default-safe-source-selection-and-per-source-limits.md)
- Related: [ADR 0018](0018-fixed-user-configuration-home.md)、[产品需求](../requirements.md)、[设计文档](../design.md)、[配置与凭据技术文档](../technical/configuration.md)、[Metadata 技术文档](../technical/metadata.md)、[Acquisition 技术文档](../technical/acquisition.md)、[Provider Notes](../../notes/providers/README.md)

## 背景

SciRetriever 需要尽可能完整地接入已经确认可用的外部文献服务，但“外部机构”“元数据索引”“出版社”和“原文来源”不是一一对应的概念。Scopus 由 Elsevier 提供，却索引多家出版社的文献；Crossref、OpenAlex 和 Semantic Scholar 是聚合来源；Wiley 的已确认能力主要面向自己的内容。若系统依据 `LiteratureMetadata.publisher` 的自由文本直接选择 API，会受到名称差异、期刊转让、历史 DOI 前缀和聚合来源身份的影响，也会把“谁返回元数据”错误解释成“谁拥有原文”。

多家服务还要求 API key、机构 token 或产品 entitlement。密钥既要允许个人用户直接编辑，也要允许 CLI 安全配置和检查；但密钥、连通性测试与文献事实没有关系，不能进入 Catalog、ArtifactStore、provenance、Report 或日志。连接成功也不能证明用户对任意具体文献具有全文授权。

## 决策

### 1. Provider 只有两类产品能力

目标架构只建立两个不互斥的 Provider 能力集合：

1. **Metadata Provider**：按领域搜索或按稳定标识符查询文献元数据，并可选提供引用关系、参考文献原文和资产线索；
2. **Acquisition Provider**：为具体 Literature 发现或取得主 PDF 候选，可以使用公开 locator、已授权内容 API 或受控浏览器。

引用查询是 Metadata Provider 的可选能力，不建立第三类 Citation Provider。一个外部机构可以同时具有两个独立 adapter，也可以只实现其中一个；不能把两类输出和失败语义塞入一个具有大量可选方法的通用 Provider 接口。`direct` 和用户手动 PDF 不是 Provider：前者是对已有安全 locator 的通用公开 route，后者是独立用户接纳操作。

当前目标对已经确认具备领域检索能力的 Web of Science、Crossref、Semantic Scholar、arXiv、OpenAlex、Europe PMC、Elsevier/Scopus、Springer Nature、DataCite 和 CORE 提供生产 Metadata adapter。OpenCitations Meta 只按当前官方能力提供稳定标识符精确 lookup，并与其引用能力一起归 Metadata；在没有官方领域关键词搜索合同前不参加主题 DiscoveryRun。

当前目标对能够提供 PDF 字节、PDF locator、落地页或受控内容路径的 arXiv、Crossref、Semantic Scholar、OpenAlex、Europe PMC、Unpaywall、Elsevier、Springer Nature、Wiley、DataCite 和 CORE 提供对应 Acquisition 能力。Sci-Hub Source 默认关闭；operator 显式启用后使用随版本维护的 bundled mirror set，也可以用一到八个获准 HTTPS URL 完整覆盖 bundled 列表，全部 locator 继续遵守既有安全边界。Web of Science 和 OpenCitations 当前不作为原文来源。某个 metadata adapter 已经产生可用 `AssetHint` 时，可以由通用公开 route 消费，不要求为了名称对称再复制一套只转发同一 URL 的 adapter。

外部能力与政策会变化。新增、替换或撤下 Provider 只要仍落在这两个能力集合、使用相同中性合同并更新 Provider Notes，就不需要新增产品模块；不能因为目标矩阵存在就把尚未实现的 adapter 写成当前能力。

### 2. 领域发现调用全部已启用且就绪的搜索能力

> [ADR 0022](0022-default-safe-source-selection-and-per-source-limits.md) 将“用户启用”具体化为
> capability-scoped `Auto / Custom`：Auto 使用版本内置的默认安全集合，Custom 精确冻结用户列表；
> 原 `[discovery].metadata_scan_limit` 已移动为具有默认值的 `sources.metadata.limit`。本节的
> readiness、逐 Source 原始 item 计数和部分成功决定不变。

一次领域 DiscoveryRun 调用本次启用、生产 adapter 存在且 readiness 通过的全部 Metadata search 能力；各 Provider 仍分别遵守整个 Run 的原始 `scan_limit`。Provider 自己的覆盖范围决定结果，Springer Nature 只返回其覆盖内容、Scopus 可以返回多家出版社文献，都不要求 Entry 预先识别 publisher。

“项目支持”“用户启用”“凭据与 AccessPolicy 就绪”和“实际调用”是不同状态。明确启用但缺少必需凭据、生产 adapter 或 AccessPolicy 时在运行开始前形成稳定配置错误，不能静默跳过或伪装为零结果。真实调用后的单一 Provider 认证、授权、quota 或服务失败继续遵守多来源部分成功规则。

发现一篇 Literature 后仍不自动对它执行 `N × Provider` 逐篇精确补查，也不自动进入 Acquisition。Provider 的全面接入扩大可选择的来源，不改变 ADR 0013 的发现边界。

### 3. Acquisition 按证据识别访问方并规划，不按 publisher 字符串硬编码

Acquisition 对具体 Literature 读取已经接纳的稳定标识符、全部 MetadataObservation、Provider record identity 和 AssetHint，在当前进程形成不持久化的 `PublisherAccessResolution` 与 `AcquisitionPlan`。原文访问方、Metadata Provider 和页面平台分别表达；ACS、IEEE、RSC 等纯访问画像不需要伪装成 Metadata Provider 或创建不需要的 API 凭据 section。

Planner 优先使用调用前已有的 direct-file/landing-page `AssetHint`、arXiv ID/PMCID/PII 等稳定定位和 Provider record identity；已有明确公开路径时不为了识别出版社增加 DOI 请求。需要确认访问方且强证据不足时，由公开层安全解析一次 DOI landing。全部证据可用时的确认强度为：实际 landing origin、访问方自有 AssetHint origin、来源明确的稳定文章 ID、Provider record identity；publisher 名称或 DOI prefix 只能产生待核实弱候选，不能单独证明归属、授权、API 或 Browser 适用性。

MetadataObservation 来自 Scopus 不表示文献由 Elsevier 出版；Crossref 返回的文献也可以由 Elsevier、Wiley 或其它访问方获取。`PublisherAccessProfile` 统一描述访问方识别、公开路径、官方 API capability、Browser rule、风险组和会话组，具体 HTTP/API/Browser adapter 仍保持独立。Resolution、Plan 和 API/landing 产生的脱敏 route hint 只服务当前运行，不进入数据库或长期 provenance。用户拥有密钥、认证成功和具体文献全文 entitlement 是三个不同事实。

适用 routes 仍严格按公开来源、已授权 Provider API、受控浏览器三个风险层级短路；批量补全先让本次有界 cohort 完成公开层，再完成未解决目标的 API 层，最后只把允许升级的最小剩余集合交给按 Provider 风险组调度的 Browser。Planner 可以省略确定不适用的路线，不能自动提前 Browser。

Readiness 按本次实际 plan 区分项目支持、用户启用、静态配置就绪、当前 Literature 适用和当前 route 实际需要。缺少凭据或 readiness 失败不能形成 `NoPrimaryPdf` 或自动获取耗尽；支持但未配置的低风险 route 是否允许进入 Browser 必须由显式 Browser policy 决定并清楚报告。临时网络/API 错误、`429`、`Retry-After` 和 quota exhausted 不得通过自动切换 Browser 绕过。未启用且不属于本次当前能力的 route 不在耗尽集合中。

### 4. 唯一本地凭据文件

> [ADR 0021](0021-provider-model-registry-and-direct-task-selection.md) 已从当前凭据 schema 删除单例
> `[agents]`，模型 key 由按 Model Provider 命名的 `[providers.<provider>]` section 取代；旧
> `[agents]` 与 `[models.*]` 凭据现在作为未知 section 直接拒绝，不迁移、不恢复。下文对单例 `[agents]` 的描述只
> 保留原始决策的历史语境；Provider 与 MinerU 的 capability owner、owner-only 文件、origin
> 绑定、安全发布和 secret 不进入普通配置的决定不变。

生产只从用户主目录下的固定文件读取 Provider、共享 Agents 与远程 MinerU 密钥：

```text
~/.sciretriever/credentials.toml
```

目录必须为当前用户所有并限制为 `0700`，文件必须为当前用户所有的普通文件并限制为 `0600`。文件以稳定 Provider key 及固定 `[agents]`、`[mineru]` 为 section，每类当前只保存一套凭据；字段由已经实现的 adapter 依据官方合同声明。Provider section 只保存 API key、token、API metric 等认证材料；Agents/MinerU section 还保存用于防止错发的规范 origin。文件不保存启用状态、来源顺序、产品选择、database/edition、scan limit、普通 Base URL、访问政策、浏览器 profile、测试结果或时间。联系邮箱等非密钥设置继续属于普通配置。

用户可以直接编辑同一文件，也可以通过 CLI 安全修改。CLI 写入前完整解析和验证现有 TOML，拒绝未知 section、未知字段、空值、不安全所有权或权限；写入使用同目录 owner-only staging 和原子替换，不生成包含旧密钥的备份。核心服务同时改变普通 Base URL 与 secret 时，先验证两份 staging，再通过可恢复的过渡凭据顺序发布，保证进程中断前后的旧或新配置至少一套仍可运行。真实 secret 不进入可序列化 Model configuration；根级 configuration/bootstrap 边界只在当前进程解析并注入具体 adapter。

Agents/MinerU secret 与规范 origin 精确绑定；改变 Base URL 后旧 secret 不会被发送到新 origin，Network 跨 origin redirect 也不得携带认证。自定义 HTTP loopback Agent 服务与 loopback MinerU 不需要凭据。旧的 LLM/MinerU secret 环境变量不再是产品合同，不读取、不回退，也不自动迁移。

### 5. CLI 配置、状态与连通性测试

> [ADR 0021](0021-provider-model-registry-and-direct-task-selection.md) 将本节旧的全局
> `Providers & API Keys`/role 页面修订为单词级 `Models / Search / Download / Parse / Analyze /
> Browser / Status / Theme / Quit` 首页，并采用 Model Provider、完整 `provider/model` Model 与任务
> 直接选择；模型 key 在 Provider 对象页管理，文献来源的普通设置/key/test 在具体 Source 对象页
> 管理，MinerU 由 Parse Setup 管理。纯本地 status、只有显式动作才联网以及最小 probe 不形成文献
> 事实的决定不变。

目标 CLI 增加第六个一级命令 `config`：

```text
sciretriever config
sciretriever config status
sciretriever config test <provider|llm|browser-agent|mineru>
sciretriever config test --browser <publisher-access-key>
sciretriever config test --all
```

裸 `config` 打开统一交互配置中心，首页分为 `Models`、`Providers & API Keys`、MinerU、
Literature Sources/Access、Browser Runtime、Diagnostics/Status 与 Appearance。共享模型 connection
和 API key 分开管理；Models 只修改 Analysis/Browser role，不接收 secret。Provider 区继续提供
设置/更新、移除、返回和退出动作。设置动作使用不回显的交互输入收集当前可执行 adapter 声明的
必需和可选凭据；真实密钥不得作为普通命令参数。`config` 公开子命令只保留 `status` 和 `test`，
旧 `set/remove` 路径必须拒绝。TTY 界面支持主题、键盘导航、返回和长列表搜索，非 TTY 保留
确定性纯文本流程，`NO_COLOR` 强制单色。首页和 status 纯本地；外部测试集中为显式动作。
`status` 是纯本地检查，只显示凭据不需要、
已配置、部分配置、缺失、可选缺失或 adapter 尚不支持等安全状态以及各字段是否存在，绝不
显示、掩码显示或导出密钥值。

`test` 是用户明确发起的最小只读网络操作。Provider probe 通过 ADR 0012 的 Network 准入调用官方允许的最小 endpoint；Analysis model probe 只发送固定的极小严格 schema 内容，Browser model probe 只发送合成图片与封闭 generic tool，二者都不发送用户文献或真实页面；MinerU probe 只检查 health/release/protocol/profile，不上传 PDF。`--all` 汇总已启用 Provider、Analysis、MinerU，并只在已选择 Agent controller 时加入 Browser model，一个失败不阻断其它结果。测试不创建 DiscoveryRun、Literature、MetadataObservation、Asset、Report 或数据库事实，不下载并接纳 PDF，也不保存最后结果或时间。

全文测试最多证明凭据和内容服务的当前最小 readiness，不能证明任意文献 entitlement。测试错误在输出前稳定化和脱敏；请求仍受供应商限速、额度、`Retry-After`、安全 URL 和响应预算约束。测试、状态和凭据管理不读取或写入文献数据库。

## 结果

- Provider 能力覆盖可以扩展而不增加第三类供应商概念；同一机构的 metadata 和 acquisition 责任保持独立。
- 出版社自由文本不再成为外部访问路由真相，聚合索引与出版社内容 API 不会错误绑定。
- 用户可以实现、启用并测试尽可能完整的 Provider 集合，同时不会对每篇文献盲目调用全部出版社 API。
- 密钥文件是明文的本地个人凭据存储，其安全性依赖用户所有权和文件权限；当前不引入 OS keyring、加密 vault、多账户 profile 或远程 secret service。
- `config test` 消耗真实 Provider 的最小请求与额度，只能由用户显式执行；Harness、单元测试和安装后离线验收仍不得连接真实供应商。

## 不采用

- 依据 `LiteratureMetadata.publisher` 字符串或单独 DOI 前缀直接选择出版社 API；
- 因 MetadataObservation 来自某个聚合服务就默认使用该机构的内容 API；
- 建立独立 Citation Provider 模块或统一的大而全 Provider 接口；
- 把所有已实现 Provider 在每次运行中无条件调用，忽略用户启用、凭据、额度和适用性；
- 通过 `--api-key <value>` 等普通命令参数传递密钥；
- 同时维护 YAML、TOML、CLI 私有存储和数据库凭据副本；
- 在凭据文件中保存启用状态、测试结果、文献身份、运行状态或普通配置；
- 把连接测试成功解释为任意具体 PDF 已获授权。
