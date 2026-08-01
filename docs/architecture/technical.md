# SciRetriever 技术设计

- 产品依据：[产品需求](requirements.md)
- 设计依据：[设计文档](design.md)
- 稳定原则：[架构原则](principles.md)
- 重要决策：[架构决策](decisions/README.md)

本文把[设计文档](design.md)已经确认的系统分层、模块和责任映射为 Python 目录、import 方向、端口、数据与事务边界、运行技术和机械验收规则。本文不重新定义业务模块，也不记录当前代码清单、迁移进度或工作包；当前已发布行为仍以项目 `README`、源码和测试为准。

## 1. 技术起点

设计文档已经确定模块化单体、六层结构、七个业务模块和七类功能模块。技术实现使用 Python 与 Ports/Adapters 落实这些边界：

- Python 3.10+，开发基线 Python 3.12；
- 一个可安装的 `sciretriever` 包和一个前台 CLI composition root；
- `model` 统一保存纯数据定义，`core` 保存纯业务规则，`services` 编排应用用例；
- `infrastructure` 实现 SQLite、文件系统、外部来源、HTTP、浏览器、parser、LLM、书目文件和本机锁；
- `interface` 只处理用户交互，`composition` 是唯一配置和依赖组装入口；
- SQLite 通过 Python 标准库 `sqlite3` 访问，不使用 ORM；
- SQLite 保存关系事实、事务、当前指针和统一读取视图；
- 同一配置存储根下的文件系统保存不可变 PDF、轻结构化文档和分析产物；
- 一个主机、一个 catalog 同时只允许一个修改核心文献事实的执行；
- 查询和只读导出可以并行读取已经提交的事实；
- 不引入常驻 SciRetriever daemon、分布式 worker 或外部工作流平台。

SQLite 与文件系统组成一个逻辑文献数据库，但拥有不同物理责任。SQLite 不保存大型 BLOB；文件系统对象通过相对路径与 SHA-256 关联到数据库事实。

### 1.1 技术原则

1. 数据定义、业务判断、用例编排和技术实现分别属于不同层。
2. 一个可变业务事实只有一个业务写入所有者。
3. 文献版本的可用程度只从已经提交的权威事实推导，不维护第二个工作流状态。
4. 外部输入先在 interface 或 infrastructure 边界完成结构解析，再交给 core 判断业务有效性。
5. 网络、浏览器、parser 和 LLM 调用不在 SQLite 事务中执行。
6. 文件先不可变发布，SQLite 后建立引用；失败只能留下不可见孤儿，不能产生缺失文件的有效引用。
7. 每个目标按阶段使用短事务提交；单个目标失败不回滚其它目标。
8. `model` 使用 Pydantic 执行结构解析和序列化；指定边界模型可以用受控 validator 完成纯格式与结构转换，但不执行业务合法性判断、业务规范化、I/O 或业务逻辑。
9. 端口由消费它的 service 所有，基础设施只能实现端口，不能反向定义业务合同。
10. 代码中的目录、状态名、CLI 和批量机制只能服务需求，不能反向成为产品需求。

## 2. 目标代码结构

```text
src/sciretriever/
  model/
    primitives.py
    literature.py
    collection.py
    assets.py
    documents.py
    analysis.py
    library.py
    execution.py
    access.py
    sources.py
    parsing.py
    llm.py
    record.py
    configuration.py
    document_package.py

  core/
    collection/
    literature/
    assets/
    documents/
    analysis/
    library/
    execution/

  services/
    collection/
    literature/
    assets/
    documents/
    analysis/
    library/
    execution/

  infrastructure/
    storage/
      sqlite/
      files/
    access/
      policy/
      http/
      browser/
    sources/
      metadata/
      citations/
      assets/
    parsers/
      mineru/
    llm/
    io/
      bibtex.py
      ris.py
      csl_json.py
    locking/

  interface/
    cli/
      commands/
      presenters/

  composition/
    configuration/
    wiring/
    main.py
```

框架建立阶段可以先创建 `__init__.py` 和必要的 `.py` 占位文件，但占位不得导出虚假 API、声明未实现行为或进入用户文档。

