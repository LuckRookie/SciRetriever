# Logging 模块技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 设计责任：[设计文档 5.4](../design.md#54-logging)
- 运行报告边界：[ADR 0013](../decisions/0013-decoupled-discovery-and-database-maintenance.md)

本文定义目标 `src/sciretriever/logging/` 公用基础模块。Logging 统一项目 logger 获取、生产进程配置、stderr 输出和最终脱敏防线；它不形成业务结果、Report、事件系统或持久化记录。

## 1. 目标结构

```text
logging/
  __init__.py
  api.py
  setup.py
  redaction.py
```

- `api.py` 是其它模块和 Bootstrap 唯一允许导入的公开边界；
- `setup.py` 配置 `sciretriever` logger 层级、level、formatter、stderr handler 和传播行为；
- `redaction.py` 实现最终脱敏 Filter；
- `__init__.py` 只标识 package，不复制公开 API 或产生 import-time 配置副作用。

Logging 不需要 `ports.py`、Pydantic Model、repository、adapter 或数据库 schema。它只依赖 Python 标准库，不导入 Model、Entry、Network、Storage 或任何业务模块。

## 2. 公开 API

`logging/api.py` 只公开两个操作：

```text
get_logger(module_name: str) -> logging.Logger
configure_logging(*, level: int) -> None
```

### 2.1 `get_logger`

具有运行行为的模块统一使用：

```python
from sciretriever.logging.api import get_logger

logger = get_logger(__name__)
```

`module_name` 去除边界空白后必须是 `sciretriever` 或以 `sciretriever.` 开头的完整模块名。`get_logger` 返回 Python 标准库 `Logger`，保持模块名层级，不安装 Handler、不修改 level、不读取配置，也不触发 Bootstrap。它只统一项目入口和命名约束，不包装 `debug/info/warning/error/critical` 或建立第二套 Logger 类型。

纯声明的 `model` 不记录运行日志，因此不依赖 Logging。测试可以直接取得命名 logger，但不能通过 `get_logger` 隐式改变进程配置。

### 2.2 `configure_logging`

`configure_logging` 只供生产 Bootstrap 在 CLI 启动时调用。它必须：

- 验证并设置 `sciretriever` logger 的标准库 level；
- 安装一个由本模块拥有、写入 `sys.stderr` 的 `StreamHandler`；
- 安装本模块的 formatter 和最终脱敏 Filter；
- 禁止日志传播到 root logger，避免重复输出；
- 不调用 `basicConfig()`，不修改 root logger 或宿主应用其它 logger；
- 重复调用时不得叠加本模块 Handler；生产 Bootstrap 仍只调用一次。

程序内 API 不调用 `configure_logging`。作为库嵌入其它程序时，SciRetriever 不接管宿主 Logging 配置；是否调用生产配置由宿主入口决定。

## 3. 标准流与输出合同

Logging 只写实时运行信息：

- stderr：进度、限速等待、局部失败和安全诊断；
- stdout：由 Entry/CLI presenter 独占，用于稳定文本结果、JSON Report 或其它可管道输出。

Logging 不得安装 stdout Handler。日志 message、level、时间、formatter 输出和可选上下文不是稳定公共 API；测试只固定标准流、安全边界和不影响业务的行为，不绑定完整自然语言文案。

适用时 LogRecord 可以携带安全的 `stage`、`provider_name`、`meta_literature_id` 或 `literature_id`。这些只是可选诊断上下文，不形成统一事件 schema、operation ID、目标状态或 Pydantic Model。

## 4. Report 边界

Logging 与 Entry Report 正交：

- 各业务模块先返回 typed result 或稳定、脱敏的 failure；
- Entry 只根据这些结果累计 `DiscoveryReport`、`DatabaseCompletionReport`、`ManualPdfReport`、`ImportReport` 或 `ExportReport`；
- Entry 可以把相同安全信息作为实时日志，但不能解析、回放或统计 LogRecord 形成 Report；
- 日志被过滤、丢失、重定向或输出失败不能改变 Report、退出结果、数据库提交、版本回退或下一次 selector；
- Logging 不能替代 DiscoverySourceResult、自动 PDF 获取耗尽或其它必须持久化的业务事实。

