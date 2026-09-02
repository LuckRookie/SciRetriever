# Block 1：展示合同与 Presenter

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | `LUX01`-`LUX04` |
| 前置块 | 无；用户已确认 UX 方向 |
| 下游块 | Block 2、3 |
| 恢复点 | 最后一个通过日志直接测试的 Task |

## 块结果

Logging formatter 能把安全事件呈现为短主行和有层级的续行，在窄终端、非 TTY、无颜色和并发场景下保持可读、可检索、原子且不会影响业务。

## 进入条件

- 当前 Logging 技术合同、实现和直接测试已读取；
- `logging/` 当前无未合并用户改动；
- 公开 API、stderr、Report 分离和安全边界保持不变；
- R0 Plan readiness 通过。

## 责任与改动面

Primary owner 负责：

- `src/sciretriever/logging/presentation.py`；
- 必要时 `src/sciretriever/logging/setup.py`，但不扩张公开 API；
- `tests/test_logging_presentation.py`、`tests/test_logging_foundation.py`；
- 本块完成证据。

受保护内容包括工作树中全部 Configuration、Agents 与 Config probe 改动；本块不触碰这些生产文件。

## 需要保持的行为

- 标准库 logger、单一项目 stderr handler、重复配置去重；
- 普通 message 与未知 event 安全回退；
- 原始 event ID 可检索；
- TTY 有限颜色，重定向/`NO_COLOR`/`TERM=dumb` 无 ANSI；
- formatter/filter/stream 故障不越过 Logging 边界；
- 最终脱敏和禁止内容边界。

## Tasks

- [x] **LUX01 — 固定信息层级。** 定义主行、context、reason、action 的字段归属和稳定顺序；event ID 保留但降低视觉优先级。
  - 验收：成功、失败和 Debug 样例只在主行展示高价值字段，续行语义一致。
- [x] **LUX02 — 实现宽度感知的静态布局。** 在不引入 Live UI 或新依赖的前提下，按输出宽度安全换行，续行保持对齐。
  - 依赖：LUX01。
  - 验收：80/120/160 列与非 TTY 样例不产生不可读的无限长主行，event ID 与字段不丢失。
- [x] **LUX03 — 统一状态、时间与字段词汇。** 统一 glyph、耗时、核心字段别名和 failure 展示；保留未知字段的确定性回退。
  - 依赖：LUX01。
  - 验收：同一 outcome 在不同模块得到相同状态符号，毫秒字段一致显示为秒。
- [x] **LUX04 — 证明安全与降级。** 扩展并发、无颜色、普通 message、恶意长值、formatter/filter/stream 故障与 stdout 隔离测试。
  - 依赖：LUX02、LUX03。
  - 验收：相关 foundation/presentation 测试通过且禁止内容不出现。

## 执行方式与集成点

串行完成 LUX01-04。每次先增加直接测试或 transcript 期望，再做最小实现；Block 2 只消费已经稳定的 message 约定，不导入 presenter 私有实现。

## 审查门

- R1：确认 Logging 文件没有用户未审查改动；
- R2：每个 slice 检查布局是否保持安全回退、重定向和并发原子性；
- R3：直接测试全部通过，公开 API 与依赖未变，才退出。

## 接口 / 数据 / 依赖影响

- 接口：无公开 API 变化；formatter 私有行为变化；
- 数据：无；
- 依赖：无；继续使用 Python 标准库。

## 验证与证据

```bash
uv run --frozen python -m unittest tests.test_logging_presentation tests.test_logging_foundation
uv run --frozen ruff check src/sciretriever/logging tests/test_logging_presentation.py tests/test_logging_foundation.py
```

执行后在“完成证据”记录真实结果。

## 退出条件

- LUX01-04 全部完成；
- 相关测试和 Ruff 通过；
- diff 审查未发现安全、stdout、公共 API 或无关改动；
- Block 2 能仅通过标准 `event=...` message 使用新布局。

## 完成证据

2026-09-02：

- `uv run --frozen python -m unittest tests.test_logging_presentation tests.test_logging_foundation`：19 tests，全部通过；
- `uv run --frozen ruff check src/sciretriever/logging tests/test_logging_presentation.py tests/test_logging_foundation.py`：通过；
- `uv run --frozen ruff format --check src/sciretriever/logging tests/test_logging_presentation.py tests/test_logging_foundation.py`：通过；
- R2/R3 审查：公开 API、stderr/stdout、依赖和最终脱敏边界未变；event ID、未知消息回退、并发原子输出和故障隔离均保留；
- 当时的下游风险：业务生产者尚未完成 INFO/DEBUG 所有权清理；该风险已由 Block 2 关闭。

## 失败与恢复

折行若破坏事件解析、原子输出或脱敏，停止在失败样例，回退到最近通过的 formatter 切片；不通过吞错或移除有效测试获得绿色结果。

## 下游交接

Block 2 可依赖：事件 ID 仍保留，核心字段可按主行/续行分层，INFO/DEBUG 仍由标准 logging level 控制，生产者无需导入 Logging 私有类型。