## 3. 设计到代码映射

六个系统层分别映射为一个一级 Python package：

| 系统层 | Python package | 技术约束 |
|---|---|---|
| Model | `sciretriever.model` | 声明 Pydantic 纯数据，通过内建能力和受控边界 validator 执行结构解析，不执行普通自定义方法、业务判断、业务规范化或 I/O |
| Core | `sciretriever.core` | 只实现纯业务函数和决定，不引用端口或技术类型 |
| Services | `sciretriever.services` | 公开用例 API、调用 core、声明并消费 ports |
| Infrastructure | `sciretriever.infrastructure` | 实现 ports 和技术子系统，不改变业务含义 |
| Interface | `sciretriever.interface` | 解析 CLI 输入并呈现 service 结果 |
| Composition | `sciretriever.composition` | 解析运行来源、选择实现并构造对象图 |

### 3.1 `model` 数据文件

| 文件 | 数据范围 |
|---|---|
| `primitives.py` | 内部 ID、SHA-256、UTC 时间、相对路径和封闭枚举 |
| `literature.py` | 文献、文献版本、来源元数据、统一元数据、版本关系、引用和标签 |
| `collection.py` | 收集定义、收集执行、成员归属、发现原因和引用路径 |
| `assets.py` | 资产候选、临时获取结果、已验收资产和资产关系 |
| `documents.py` | 轻结构化文档、块、章节、表格、公式和 source locator |
| `analysis.py` | 九类结构化分析、最终元数据提案、引用提案和标签提案 |
| `library.py` | 查询、筛选、详情、整理决定和导出选择 |
| `execution.py` | 执行范围、实际目标、逐目标结果、摘要和当前失败 |
| `access.py` | HTTP 与浏览器访问请求、结果和脱敏失败数据 |
| `sources.py` | metadata、citation 和 asset 来源的中性输入输出 |
| `parsing.py` | parser 请求、结果和 provenance |
| `llm.py` | LLM 请求、结构化响应和 provenance |
| `record.py` | BibTeX、RIS、CSL JSON 导入导出的中性记录与逐条结果 |
| `configuration.py` | 完成边界解析后的运行配置数据 |
| `document_package.py` | 预留未来完整快照合同，目前保持空占位 |

`model` 可以按规模进一步拆文件，但仍是一个统一数据层。SciRetriever 的结构化数据模型统一使用 Pydantic，不使用 dataclass 建立第二套内部值对象机制；其它层也不得另建平行的 DTO、schema model 或 vendor model 作为内部业务合同。边界 model 可以通过 validator 完成纯结构验证、格式转换、不可变容器转换和跨字段结构约束；canonical/domain model 默认只使用 Pydantic 内建字段解析。除受控边界 validator 外，所有 model 都禁止自定义 serializer、自定义 `__init__`、`model_post_init`、普通自定义方法和 property；Pydantic 内建解析与序列化能力不受此限制。身份、precedence、状态、evidence 含义和其它权威业务判断由 Core 独占解释与决定，Services 只编排用例并提交 Core 已确认的决定。这些语义责任通过风险触发的独立审查和行为测试验证，不由项目自有 AST 检查器推断。

### 3.2 业务模块路径

设计文档定义的业务模块在 Core 与 Services 中使用相同名称：

| 系统业务模块 | Core 路径 | Services 路径 |
|---|---|---|
| Collection | `core/collection/` | `services/collection/` |
| Literature | `core/literature/` | `services/literature/` |
| Assets | `core/assets/` | `services/assets/` |
| Documents | `core/documents/` | `services/documents/` |
| Analysis | `core/analysis/` | `services/analysis/` |
| Library | `core/library/` | `services/library/` |
| Execution | `core/execution/` | `services/execution/` |

Core 目录只实现设计文档规定的业务决定。需要组合多个决定、访问外部能力或提交事实时，由同名 Services 模块完成。

### 3.3 Services 内部形状

每个 `services/<module>/` 可以包含：

- `api.py`：其它 service 和 interface 可以调用的公开用例；
- 按用例命名的编排文件；
- `ports.py`：该 service 消费的外部能力和持久化端口。

