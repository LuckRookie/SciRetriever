# Logging 模块技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 设计责任：[设计文档 5.5](../design.md#55-logging)
- 运行报告边界：[ADR 0013](../decisions/0013-decoupled-discovery-and-database-maintenance.md)
- PDF 分层运行边界：[ADR 0015](../decisions/0015-publisher-aware-tiered-pdf-acquisition.md)
- Browser/Challenge runtime：[ADR 0016](../decisions/0016-cloakbrowser-fixed-identity-runtime.md)
- Agents 边界：[ADR 0017](../decisions/0017-shared-agents-and-controlled-browser-agent.md)

本文定义目标 `src/sciretriever/logging/` 公用基础模块。Logging 统一项目 logger 获取、生产进程配置、stderr 输出和最终脱敏防线；它不形成业务结果、Report、事件系统或持久化记录。

## 1. 目标结构

```text
logging/
  __init__.py
  api.py
  presentation.py
  setup.py
  redaction.py
```

- `api.py` 是其它模块和 Bootstrap 唯一允许导入的公开边界；
- `presentation.py` best-effort 解析现有 `event=... key=value` message，负责人类可读布局、字段排序、状态符号和可选 TTY 颜色；
- `setup.py` 配置 `sciretriever` logger 层级、level、故障隔离 stderr handler 和传播行为；
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

`configure_logging` 只供生产 Bootstrap 或不构建文献对象图的 CLI `config` 边界在启动时调用。CLI 默认传入 `logging.INFO`；用户显式提供全局 `--debug` 时传入 `logging.DEBUG`。它必须：

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

适用时 LogRecord 可以携带安全的 `stage`、`tier`、`provider_name`、`route_key`、`browser_rate_limit_group`、`plan_revision`、`disposition`、`next`、`http_status`、`http_status_class`、`elapsed_ms`、`action`、`meta_literature_id` 或 `literature_id`。其中 HTTP 状态只允许使用 Network 已验证的三位数字和受控状态类别，不能携带 status text、header 或 body。这些只是可选诊断上下文，不形成统一事件 schema、operation ID、目标状态或 Pydantic Model；route/group 值必须来自静态无 secret identity，不能从完整 URL、账号、Cookie、DOI 或随机任务派生。诊断耗时来自单调时钟，只进入 LogRecord，不进入 Report、Catalog 或业务 Model。

现有模块继续写标准库参数化 message。Formatter 只对以合法 `event=<稳定事件 ID>` 开头的 message 做 best-effort 展示；普通 message、未知事件或解析失败都安全回退。人类输出的主行固定包含时间、level、component、状态符号、动作、原始事件 ID 与排序后的安全字段；稳定失败的 `reason` 和 `action` 各占一条缩进续行。Debug 额外显示源码模块与行号。TTY 可以使用有限颜色；非 TTY、重定向、`TERM=dumb` 或设置 `NO_COLOR` 时必须是无 ANSI 的普通 UTF-8 文本。原始事件 ID 始终保留，便于 `rg`，但完整格式仍不是公共 API。

### 3.1 正常与 Debug 模式

生产 CLI 只有两个日志模式，不增加独立 verbose 等级或配置文件开关：

| 模式 | level | 必须呈现的内容 |
| --- | --- | --- |
| 正常 | `INFO` | 操作、Metadata Provider、由 Entry 汇总的 PDF tier/Browser escalation、目标与 Provider group 进度，限速等待/暂停、交付、耗尽、中断及稳定失败；失败保留 code、retryable、reason 与 action。route/candidate 级 miss、skip、capture 和 cleanup 不重复刷屏 |
| Debug | `DEBUG` | 正常模式全部内容，加上每个安全语义步骤的开始、跳过、命中、正常 miss、状态迁移、资源清理和失败；可能结束或继续链路的终态包含 `disposition`、`next` 和诊断耗时 |

Debug 的“逐步骤”按责任边界记录，而不是给每个函数做调用追踪。当前至少覆盖：

