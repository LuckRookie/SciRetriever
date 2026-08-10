# 配置与 Provider 凭据技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 产品依据：[R2 多来源元数据搜索](../requirements.md#r2-多来源元数据搜索)、[R3 文献资产获取](../requirements.md#r3-文献资产获取)
- 架构决策：[ADR 0014](../decisions/0014-capability-scoped-providers-and-local-credentials.md)
- 访问安全：[ADR 0012](../decisions/0012-process-local-provider-access-scheduling.md)、[Network 技术文档](network.md)
- 易变外部事实：[Provider Notes](../../notes/providers/README.md)

本文定义根级 `configuration.py`、`bootstrap.py` 与 `entry/cli/config.py` 的目标配置协作。它只描述目标行为；当前已经支持的配置、命令和 Provider 仍以 README、用户指南、源码和测试为准。

## 1. 文件与责任

```text
src/sciretriever/
  configuration.py              # 普通配置与 credentials.toml 边界解析
  bootstrap.py                  # 凭据解析后的生产 adapter 组装
  model/configuration.py        # 不含 secret 的中性配置和诊断结果
  entry/cli/config.py           # config set/remove/status/test 边界与呈现
```

`configuration.py` 是生产代码读取 TOML 和 Provider 凭据文件的唯一位置。它负责路径解析、所有权/权限检查、TOML 解析、Provider/字段 allowlist、非空值检查和原子写入；不访问 Provider、不决定文献业务结果。`bootstrap.py` 只把短生命周期 secret 注入对应生产 adapter，并构造供 CLI 使用的能力与 readiness 注册表；不显示、序列化或保存 secret。`entry/cli/config.py` 只解析用户动作、执行安全交互并呈现稳定结果，不拥有 Provider 协议。

Model configuration 只保存普通设置、稳定 Provider key、能力选择和必要的非 secret 参数。真实 API key、token、metric、Cookie、浏览器 session 和凭据文件原文不能进入 Pydantic Model。

## 2. 普通配置与凭据文件分离

普通配置继续表达：

- Metadata/Acquisition Provider 是否启用及确定顺序；
- Web of Science Starter/Expanded、database/edition 等产品选择；
- 每个 DiscoveryRun 的 Provider scan limit；
- Provider 公开政策之上的 operator 收紧值；
- parser、LLM、路径、资源和其它非 secret 设置。

Provider secret 只保存在：

```text
~/.sciretriever/credentials.toml
```

这个文件不得保存启用状态、顺序、产品、database/edition、scan limit、endpoint、timeout、访问政策、联系邮箱、浏览器 profile、测试结果、测试时间、文献 ID 或任何数据库事实。普通配置和凭据文件缺一不可时由 readiness 组合判断，不能把密钥存在解释成 Provider 已启用或任意内容已获授权。

生产路径固定为当前用户主目录下的 `.sciretriever/credentials.toml`。内部测试通过依赖注入使用系统临时目录中的受控文件，不读取开发者真实凭据；不提供把任意不可信路径作为普通业务参数传入 Provider 的能力。

## 3. `credentials.toml` 合同

目录必须由当前用户拥有、是普通非符号链接目录且权限为 `0700`；凭据文件必须由当前用户拥有、是普通非符号链接文件且权限为 `0600`。符号链接、非普通文件、错误 owner、错误权限或无法安全读取都必须 fail closed，并给出不含路径外敏感内容的修复建议。

每个稳定 Provider key 最多一个 section，每个字段值都是去除边界空白后仍非空的 secret 字符串。当前个人使用边界不建立多账户 profile、credential alias、继承、include、动态 endpoint、自由 `extra` 或文件级 schema/version 字段。示例：

```toml
[web-of-science]
api_key = "<secret>"

[semantic-scholar]
api_key = "<secret>"

[openalex]
api_key = "<secret>"

[elsevier]
api_key = "<secret>"
institution_token = "<secret>"

[springer]
api_key = "<secret>"
api_metric = "<secret>"

[core]
api_key = "<secret>"

[opencitations]
access_token = "<secret>"
```

示例只表达文件形状，不提供真实 secret。每个 adapter 的字段名、必需性和适用能力必须来自当前官方合同与 Provider Notes：