端口由调用者所有，禁止建立顶层共享 `ports/`、`repositories/` 或 `utils/` 包。

## 4. 依赖方向

### 4.1 允许的静态依赖

箭头表示 import 方向：

```text
core ----------------------> model

services ------------------> core
services ------------------> model

interface -----------------> services 的公开 API
interface -----------------> model

infrastructure ------------> 对应 services 的 ports
infrastructure ------------> model

composition ---------------> interface
composition ---------------> services
composition ---------------> infrastructure
composition ---------------> model.configuration
```

service 之间只允许以下方向：

```text
services.collection  ------> services.literature.api
services.library     ------> services.literature.api
services.execution   ------> 其它 feature service API
```

其它 feature service 不依赖 `execution`。资产、文档和分析按模型结果衔接，由 execution 或明确的单目标用例编排，不能形成循环调用。

### 4.2 强制规则

1. `model` 只能依赖 Pydantic 和 Python 标准库中的声明性类型能力。
2. `core` 和 `services` 不得导入 `infrastructure`、`interface` 或 `composition`。
3. 业务模块不得直接使用 `sqlite3`、SQL、绝对路径、HTTP response、Playwright、vendor SDK、环境变量或 TOML。
4. `infrastructure/storage` 只实现 service 定义的持久化端口，不执行身份、验收、状态或导出资格判断。
5. 外部来源、parser 和 LLM 实现只返回 `model` 中定义的中性数据，vendor 类型不能越过 infrastructure 边界。
6. `interface/cli` 只解析参数、调用 service API 并呈现稳定结果。
7. 只有 `composition` 可以读取配置来源、解析 secret reference、选择具体实现和构造对象图。
8. infrastructure 内部只允许明确的技术依赖，例如 provider、MinerU 和 LLM adapter 使用 `access`，不得形成反向依赖。
9. 跨模块调用只使用公开 service API 和 model 数据，不导入另一个模块的私有实现。
10. 任何完整快照或下游导出不得成为核心身份、状态或处理完成的前置条件。

## 5. 端口与组装

主要端口按消费者放置：

| 消费 service | 端口类型 |
|---|---|
| `collection` | metadata discovery、citation discovery、collection/literature acceptance |
| `literature` | literature repository、identity transaction、completion publication |
| `assets` | asset source、HTTP/browser acquisition、file publication、asset acceptance |
| `documents` | parser、document publication、document acceptance |
| `analysis` | LLM、analysis publication、completion acceptance |
| `library` | read model、bibliographic codec、import/export publication |
| `execution` | target selection、execution repository、write admission、clock |

跨业务所有者需要原子提交时，各 core 模块先形成已确认的纯数据决定，service 再调用一个明确的复合持久化端口。持久化实现可以在一个 SQLite 事务中写入多个所有者已经确认的事实，但不能在事务适配器内形成新的业务决定。

`composition/wiring` 负责把以下具体实现注入 service：

- raw `sqlite3` repository 与 publisher；
- 文件系统不可变发布；
- metadata、citation 和 asset source；
- secure HTTP 与受控浏览器；
- MinerU parser；
- LLM adapter；
- BibTeX、RIS 和 CSL JSON codec；
- 本机写锁、时钟和资源预算。

## 6. 文献可用程度

设计文档定义的四级文献版本状态保持为业务含义：

```text
UNREVIEWED
ASSET_READY
LIGHT_TEXT_READY
COMPLETED
```

状态不作为可独立修改的数据库字段。`core/literature` 根据事务一致的权威事实纯推导：

```text
COMPLETED
  if 存在对齐当前轻结构化文档、完整分析、最终元数据、引用和标签的完成证明

LIGHT_TEXT_READY
  else if 存在通过完整性验收且对齐当前主资产的轻结构化文档

ASSET_READY
  else if 存在已验收主文献资产

UNREVIEWED
  otherwise
```

执行记录、当前失败、parser task、FTS、孤立文件和未整体提交的 LLM 输出都不参与状态推导。SQLite 可以提供等价读取 view，但 SQL truth table 必须与 core 推导共享测试样例。

## 7. 持久化边界

### 7.1 SQLite 责任