- Network 的无凭据请求开始、最终 HTTP status/响应字节数/耗时、API quota feedback、risk-group permit/circuit 状态，或 `policy`、`timeout`、`TLS`、`transport`、`admission`、`budget` 等中性失败分类；
- Metadata 的 Provider session 与耗时、逐 raw item 的 `accepted/empty/rejected` disposition、observation/relation 增量和稳定 reason；Provider 汇总满足 raw = accepted + empty + rejected；
- Topic/Citation Discovery 的深度、observation 接纳/拒绝、关系和结果发布；Literature 拒绝 observation 时保留其拥有的稳定 `decision_reason`，但不记录 Provider 原始记录或正文；
- Database Completion 的冻结目标、有界 PDF cohort、tier barrier、并发目标进度、current facts、Acquisition、Parsing、Analysis 和 Literature 接纳阶段；
- Acquisition 的 plan revision、resolution evidence kind、route readiness/applicability、route key、public/API route hint 类别、候选匿名 ID、route 的 `disposition/next`、授权 target/lookup/download、Browser eligible/admitted/attempted/delivered、group queue/pacing、session reuse、页面 observation/marker 检查、state/capture/cleanup、PDF 验证/准备、提交与正常耗尽。Browser marker 事件只记录静态 rule/marker ID、selector 数量、matched/miss 和 `elapsed_ms`；不记录 selector 或页面文本。
- Agents 的 role、provider/model identity、所需 capability、turn/result 类别、输入/输出/图像安全大小、usage 类别、剩余预算、延迟和稳定失败；不记录 prompt/schema 内容、模型原文、reasoning、图片、页面文本、元素名称或 tool arguments。
- Challenge 的 dependency admitted/blocked、resource/frame 数量、resource-loading/settling/cleared/interaction-required/resource-blocked/settle-timeout、证据 kind 与局部耗时。正常模式只说明“程序资源策略阻断”“自动检查未完成”“明确需要人工交互”或“普通拒绝”及下一步；Debug 增加阶段与安全计数，但不记录 title、selector、iframe URL/query、页面正文或验证码特征。

Elsevier Authorized lookup/download 的 response classification 在 Debug 中额外记录数值
`http_status` 和受控 `http_status_class`，用于区分认证、授权、配额、not-found、服务错误与
真正未知状态；即使 failure kind 为 response-schema，也不记录供应商 status text、header、
response body、URL/query 或 credential。

这些 Browser 字段已经由离线 route、scheduler、Completion 和安装 wheel 测试验证；当前
production Browser route 与 local eligible count 均为 9。总开关和本地 runtime 就绪后，
Completion 可以产生真实的脱敏 Browser admission/group/state/capture/cleanup 日志。这些日志只
证明实际执行步骤与结果分类，不能把 production catalog、本地 runtime 就绪或 probe 成功写成
组织授权或任意文章 entitlement。
SpringerLink revision 5 在初始 DOI PDF locator 没有形成 capture、且无经审查 entitlement marker 时还会记录
`decision_reason=entitlement-marker-absent outcome=normal-miss`，用来区分正常页面未命中与
Browser timeout；该诊断不能反推账号、机构或订阅状态。

携带 credential header/query 的 Network 调用不在 Network 层生成 LogRecord，避免凭据对象或别名进入日志系统；它们仍由 Provider/route/Agents adapter 在更高边界记录不含 endpoint、凭据或响应正文的安全步骤和稳定失败。这项抑制在 Debug 模式下也不放宽。Browser 日志只能记录无 secret 的 rule/session/risk-group identity、Cloak runtime/version readiness、固定身份是否稳定和状态类别，不能记录 seed、完整导航目标、selector、页面文本、截图、Cookie、Profile 路径/内容、登录细节或签名 locator。

正常和 Debug 都只写 stderr。SciRetriever 不接管日志文件路径和轮转；用户需要保留文件时，用 shell、进程管理器或宿主应用把 stderr 定向到本次运行目录。例如：

```bash
sciretriever complete pdf --all-pending --json \
  > reports/completion.json \
  2> logs/completion.log

sciretriever --debug complete pdf --all-pending --json \
  > reports/completion-debug.json \
  2> logs/completion-debug.log
```

## 4. Report 边界

Logging 与 Entry Report 正交：

- 各业务模块先返回 typed result 或稳定、脱敏的 failure；
- Entry 只根据这些结果累计 `DiscoveryReport`、`DatabaseCompletionReport`、`ManualPdfReport`、`ImportReport` 或 `ExportReport`；
- Entry 可以把相同安全信息作为实时日志，但不能解析、回放或统计 LogRecord 形成 Report；
- 当前操作的 tier/group 升级摘要、等待与 action-required 可以同时用于实时 UX 和 typed failure，但不能通过日志反推、补写或扩张 Report；
- 日志被过滤、丢失、重定向或输出失败不能改变 Report、退出结果、数据库提交、版本回退或下一次 selector；
- Logging 不能替代 DiscoverySourceResult、自动 PDF 获取耗尽或其它必须持久化的业务事实。

Logging 不定义业务事件类型、运行状态或成功/失败语义，也不建立 Observer、EventBus、subscriber、日志 repository 或审计流水。

## 5. 脱敏责任

来源边界必须先完成语义脱敏：

- Network 处理 URL、query、header、Cookie、凭据和网络异常；
- Provider adapter 处理供应商私有响应和 SDK 异常；
- Parser adapter 处理 task、私有输出和服务异常；
- Agents adapter 处理 prompt、schema、模型响应、图像、tool payload、正文片段和 SDK/协议异常；
- Entry 只记录已经稳定化的 failure 与安全 ID。

