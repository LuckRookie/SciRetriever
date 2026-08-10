# ADR 0014：按能力接入 Provider 与本地凭据管理

- Status: Accepted
- Date: 2026-08-10
- Supersedes: none
- Superseded by: none
- Amends: [ADR 0012](0012-process-local-provider-access-scheduling.md)、[ADR 0013](0013-decoupled-discovery-and-database-maintenance.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[配置与凭据技术文档](../technical/configuration.md)、[Metadata 技术文档](../technical/metadata.md)、[Acquisition 技术文档](../technical/acquisition.md)、[Provider Notes](../../notes/providers/README.md)

## 背景

SciRetriever 需要尽可能完整地接入已经确认可用的外部文献服务，但“外部机构”“元数据索引”“出版社”和“原文来源”不是一一对应的概念。Scopus 由 Elsevier 提供，却索引多家出版社的文献；Crossref、OpenAlex 和 Semantic Scholar 是聚合来源；Wiley 的已确认能力主要面向自己的内容。若系统依据 `LiteratureMetadata.publisher` 的自由文本直接选择 API，会受到名称差异、期刊转让、历史 DOI 前缀和聚合来源身份的影响，也会把“谁返回元数据”错误解释成“谁拥有原文”。

多家服务还要求 API key、机构 token 或产品 entitlement。密钥既要允许个人用户直接编辑，也要允许 CLI 安全配置和检查；但密钥、连通性测试与文献事实没有关系，不能进入 Catalog、ArtifactStore、provenance、Report 或日志。连接成功也不能证明用户对任意具体文献具有全文授权。

## 决策

### 1. Provider 只有两类产品能力

目标架构只建立两个不互斥的 Provider 能力集合：

1. **Metadata Provider**：按领域搜索或按稳定标识符查询文献元数据，并可选提供引用关系、参考文献原文和资产线索；
2. **Acquisition Provider**：为具体 Literature 发现或取得主 PDF 候选，可以使用公开 locator、已授权内容 API 或受控浏览器。

引用查询是 Metadata Provider 的可选能力，不建立第三类 Citation Provider。一个外部机构可以同时具有两个独立 adapter，也可以只实现其中一个；不能把两类输出和失败语义塞入一个具有大量可选方法的通用 Provider 接口。`direct` 和用户手动 PDF 不是 Provider：前者是对已有安全 locator 的通用公开 Source，后者是独立用户接纳操作。

当前目标对已经确认具备领域检索能力的 Web of Science、Crossref、Semantic Scholar、arXiv、OpenAlex、Europe PMC、Elsevier/Scopus、Springer Nature、DataCite 和 CORE 提供生产 Metadata adapter。OpenCitations Meta 只按当前官方能力提供稳定标识符精确 lookup，并与其引用能力一起归 Metadata；在没有官方领域关键词搜索合同前不参加主题 DiscoveryRun。

当前目标对能够提供 PDF 字节、PDF locator、落地页或受控内容路径的 arXiv、Crossref、Semantic Scholar、OpenAlex、Europe PMC、Unpaywall、Elsevier、Springer Nature、Wiley、DataCite 和 CORE 提供对应 Acquisition 能力；operator 明确配置且获准使用的 Sci-Hub locator 继续遵守既有安全边界。Web of Science 和 OpenCitations 当前不作为原文来源。某个 metadata adapter 已经产生可用 `AssetHint` 时，可以由通用公开 Source 消费，不要求为了名称对称再复制一套只转发同一 URL 的 adapter。

外部能力与政策会变化。新增、替换或撤下 Provider 只要仍落在这两个能力集合、使用相同中性合同并更新 Provider Notes，就不需要新增产品模块；不能因为目标矩阵存在就把尚未实现的 adapter 写成当前能力。

### 2. 领域发现调用全部已启用且就绪的搜索能力

一次领域 DiscoveryRun 调用本次启用、生产 adapter 存在且 readiness 通过的全部 Metadata search 能力；各 Provider 仍分别遵守整个 Run 的原始 `scan_limit`。Provider 自己的覆盖范围决定结果，Springer Nature 只返回其覆盖内容、Scopus 可以返回多家出版社文献，都不要求 Entry 预先识别 publisher。

“项目支持”“用户启用”“凭据与 AccessPolicy 就绪”和“实际调用”是不同状态。明确启用但缺少必需凭据、生产 adapter 或 AccessPolicy 时在运行开始前形成稳定配置错误，不能静默跳过或伪装为零结果。真实调用后的单一 Provider 认证、授权、quota 或服务失败继续遵守多来源部分成功规则。

发现一篇 Literature 后仍不自动对它执行 `N × Provider` 逐篇精确补查，也不自动进入 Acquisition。Provider 的全面接入扩大可选择的来源，不改变 ADR 0013 的发现边界。

### 3. Acquisition 按证据路由，不按 publisher 字符串硬编码

Acquisition 对具体 Literature 读取已经接纳的稳定标识符、全部 MetadataObservation、Provider record identity 和 AssetHint，在当前进程形成不持久化的适用 Source 集合。路由证据按以下顺序使用：

1. 来源明确给出的 direct-file 或 landing-page `AssetHint`；
2. arXiv ID、PMCID、Elsevier PII 等稳定且来源明确的 Provider 专属定位；
3. MetadataObservation provenance 中的 Provider record identity；
4. DOI 经过 Network 安全解析后的实际 landing origin；
5. publisher 名称或 DOI 前缀只能作为产生候选的弱提示，不能单独证明归属、授权或最终适用性。

MetadataObservation 来自 Scopus 不表示文献由 Elsevier 出版；Crossref 返回的文献也可以由 Elsevier、Wiley 或其它适用 Acquisition Source 获取。每个 Source 必须先根据调用方已经提供的中性证据做无网络的适用性判断，只有适用、启用且 readiness 通过时才进行真实访问；DOI landing origin 尚未知时，由公开阶段的通用安全解析动作先经过 Network 取得，并只作为当前进程的路由证据。用户拥有密钥、认证成功和具体文献全文 entitlement 是三个不同事实。

适用 Source 仍严格按公开来源、已授权 Provider API、受控浏览器三个阶段串行短路。缺少凭据或 readiness 失败不能形成 `NoPrimaryPdf` 或自动获取耗尽；未启用且不属于本次当前能力的 Source 不在耗尽集合中。

### 4. 唯一本地凭据文件

生产默认只从用户主目录下的固定文件读取 Provider 密钥：

```text
~/.sciretriever/credentials.toml
```

目录必须为当前用户所有并限制为 `0700`，文件必须为当前用户所有的普通文件并限制为 `0600`。文件以稳定 Provider key 为 section，每个 Provider 当前只保存一套凭据；字段由已经实现的 adapter 依据官方合同声明。它只保存 API key、token、API metric 等认证材料，不保存启用状态、来源顺序、产品选择、database/edition、scan limit、endpoint、访问政策、浏览器 profile、测试结果或时间。联系邮箱等非密钥设置继续属于普通配置。

用户可以直接编辑同一文件，也可以通过 CLI 原子修改。CLI 写入前完整解析和验证现有 TOML，拒绝未知 Provider、未知字段、空值、不安全所有权或权限；写入使用同目录 owner-only staging 和原子替换，不生成包含旧密钥的备份。手工编辑和 CLI 不形成两套凭据来源。真实 secret 不进入可序列化 Model configuration；根级 configuration/bootstrap 边界只在当前进程解析并注入具体 adapter。

### 5. CLI 配置、状态与连通性测试

目标 CLI 增加第六个一级命令 `config`：

```text
sciretriever config set <provider>
sciretriever config remove <provider>
sciretriever config status
sciretriever config test <provider>
sciretriever config test --all
```

`set` 使用不回显的交互输入收集 adapter 声明的全部必需和可选凭据；真实密钥不得作为普通命令参数。`remove` 只删除相应 section。`status` 是纯本地检查，只显示凭据不需要、已配置、部分配置、缺失、可选缺失或 adapter 尚不支持等安全状态以及各字段是否存在，绝不显示、掩码显示或导出密钥值。

`test` 是用户明确发起的最小只读网络操作。它先执行本地状态与 readiness 检查，再通过 ADR 0012 的 Network 准入调用 Provider 官方允许的最小 endpoint，分别报告网络可达、认证接受、API 产品可用和最小响应可解析等当前结果。`--all` 只测试已启用、生产 adapter 存在且本地凭据满足要求的能力；缺少必需凭据的能力明确跳过。测试不创建 DiscoveryRun、Literature、MetadataObservation、Asset、Report 或数据库事实，不下载并接纳 PDF，也不保存最后结果或时间。

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