- Web of Science `api_key` 为 metadata 必需；具体产品/database 属于普通配置；
- Semantic Scholar、OpenAlex、CORE 和 OpenCitations 的凭据可以按当前政策为可选或规模化使用推荐，匿名能力仍必须有明确 AccessPolicy；
- Elsevier metadata 与 acquisition 可以共享 `api_key`，但 `institution_token` 和具体内容 entitlement 分别判断；
- Springer Nature 的 metadata key 与 Full Text 产品 metric 分别判断；
- Wiley 的当前官方凭据字段尚未核实，生产 adapter 未形成精确合同前状态为 `unsupported`，不能提前接受猜测字段；
- Crossref polite identity、Unpaywall contact email等非 secret 运行身份不进入此文件。

Provider 官方认证合同变化时先更新对应 Notes、adapter credential spec 和直接安全测试，再调整 allowlist。未知 Provider、未知字段、重复 section、空值、非字符串值或无 adapter 支持的猜测字段必须拒绝，不能静默保存后永远不使用。

## 4. Provider 能力与 readiness

Bootstrap 分别构造 Metadata 和 Acquisition 能力注册表；同一个 Provider key 可以同时出现，但两个 adapter、协议和失败语义保持独立。每项能力依次经过：

```text
production adapter 已实现
  -> 普通配置已启用
  -> 必需普通参数、凭据和 AccessPolicy 就绪
  -> Acquisition 对当前 Literature 适用
  -> 才允许真实调用
```

领域 DiscoveryRun 不需要 Literature 适用性判断：它调用本次全部已启用且就绪的 Metadata search adapter。Acquisition 还必须根据 AssetHint、稳定标识符、Provider 专属记录身份或 DOI 安全解析后的 landing origin 判断当前 Source 是否适用；publisher 自由文本和单独 DOI 前缀不能直接通过 readiness。

用户明确启用但缺少生产 adapter、必需普通参数、凭据或 AccessPolicy 时，操作开始前返回稳定配置错误。未启用能力不参加本次调用和 Acquisition 耗尽集合。凭据存在但真实调用返回 401/403、quota 或服务错误时是本次 Provider 失败；Metadata 保留其它来源成功，Acquisition 不能因此建立自动获取耗尽事实。

## 5. CLI 命令树

目标 CLI 的配置组固定为：

```text
sciretriever config set <provider>
sciretriever config remove <provider>
sciretriever config status
sciretriever config test <provider>
sciretriever config test --all
```

配置命令不创建 Entry 处理 Report。稳定文本或 `--json` 结果走 stdout，安全提示和诊断走 stderr；真实 secret 在两者中都禁止出现。

### 5.1 `config set`

`set` 根据 adapter credential spec 以不回显的交互输入依次收集必需和可选字段。真实值不得通过普通 CLI option、位置参数、URL 或环境回显传入。已有 section 时明确询问是否替换；用户取消不修改文件。

写入流程必须：

1. 安全打开并完整验证现有文件；
2. 在内存中只替换目标 Provider section；
3. 在同目录创建 owner-only staging；
4. flush、`fsync` 并重新解析待发布 TOML；
5. 原子替换正式文件并确保 `0600`；
6. 失败时清理 staging 且保留原文件。

不创建含旧值或新值的备份、日志、Report、临时仓库文件或数据库副本。CLI 规范化重写可以调整 TOML 排版和注释；注释与原始字段顺序不是凭据合同。

### 5.2 `config remove`

`remove` 只删除指定 Provider section并按相同原子写入规则发布。Provider 不存在时返回稳定的未配置结果，不修改普通配置、其它凭据或文献数据库。删除凭据不会删除已经接纳的 MetadataObservation、Asset 或其它文献事实；下一次操作按新的 readiness 判断是否可调用。

### 5.3 `config status`

`status` 只执行本地文件、字段和生产 adapter/readiness 静态检查，不访问网络。它按 Provider 和 `metadata`/`acquisition` 能力显示以下状态：

| 状态 | 精确含义 |
|---|---|
| `not-required` | 当前生产 capability 的官方合同与普通配置允许无凭据使用，不需要凭据字段 |
| `configured` | 当前 capability 声明的全部必需和可选凭据字段都存在且非空 |
| `partial` | Provider section 已存在，但当前 capability 的至少一个必需字段缺失 |
| `missing` | 当前 capability 需要凭据，但没有任何可满足其必需合同的字段 |
| `optional-missing` | 全部必需字段已经存在，但至少一个已声明可选字段未提供 |
| `unsupported` | 当前没有可执行的生产 adapter 或已经核实的 credential spec，不能接受猜测字段 |