`redaction.py` 的 Filter 是统一最终防线，只处理已知敏感字段和明显凭据模式，并在无法安全格式化诊断值时使用固定替代文本。它不能证明任意对象安全，也不能代替来源 adapter 的边界转换。

以下内容不得作为日志 message 参数、`extra`、`exc_info` 或未受控异常正文进入 LogRecord：

- 凭据、Authorization、Cookie 和 secret reference/value；
- 完整 URL、敏感 query 和短期签名参数；
- 原始 HTTP/SDK response、response body 和外部异常对象；
- prompt、schema、模型原文/reasoning、Agent screenshot/tool payload、页面/文献正文和 Parser 私有输出；
- 用户文件绝对路径和机器相关内部路径。

Publisher resolution 只记录证据类别和 confirmed/unresolved/conflicting，不记录完整 DOI landing
URL；route hint 只记录类别和是否产生，不记录 locator；Browser 只记录稳定状态迁移和安全
group/session identity，不记录 Cookie 名称、profile 文件、selector、页面标题/正文或截图。

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
agents ------------/
network -----------/
storage -----------/

bootstrap ---------> logging.api.configure_logging
entry.cli(config) --> logging.api.configure_logging
model -X-----------> logging
logging -X---------> SciRetriever 其它模块
```

其它模块不得导入 `logging.setup` 或 `logging.redaction`，不得直接安装项目 Handler、formatter 或 Filter。Logging 不通过 Port 注入到各模块；模块取得命名 logger，Bootstrap 只负责触发一次生产配置。

## 8. 验收

直接测试至少证明：

- `get_logger` 只接受 `sciretriever` 命名空间，保持完整模块名且不产生配置副作用；
- package import、模块 import 和普通 adapter 构造不安装 Handler、不调用 `basicConfig()`；
- `configure_logging` 只配置 `sciretriever` logger，不修改 root logger，并且只有一个写入 stderr 的模块 Handler；
- 默认 INFO 模式保留进度与稳定错误原因但过滤逐步骤 DEBUG；`--debug` 使生产对象图使用 DEBUG level 并保留两类记录；
- 重复配置不叠加 Handler，stdout 不被日志污染；
- formatter 在并发 LogRecord 下保持整条输出，不交叉拼接；TTY 颜色、`NO_COLOR` 和重定向单色降级可直接验证；
- formatter、Filter 或输出故障不改变被记录操作的业务结果；
- 最终 Filter 对已知敏感字段使用安全替代文本，但测试仍证明每个外部 adapter 在进入 Logging 前完成自身边界脱敏；
- 原始异常、response、URL、header、Cookie、credential、prompt、正文和绝对路径不进入 LogRecord 或用户输出；
- 携带凭据的 Network 调用在 Network logger 上保持静默，而对应 Provider/route adapter 只记录安全步骤与稳定失败；
- 正常模式能解释 Public/API/Browser tier 汇总、Provider group、等待/暂停、交付/耗尽、稳定失败原因和下一动作，同时不重复输出 Entry/Cohort 的同一 tier/group 快照；Debug 额外覆盖 plan revision、resolution evidence kind、Metadata raw-item disposition、route `disposition/next`、API target、quota feedback、Browser queue/session/state/capture/cleanup 和关键 `elapsed_ms`；
- 正常模式能区分 challenge resource 被本地策略阻断、自动 settle、明确人工交互和普通 access denied；Debug 安全呈现 dependency/stage/evidence kind/resource count/settle elapsed，且同一状态只由拥有层输出一次；
- Agents INFO/DEBUG 能区分 role/capability、预算、quota、timeout、取消与结果类别，但 prompt、schema、模型原文/reasoning、图片、页面文本、元素名称和 tool arguments 从不进入 LogRecord；
- 不同 Browser group 的日志可按安全 group identity 区分，同一 group 的 retry/popup/备用入口不会伪装为并行新流程；
- Cookie、profile 内容、完整 URL、selector、页面文本、短期 locator 和 Browser vendor object 在 INFO/DEBUG 两种模式都不进入 LogRecord；
- Report 在关闭、过滤或故障 Logging 时保持相同内容；日志不能生成 Report 或持久事实；
- 目标生产模块不绕过 `logging.api` 配置或取得项目 logger，Model 不依赖 Logging；
- 不创建日志文件、数据库表、Artifact、Observer、EventBus、LogEvent Model 或 repository。

这些测试使用内存 stream、fake formatter/Filter 和受控异常，不读取真实凭据、不连接外部供应商，也不依赖完整日志文案。