`infrastructure/storage/sqlite` 保存：

- 收集定义、执行、归属、原因和路径；
- 文献与文献版本身份、版本关系和代表版本；
- 来源 metadata observation 和当前统一 metadata；
- 稳定标识符、引用集合、未解析引用和标签集合；
- 资产关系、当前主资产和 provenance；
- 当前轻结构化文档关系；
- 当前分析关系和完整完成证明；
- 执行、实际目标、逐目标结果、摘要和当前失败；
- 可重建的统一读取 view 与 FTS5 索引。

SQLite 不保存 PDF、轻结构化文档正文或完整分析大对象。catalog 中的文件引用必须是配置存储根下的规范化相对路径，并同时保存 SHA-256、大小、类型、来源和关系。

### 7.2 文件责任

`infrastructure/storage/files` 保存：

- 已验收主文献 PDF；
- 补充资产；
- 完整轻结构化文档；
- 完整结构化分析产物。

文件使用内容寻址和 create-if-absent 发布。已接受对象不得原地覆盖；相同路径存在不同字节时必须保留冲突证据并拒绝发布。

### 7.3 连接策略

所有 SQLite 连接统一启用：

- `PRAGMA foreign_keys = ON`；
- WAL journal mode；
- 权威写入使用 `synchronous = FULL`；
- 有界 `busy_timeout`；
- UTC 时间；
- 确定性 JSON 序列化；
- 查询和导出使用 read-only/query-only snapshot；
- 一个事务只覆盖一次明确业务提交。

### 7.4 必须整体提交的事务

以下更新必须在一个 SQLite 事务中整体成功：

1. 来源 observation、身份结果、统一初始元数据和收集归属；
2. 导入记录形成的初始元数据、引用、标签和逐记录结果；
3. 主资产关系、对应执行进度和同一步骤失败清除；
4. 轻结构化文档关系、主资产对齐、执行进度和失败清除；
5. 完整分析、最终元数据、引用、标签、完成证明和最终目标结果；
6. 身份合并或版本整理涉及的来源、收集归属和引用关系转移；
7. 删除具体文献版本或整个文献时的全部关系变化；
8. 单个逐目标失败或结果；
9. 一次执行摘要。

网络、浏览器、parser、LLM 和文件 staging 均发生在事务外。提交前必须重新检查预期文献版本、metadata、主资产和轻结构化文档 ID/hash，拒绝 stale 结果。

## 8. 不可变文件发布

SQLite 与文件系统没有跨介质事务，因此采用“先发布不可变文件，后建立数据库引用”：

1. 在 owner-only 临时目录写入产物；
2. flush、`fsync` 并验证大小、格式和 SHA-256；
3. 使用 create-if-absent 发布到内容寻址相对路径；
4. 目标已存在时验证字节完全一致；
5. `fsync` 目标目录；
6. 开启短 SQLite 写事务并复检输入 ID/hash；
7. 建立文件关系、当前指针和对应完成证明；
8. 更新读取 view 与 FTS 后提交。

SQLite commit 前崩溃最多留下无引用孤儿。对账只能在获得同一核心写锁后清理无任何数据库引用的正式对象，不能接触活动 staging，也不能删除仍被其它关系引用的相同字节。

## 9. 外部访问子系统

`infrastructure/access` 是统一管理外部访问安全和执行机制的技术子系统：

```text
access/
  policy/
  http/
  browser/
```

### 9.1 共享访问政策

`access/policy` 负责：

- URL 规范化、scheme、port 和 userinfo 限制；
- DNS 解析结果和公网/私网/loopback 分类；
- redirect、origin 和 credential forwarding 决定；
- header、query、URL 和错误详情脱敏；
- 响应大小、导航数量和访问资源边界。

policy 不理解 Crossref、出版商、MinerU 或 LLM 协议，也不决定资产是否属于目标文献。

### 9.2 HTTP

`access/http` 负责 HTTPS、TLS、DNS pinning、连接池、逐跳 redirect 复检、timeout、有界流读取和协议无关的幂等连接级重试。API pagination、429 解释、provider quota、MinerU polling 和 LLM retry 由对应 adapter 负责。

