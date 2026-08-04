# SciRetriever

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Package](https://img.shields.io/badge/package-0.1.0-2F855A)](pyproject.toml)
[![CI](https://img.shields.io/badge/CI-quick%20%2B%20full-1F6FEB)](.github/workflows/ci.yml)

## 产品定位

SciRetriever 面向需要持续建立专题文献集合的研究者和文献整理人员。产品目标是汇总多来源文献元数据，获取并保存文献资产，生成轻结构化文本和通用结构化分析结果，最终形成可查询、可补充、可交换书目信息的文献数据库。

产品边界止于通用文献元数据、资产、轻结构化文本、通用结构化文献分析结果及其 provenance。反应、分子、路线、产率、材料性质等领域数据由下游系统处理。完整目标见[产品需求](docs/architecture/requirements.md)，已接受约束见[架构决策索引](docs/architecture/decisions/README.md)。

## 当前使用方式

当前仓库发布的是 Python 包，没有受支持的终端用户 CLI。`pyproject.toml` 没有声明 `project.scripts`，包内也没有 `__main__.py`。历史材料中的命令示例不是当前可执行入口。

从源码检出安装锁定依赖并验证包导入：

```bash
uv sync --locked
uv run --frozen python -c "import sciretriever; print(sciretriever.__version__)"
```

当前公开的程序内 Service 定义位于 `sciretriever.services` 各业务模块：

| 模块 | 公开 Service | 责任 |
|---|---|---|
| `sciretriever.services.collection` | `CollectionService` | 建立收集定义并执行主题或引用收集用例 |
| `sciretriever.services.literature` | `LiteratureService`、`CompletionAcceptanceService` | 文献身份接纳与完成事实接纳 |
| `sciretriever.services.assets` | `ContentAssetService` | 获取、验收并发布文献资产 |
| `sciretriever.services.documents` | `LightDocumentService` | 调用 parser 并验收轻结构化文档 |
| `sciretriever.services.analysis` | `AnalysisService` | 调用 LLM 并提交完整分析结果 |
| `sciretriever.services.execution` | `ExecutionService` | 选择实际目标并编排可继续的批量处理 |
| `sciretriever.services.library` | `LibraryService`、`LibraryExchangeService`、`CurationService` | 查询、书目交换和有限整理 |

这些类从各模块的 `__init__.py` 导出。构造 Service 时必须提供对应的依赖对象和 Service 自己拥有的 Ports，不能把测试 fake、Protocol 或 Infrastructure 私有构造器当成稳定用户 API。例如，下面的导入是当前公开路径：

```python
from sciretriever.services.collection import CollectionService, CollectionServiceDependencies
from sciretriever.services.library import LibraryExchangeService, LibraryService
```

运行配置、具体 adapter 选择和对象图组装属于 Composition。当前公开的 Composition 入口可以直接导入：

```python
from sciretriever.composition import ObjectGraph, build_object_graph, load_configuration
```

`build_object_graph` 当前固定组装 `LiteratureService` 和 `LibraryService`。只有调用方提供 secret resolver 时才组装 `AnalysisService`，只有调用方提供 provider dependencies 时才建立 provider registry。其它公开 Service 尚未进入该对象图。

只有已经由 Composition 连接到 Service 的实现，才构成可运行能力。代码中存在某个 provider 名称、Port、factory 或测试 fake，不代表该外部来源已经作为生产 adapter 对用户开放。

## 配置

当前配置合同使用 `schema_version = 2`，由以下十个严格责任组组成：

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

未知组、未知字段和未知协议枚举会被拒绝。配置只保存 `env:VARIABLE_NAME` 形式的 secret reference，不保存或展示秘密值。程序内选择配置时，显式路径优先，其次是 `SCIRETRIEVER_CONFIG`，最后是当前目录的 `config.toml`。没有配置时会失败，不存在隐式默认文件，也没有命令行覆盖合同。

字段、默认值、路径限制和 secret reference 边界见[配置手册](docs/guides/configuration.md)。仓库根目录 `config.toml` 可能是个人运行配置，不是公开模板，也不应提交。

## 外部服务边界

MinerU 是 operator-managed 的外部 parser service。SciRetriever 只通过 parser adapter 调用已经由 operator 部署并授权的服务，不负责安装、启动、停止、重载或升级 MinerU。远程解析会离开本机数据边界，必须由 operator 明确确认上传授权、服务端保留策略和凭据来源。

Metadata、citation、asset 和 LLM 网络访问同样依赖 Composition 实际选择并连接的 adapter。配置中的 provider 字符串只是选择键，不证明真实 adapter 已接入。网络成功也不等于业务接纳，文献身份、资产有效性、文档完整性和分析完整性仍由 Core 规则决定。

Provider 或 MinerU 的外部说明不能扩大发布能力。是否可用仍以当前 Composition 对象图、具体 adapter 和直接测试为准。

## 数据与安全边界

- `Work` 和 `WorkVersion` 是当前接受的内部身份机制，来源 observation 必须保留。
- SQLite 保存关系、相对引用、hash 和 provenance，不保存大型文献 BLOB 或机器相关绝对资产路径。
- 已接受资产和发布产物采用不可变发布，不能原地覆盖不同字节。
- Secret 值不能进入 Model、SQLite、provenance、diagnostics、URL、文件名或用户输出。
- MinerU、LLM、HTTP、浏览器和供应商类型不能进入 Core 或 Service API。
- 文献数据、运行时 catalog、下载资产、用户语料和个人配置不能提交到代码仓库。

## 开发与验证

```bash
uv sync --locked --dev
uv run --frozen python scripts/harness.py quick
uv run --frozen python scripts/harness.py full
```

协作规则见 [`AGENTS.md`](AGENTS.md) 和 [`HARNESS.md`](HARNESS.md)，代码与文档同步关系见[开发手册](docs/development/README.md)。

## 项目文档

- [当前用户指南](docs/guides/README.md)
- [配置手册](docs/guides/configuration.md)
- [开发手册](docs/development/README.md)
- [整体架构](docs/architecture/README.md)
- [活动提案](docs/proposals/README.md)
- [历史归档](docs/archive/)