多字段 Provider 还可以显示字段名称、是否必需和是否存在，但绝不显示原值、掩码值、长度、前后缀、hash 或可用于辨识 secret 的 fingerprint。输出同时说明固定凭据文件位置以及权限/TOML错误。`status` 不把本地字段存在描述为认证成功。

### 5.4 `config test`

`test <provider>` 是对明确指定 Provider 的显式诊断，因此不要求该 Provider 已在普通运行配置中启用；它只对已有生产 adapter 的能力执行本地检查，并对其中 readiness 通过的能力发起 probe。`test --all` 只枚举普通配置已启用且生产 adapter 已存在的能力，其中本地 readiness 不通过的能力明确 `skipped`，只有就绪能力实际访问 Network。缺少必需凭据或普通参数时不匿名回退；明确允许匿名且配置选择匿名策略的能力可以执行无凭据测试。

每项测试只使用 Provider 官方允许的最小只读请求，并依次验证本地 readiness、Network/DNS/TLS 可达、凭据接受、所选 API 产品可用和最小响应可由当前 adapter 解析。测试必须经过共享 Access Coordinator、timeout、响应大小、redirect、origin、quota、`429`/`Retry-After` 和脱敏边界。一个 Provider 失败不阻止 `--all` 汇总其它结果；请求集合中的任一失败使 CLI 返回非零退出结果。

测试不创建 DiscoveryRun、Literature、MetadataObservation、ProviderRelationObservation、Asset、自动获取耗尽、Catalog/ArtifactStore 行、Entry Report 或持久日志。它不保存最后结果和时间。Acquisition 测试只表达服务 readiness：即使认证和内容 endpoint 可用，也必须显示具体文献 entitlement 未被证明，不能下载测试 PDF 后接纳为资产。

## 6. Secret 生命周期与脱敏

真实 secret 只在 `configuration.py` 的私有解析结果和具体 adapter 的当前进程内存中存在。它不得进入：

- Pydantic Model configuration、CLI JSON 或业务 Model；
- AccessScope、permit、限速窗口或缓存 key；
- SQLite、ArtifactStore、provenance、Report 或处理状态；
- URL、相对路径、文件名、异常正文、LogRecord 或调试表示；
- Provider Notes、fixture、测试快照或安装产物。

Adapter 声明允许附着凭据的 origin；Network 逐跳复检 redirect 并默认剥离跨 origin 凭据。配置和测试错误只报告 Provider、字段名称、安全状态与修复动作，不包含读取到的值。CLI 进程结束后不建立凭据 daemon、缓存文件或跨进程 secret service。

## 7. 测试与验收

离线直接测试至少覆盖：

- CLI 与手工准备的同一 `credentials.toml` 得到相同 readiness；测试使用临时主目录/显式注入路径，不读取真实用户文件；
- 目录 `0700`、文件 `0600`、当前 owner、普通文件和非符号链接边界；权限过宽、错误 owner、非法 TOML、未知 section/字段、空值和非字符串 fail closed；
- `set` 隐藏输入、创建/替换、多字段 partial、用户取消、原子失败保留旧文件且不产生备份；
- `remove` 只删除目标 section，重复删除稳定且不影响普通配置或数据库；
- `status` 对 required、optional 和无需凭据的 Provider 正确分类，文本与 JSON 都不包含 secret、长度、mask 或 fingerprint，且不触发 Network；
- `test` 只通过 fake provider/Network 执行最小只读 probe，单项与 `--all` 正确汇总 passed/failed/skipped，不创建 DiscoveryRun、Report 或数据库事实；
- 认证成功与 acquisition entitlement 未证明分开表达，401/403/429/timeout/非法响应稳定化且脱敏；
- 启用但缺少必需凭据在普通 Discovery/Acquisition 开始前失败，运行时 Provider 失败保留 Metadata 其它来源结果且不形成 PDF 获取耗尽；
- README、用户指南和 `project.scripts` 只在目标 CLI 和凭据功能实际实现并通过安装后离线测试后更新。

Harness、CI 和单元测试不得执行 `config test` 的真实网络路径，不读取 `~/.sciretriever/credentials.toml`，也不得依赖开发者具有任何 API key。