### 9.3 浏览器

`access/browser` 负责浏览器进程、隔离 context、operator-managed profile、请求拦截、导航、下载捕获、资源上限和完整清理。它与 HTTP 使用相同 policy，但不属于 HTTP transport。

来源专属 selector、点击顺序、登录状态判断和目标页面识别放在 `infrastructure/sources/assets/<source>/`。浏览器下载事件只产生临时资产结果，不能直接成为已验收资产。若浏览器无法执行等价的 URL、redirect 和目标地址安全政策，访问必须 fail closed。

### 9.4 调用方向

```text
sources.metadata  -> access.http
sources.citations -> access.http
sources.assets    -> access.http and/or access.browser
parsers.mineru    -> access.http
llm               -> access.http

access.http       -> access.policy
access.browser    -> access.policy
```

`core` 和 `services` 不得看到 URL、HTTP response、header、cookie、Playwright 或浏览器页面类型。

## 10. 外部能力模块

### 10.1 文献来源

`infrastructure/sources` 按能力分为 metadata、citations 和 assets：

- 一个供应商共享一个 client/session；
- source adapter 负责 endpoint、请求参数、分页、provider budget 和响应转换；
- provider response 在边界转换为 `model/sources.py` 中性数据；
- adapter 不执行文献身份合并、资产验收或状态推进；
- 单一来源失败不能撤销其它来源已经形成的有效 observation。

### 10.2 Parser

`infrastructure/parsers/mineru` 只实现 operator-managed MinerU 协议：提交、有限 polling、结果获取和中性转换。SciRetriever 不启动、停止、升级或拥有 MinerU 服务。返回 URL、归档、路径、symlink、JSON、页码、坐标、文本和图片均按不可信输入处理。

### 10.3 LLM

`infrastructure/llm` 负责具体 LLM provider/model 协议、请求映射、API 失败和响应结构解析。LLM 只接收已经验收的完整轻结构化文档；任何缺字段、截断、越界、未知结构或输入不对齐都不能形成有效分析。

### 10.4 对外记录 I/O

`infrastructure/io` 固定实现：

- BibTeX/BibLaTeX；
- RIS；
- CSL JSON。

codec 只负责外部文件与 `model/record.py` 中性记录之间的转换。导入接纳、身份处理、导出资格和字段取舍属于 `core/library`；导入导出流程属于 `services/library`。

## 11. 执行与并发

### 11.1 写入准入

一个主机、一个 canonical catalog path 对应一个核心写 advisory lock。主题收集、引用收集、书目导入、身份整理、删除、内容推进以及文件对账在形成实际目标前必须非阻塞获得同一个独占锁。冲突立即返回稳定结果，不排队等待。

锁由平台适配的 OS advisory lock 实现，进程退出或崩溃时由操作系统释放。锁可以覆盖一次完整写执行，但 SQLite 事务始终保持短小。

### 11.2 目标执行

`services/execution` 负责：

1. 从用户范围和当前权威事实形成实际缺失目标；
2. 排除已经满足目标的文献版本；
3. 按每个目标当前缺失步骤调用对应 service；
4. 每个阶段成功后立即持久提交；
5. 保存逐目标结果、当前失败和最终摘要；
6. 中断时停止启动新目标并保留全部已提交事实。

执行内部可以并行等待不同文献的网络、浏览器、parser 或 LLM 操作，但 SQLite commit 通过一个进程内提交队列串行完成。跨目标并发属于 execution；每 host 连接预算属于 access；provider quota 属于对应 source/parser/LLM adapter。

### 11.3 崩溃恢复

进程硬崩溃后，下一次写执行获得锁并结束遗留的 RUNNING 执行。恢复只比较开始事实、started 标记、目标状态和当前权威事实，不恢复旧队列、线程、HTTP 请求、浏览器页面、parser 调用或 LLM 调用。

MinerU external task ID 只能作为一次 parser attempt 的有限恢复句柄，不能扩展为通用任务中心。

## 12. 查询、导入与导出

查询通过 service port 使用 SQLite read-only snapshot 和统一 read model。普通查询不回放身份算法，也不根据执行或失败记录推导文献状态。FTS5 覆盖当前统一元数据、当前轻结构化文档和当前结构化分析。