Logging 不定义业务事件类型、运行状态或成功/失败语义，也不建立 Observer、EventBus、subscriber、日志 repository 或审计流水。

## 5. 脱敏责任

来源边界必须先完成语义脱敏：

- Network 处理 URL、query、header、Cookie、凭据和网络异常；
- Provider adapter 处理供应商私有响应和 SDK 异常；
- Parser adapter 处理 task、私有输出和服务异常；
- LLM adapter 处理 prompt、响应、正文片段和 SDK 异常；
- Entry 只记录已经稳定化的 failure 与安全 ID。

`redaction.py` 的 Filter 是统一最终防线，只处理已知敏感字段和明显凭据模式，并在无法安全格式化诊断值时使用固定替代文本。它不能证明任意对象安全，也不能代替来源 adapter 的边界转换。

以下内容不得作为日志 message 参数、`extra`、`exc_info` 或未受控异常正文进入 LogRecord：

- 凭据、Authorization、Cookie 和 secret reference/value；
- 完整 URL、敏感 query 和短期签名参数；
- 原始 HTTP/SDK response、response body 和外部异常对象；
- prompt、文献正文和 Parser 私有输出；
- 用户文件绝对路径和机器相关内部路径。

已知外部失败转换为稳定 failure 后记录，不能无条件使用可能重新暴露原始 cause 的 `logger.exception`。意外内部编程错误的 traceback 由顶层错误边界按安全政策处理，不把外部不可信对象重新拼入用户日志。

## 6. 故障与非持久化边界

Logging 是 best-effort 技术旁路。模块拥有的 formatter、Filter 和 Handler 必须隔离自身失败；格式化失败使用安全占位，输出故障不能向业务调用方制造新的业务失败或改变事务结果。

当前目标不建立：

- 日志文件和轮转；
- SQLite sink、Artifact 或日志 repository；
- 跨进程日志协调；
- 持久审计、日志恢复或日志驱动重试；
- 稳定 LogEvent schema；
- 依赖日志决定文献状态、处理完成度或恢复位置的机制。

用户自行重定向 stderr 不改变日志的非权威、非持久化含义。

## 7. 依赖方向

```text
entry -----------\
metadata ---------\
literature --------\
acquisition --------> logging.api -> setup/redaction -> Python standard library
parsing -----------/
analysis ----------/
network -----------/
storage -----------/

bootstrap ---------> logging.api.configure_logging
model -X-----------> logging
logging -X---------> SciRetriever 其它模块
```

其它模块不得导入 `logging.setup` 或 `logging.redaction`，不得直接安装项目 Handler、formatter 或 Filter。Logging 不通过 Port 注入到各模块；模块取得命名 logger，Bootstrap 只负责触发一次生产配置。

## 8. 验收

直接测试至少证明：

- `get_logger` 只接受 `sciretriever` 命名空间，保持完整模块名且不产生配置副作用；
- package import、模块 import 和普通 adapter 构造不安装 Handler、不调用 `basicConfig()`；
- `configure_logging` 只配置 `sciretriever` logger，不修改 root logger，并且只有一个写入 stderr 的模块 Handler；
- 重复配置不叠加 Handler，stdout 不被日志污染；
- formatter、Filter 或输出故障不改变被记录操作的业务结果；
- 最终 Filter 对已知敏感字段使用安全替代文本，但测试仍证明每个外部 adapter 在进入 Logging 前完成自身边界脱敏；
- 原始异常、response、URL、header、Cookie、credential、prompt、正文和绝对路径不进入 LogRecord 或用户输出；
- Report 在关闭、过滤或故障 Logging 时保持相同内容；日志不能生成 Report 或持久事实；
- 目标生产模块不绕过 `logging.api` 配置或取得项目 logger，Model 不依赖 Logging；
- 不创建日志文件、数据库表、Artifact、Observer、EventBus、LogEvent Model 或 repository。

这些测试使用内存 stream、fake formatter/Filter 和受控异常，不读取真实凭据、不连接外部供应商，也不依赖完整日志文案。