导入按记录独立处理：

```text
io codec
  -> model.record 中性记录
  -> core.library 结构与导入规则
  -> core.literature 身份和统一元数据决定
  -> services.library 原子提交文献事实与逐记录结果
```

导出不要求文献进入 `COMPLETED`。只要已经形成可转换的当前统一元数据，就可以导出为 BibTeX/BibLaTeX、RIS 或 CSL JSON。导出使用一致 read-only snapshot，写入同目录 owner-only staging file，flush、`fsync` 后原子替换目标文件；用户不会观察到部分输出。

Zotero 等外部工具通过这些书目文件交换，不共享内部 ID、数据库、同步状态、附件路径或工具私有字段。

## 13. 配置、凭据与诊断

`composition/configuration` 是唯一 TOML、环境变量和 secret reference 解析入口。未知 section、key、枚举或组合必须 fail closed；composition 读取不可信来源并交给 `model/configuration.py` 的 Pydantic 类型完成结构解析，再执行跨字段和运行环境规则，最后构造 service 或 infrastructure 实现。

配置至少按以下责任分组：

```text
paths
collection
sources
assets
parsing
analysis
execution
library
access
credentials
```

secret 值不得进入 model configuration、SQLite、provenance、diagnostics、URL、文件名或用户输出。composition 只把短生命周期凭据注入具体 adapter；adapter 决定允许附着凭据的 origin；access 执行 redirect stripping 和脱敏。

所有外部失败在 durable write 和用户输出前转换为稳定、脱敏的 reason/action。底层异常文本只能作为边界内诊断输入，不能成为持久业务合同。

## 14. DocumentPackage 占位

`DocumentPackage` 不是当前核心需求，也不是 Zotero 书目信息交换格式。现阶段只保留空的 `model/document_package.py` 作为未来完整文献快照合同的命名占位：

- 不从 `model/__init__.py` 重导出；
- 不建立 core 规则或 service；
- 不建立数据库表、文件命名空间或 CLI；
- 不参与文献状态、查询、书目导出或完成条件；
- 只有出现明确的离线完整快照、跨机器传递或历史复现需求后才激活。

[ADR 0005](decisions/0005-document-package-2-breaking-contract.md) 仍记录 Package 2.0 已接受的递归格式与不兼容边界，但该 ADR 不代表当前实现已经提供 Package，也不授权提前建设通用 extension 平台。后续设计复审需要重新确认 ADR 状态与真实消费需求是否一致。

## 15. 明确不采用的机制

- ORM；
- 让 model validator 执行业务判断、I/O 或副作用，或让 model 定义自定义 serializer、自定义 `__init__`、`model_post_init`、普通自定义方法和 property；
- 让 core 或 services 直接访问 SQLite、文件系统、HTTP 或浏览器；
- 顶层共享 `ports`、`repositories`、`utils` 或笼统 `integrations` 包；
- 把浏览器作为 HTTP transport 或让浏览器流程绕过访问 policy；
- 让 source、parser 或 LLM adapter 执行文献身份与最终验收；
- 可独立修改的文献状态列；
- 让执行、失败、attempt 或外部 task 决定文献可用程度；
- SQLite 长事务包裹网络、浏览器、parser、LLM 或整批执行；
- 分布式 queue、worker、lease、heartbeat、fencing token 或 network exactly-once；
- 自动 parser 竞赛、合并和失败回退；
- 通用 extension 平台；
- 下游直接依赖内部数据库表。

## 16. 架构验收

### 16.1 静态依赖检查

AST 架构门禁必须拒绝：

- 违反六层依赖方向的 import；
- 跨 feature 导入私有 core/service 实现；
- `infrastructure/storage/sqlite` 以外使用 `sqlite3` 或 SQL；
- `composition/configuration` 以外读取环境变量或 TOML；
- `composition` 以外构造具体 adapter；
- vendor SDK、HTTP、浏览器或 SQL 模块被 model、core 或 service 导入；
- provider-specific browser flow 进入 `access/browser`；
- DocumentPackage 占位被导入、导出或实现。

行为测试与风险触发的独立语义审查必须证明：

- vendor SDK、HTTP、浏览器或 SQL 类型没有进入 model、core 或 service API；
- Core 或 Services 不创建、覆盖最终文件；
- Infrastructure 不进行身份合并、业务验收、状态推导或导出资格判断；
- 静态 import 合法但通过间接调用、别名或动态值越过责任边界的实现同样会被拒绝。

### 16.2 状态与持久化检查

1. 穷举四级状态 truth table，并证明 Python core 推导与 SQL view 一致。
2. schema 拒绝同一文献版本多个主资产、跨版本文档关系和缺少组成项的完成证明。
3. execution、failure、attempt、FTS 或孤立文件变化不得改变状态。
4. 已满足目标的文献版本不得生成实际 execution target。
5. 已形成当前统一元数据但未完成内容处理的文献必须可以导出。

### 16.3 事务与崩溃检查

1. 对跨所有者事务每个写入点注入失败，读取连接只能观察完整旧视图或完整新视图。
2. 在文件 staging、发布和 SQLite commit 前后崩溃，所有已提交引用保持可读且 hash 一致。
3. 文件对账不能与 publication-before-reference 窗口并发删除对象。
4. 身份整理和删除不得暴露部分关系转移。
5. 共享文件仍被引用时不得回收。

### 16.4 Access 与安全检查

- HTTP 和浏览器使用相同 URL、DNS、redirect、origin 和 redaction policy；
- malformed URL、私网目标、越权 redirect、oversize、timeout 和 late response 不能成为有效结果；
- 浏览器 context、profile、page、download 和临时目录在成功、失败和取消后完整清理；
- provider 页面脚本不能直接发布或验收资产；
- 凭据不出现在日志、诊断、SQLite、文件名、provenance 或 CLI 输出。

### 16.5 离线产品验收

离线集成测试必须覆盖：

- 主题领域收集；
- 引用关系迭代收集；
- 多来源部分失败；
- 保守身份收敛和版本分离；
- HTTP 资产获取；
- 本地测试站点上的浏览器辅助资产获取；
- 主文献资产验收；
- 完整轻结构化文档发布；
- 九类结构化分析和最终信息整体提交；
- BibTeX、RIS、CSL JSON 导入导出；
- 查询和引用遍历；
- 局部失败、中断和重复执行。

测试、构建和架构门禁不得连接真实供应商、生产数据库或用户语料。

## 17. 需求追踪

| 产品需求 | 业务代码 | 技术实现 |
|---|---|---|
| R1 发起文献收集 | `core/collection`、`services/collection`、`services/execution` | `infrastructure/sources/metadata`、`infrastructure/sources/citations` |
| R2 多来源元数据搜索 | `core/collection`、`core/literature`、对应 services | 中性 source 数据、secure access、raw SQLite observation |
| R3 文献资产获取 | `core/assets`、`services/assets` | asset sources、HTTP/browser access、不可变 files |
| R4 文献解析 | `core/documents`、`services/documents` | MinerU parser、轻结构化文档文件发布 |
| R5 语言模型结构化分析 | `core/analysis`、`services/analysis`、`core/literature` | LLM adapter、分析文件和完成事务 |
| R6 文献数据库 | `core/literature`、`core/library`、对应 services | raw SQLite、文件系统、统一 read model、FTS |
| R7 书目信息导入与导出 | `core/library`、`services/library` | BibTeX、RIS、CSL JSON codec 与原子文件发布 |
| R8 大批量处理 | `core/execution`、`services/execution` | 本机 locking、短事务提交、中断后事实重筛选 |

## 18. 文档责任

- [产品需求](requirements.md)决定用户问题、核心能力、产品结果和验收场景。
- [设计文档](design.md)决定系统架构、逻辑模块、事实所有权、状态和业务协作。
- 本文决定目标代码分层、目录、依赖、端口、持久化、访问、运行和安全技术。
- 项目 `README`、CLI `--help`、源码和测试说明当前已经实现的行为。
- 实施顺序、差距和逐项 TODO 只进入后续执行文档，不进入设计或技术文档。
