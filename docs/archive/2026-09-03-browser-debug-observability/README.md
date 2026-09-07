# Browser Agent 无 PDF 调查与可观测性修复计划

> 历史实施记录，非当前产品或架构真相源。当前行为以 requirements、Accepted ADR、current
> docs、源码与测试为准。

## 1. 计划身份与当前状态

| 字段 | 值 |
| --- | --- |
| Run ID | `BROWSER-DEBUG-OBSERVABILITY-20260903` |
| 创建日期 | 2026-09-03 |
| Primary owner | Codex `/root` |
| 当前状态 | Completed and archived — 2026-09-04；可观测性实现与真实诊断闭环，capture handoff 修复由[后续归档计划](../2026-09-04-browser-capture-handoff/README.md)完成 |
| 目标 | 解释 Challenge 通过后为何仍无 PDF，区分状态机安全停止、Network 捕获失败、页面未提供资源和运行时清理，不改变既有安全边界 |

> **流程说明**：本计划是在调查和部分实现已经发生后补写并持续整理的恢复文档，不能把它表述为“所有代码都在计划建立后才开始修改”。从本条开始，任何新增事实先写入“调查”区，方案确认后才实施；若新证据与冻结事实冲突，先更新调查和变更记录，再改代码。这样既如实保留本轮历史，也避免后续上下文继续重复调研。

本计划记录已经完成的调查，作为后续实施和跨上下文恢复的事实入口。它不替代 requirements、Accepted ADR、设计文档或源码；计划中的“已确认”只引用可复核的源码、测试和运行日志。

### 阶段门

本计划按“调查 → 方案 → 实施 → 验证”推进。调查结论在第 4-7 节冻结后，才进入第 8 节方案和第 9 节代码实施；实施阶段不再无目的扩展调研，只有出现与已记录证据矛盾的新事实时才回到调查阶段。这样可以让每个判断都有明确的证据来源，也避免在上下文中重复搜索。

| 阶段 | 固化内容 | 进入下一阶段的条件 |
| --- | --- | --- |
| 调查 | 真实运行事实、未知项、根因分类 | 事实链和安全边界可复核 |
| 方案 | 针对已确认根因的最小改动、测试和残余风险 | 方案不放宽既有安全边界 |
| 实施 | 源码、直接回归测试、必要文档 | 代码与测试形成同一能力切片 |
| 验证 | 相关测试、Quick、Full、必要的真实回归 | 只报告已经实际取得的证据 |

## 2. 调查范围与约束

调查覆盖：

- Controlled Browser Agent 的 Observation、动作 dispatch、settle、cycle fuse 和终态解析；
- Publisher 页面分类、Challenge/entitlement marker 和 Browser route 结果；
- Network response/download correlation、capture guard、candidate/capture 生命周期和 cleanup；
- `--debug` 下实际发送给 Agent 的图片是否可复核；
- 旧真实运行中所谓“回滚”是否是业务数据回滚，还是尚未交付资源的运行时清理。

必须保持的边界：

- 不记录 prompt、模型原文/reasoning、页面正文、Cookie、Token、完整 URL、selector 或签名 locator；
- 不把截图、PDF、用户 catalog 或真实凭据写入仓库；Debug 图片只进入系统临时目录；
- 不把 Candidate 误报为已交付 PDF；不放宽 destination/capture guard，不删除 cycle fuse；
- 不改变已发布 Catalog/Artifact 事实的不可回滚语义；
- 当前工作树已有大量用户和前序任务改动，不回滚、覆盖或顺手提交无关文件。

## 3. 已读取的证据

### 真相源与计划

- `AGENTS.md`、`HARNESS.md`；
- `docs/architecture/requirements.md`；
- `docs/architecture/design.md`；
- `docs/architecture/technical/agents.md`；
- `docs/architecture/technical/acquisition.md`；
- `docs/architecture/technical/network.md`；
- `docs/architecture/technical/logging.md`；
- `docs/architecture/decisions/0017-shared-agents-and-controlled-browser-agent.md`；
- 前序归档 `docs/archive/2026-09-02-agent-behavior-and-feedback-repair/` 与 `docs/archive/2026-09-03-browser-observation-readiness/`。

### 实现与测试

- `src/sciretriever/agents/runtime.py`、`agents/debug.py`、`bootstrap/assembly.py`：Provider 调用前图片记录和安全调用日志；
- `src/sciretriever/acquisition/browser_control.py`：封闭动作、Observation binding、settle、self/cycle fuse 和 Agent 终态；
- `src/sciretriever/acquisition/sources/browser.py`：Publisher 分类、entitlement marker、Browser route 和候选结果；
- `src/sciretriever/network/browser.py`：响应/下载接管、correlation、capture、article session、cleanup；
- `src/sciretriever/network/playwright.py`、`network/cloakbrowser.py`：vendor 过渡信号转换；
- `tests/test_agents.py`、`test_browser_agent_control.py`、`test_browser_agent_integration.py`、`test_browser_challenge_lifecycle.py`、`test_network_browser.py`、`test_network_playwright_control.py`、`test_acquisition_browser.py` 及相关 Completion 测试。

## 4. 已确认的真实运行事实

旧真实运行证据：

- 日志：`/tmp/sciretriever-browser-elsevier-final-7vGhWL/debug.log`；
- 结果：`/tmp/sciretriever-browser-elsevier-final-7vGhWL/result.json`。

事实链如下：

```text
初始页面 page_state=challenge
  -> Agent Provider 调用成功（共 5 次，provider=qiuzk，wire model=gpt-5.6-luna，stream=on）
  -> Agent 选择 click-point；Network receipt=applied
  -> 点击后短时间仍为 challenge，随后页面变为 normal
  -> 没有匹配 sciencedirect-entitled，也没有其它明确 entitlement 证据
  -> 没有 BrowserCaptureState.CANDIDATE
  -> 没有 BrowserCaptureState.CAPTURED
  -> 没有 PDF response 或 native download
  -> Agent 后续执行两次 scroll-surface
  -> 语义状态出现 A -> B -> A
  -> repeated-cycle-edge fuse 安全停止
  -> Acquisition 将结果记为 normal-miss，primary_pdf=null，missing_step=primary-pdf，needs_manual_pdf=true
```

旧日志中的语义 fingerprint 片段：

```text
challenge: 631207...
点击后仍 challenge
challenge 清除后的 normal: 6370e8...
第一次滚动后: c587aa...
第二次滚动后回到: 6370e8...
再次从 6370e8... 执行相同滚动意图时，cycle fuse 停止
```

因此目前最强结论是：点击动作确实送达并改变了页面状态，但在本次运行里没有任何证据证明 PDF 曾经由响应或下载事件出现；停止是防止 Agent 在无新语义进展时无限滚动的安全停止，不是已捕获 PDF 的业务回滚。

## 5. “回滚”的代码含义

当前没有发现 Literature、Asset、Catalog 或已发布 PDF 的业务回滚路径。`BrowserClient` 的 cleanup 只处理运行时资源：

- 关闭 page/context/process；
- 删除尚未交付的 native download；
- 关闭临时 stream；
- 清空 pending request/download correlation；
- 清理 Browser 操作临时目录；
- 释放 host/scope permit。

这属于 runtime resource cleanup，不等于业务事实撤销。安全语义要求：尚未完成文章事务的候选在 cleanup/runtime failure 后不能交付；已经发布到 Catalog/ArtifactStore 的事实不得被 cleanup 删除或回滚。

需要补足的可见性是：当前 `BrowserClient.run()` 在 cleanup error 时可能以 cleanup failure 替换此前结果，用户容易把它理解成“回滚”。日志应明确同时给出 cleanup 前 capture 数、结果是否含 capture、cleanup 范围、cleanup 结果，以及业务结果是否已经发布/仍可交付。

## 6. 调查前未知项与已补齐证据

在补充 Debug 图片之前，旧运行没有保存 Agent 图片，因此以下问题不能仅凭旧日志推断。第 6.1 节的真实 Debug 基线已经补齐了本次 Elsevier 运行的证据；其它 Publisher 仍不能套用这条结论：

- Challenge 是否在视觉上真正消失；
- Challenge 后是否出现 PDF 按钮、viewer、iframe 或下载入口；
- Agent 是否看见入口、是否选中了错误的 surface/滚动方向；
- 页面是否是 paywall、登录页、空白页、错误页或仅有摘要；
- 两个相同 semantic fingerprint 的 observation 是否有视觉差异；
- 是否出现过被 capture guard 拒绝或 correlation 丢失的非 PDF 资源。

这些问题在没有图片和逐轮状态证据时不能被“没有 PDF”反向解释为 Agent 错误或页面错误。对本次 Elsevier 运行，6.1 已用图片、页面分类、Network 事件和状态机证据完成逐轮对照。

### 6.1 真实 Debug 基线：Elsevier 页面证据（规则修复前，2026-09-03）

这次真实 `--debug complete pdf` 运行发生在 `sciencedirect-pdf@4` 未订阅正文 marker 加入之前，因此它是本次方案的调查基线，不是修复后的线上验收。证据保存在系统临时目录（未进入仓库）：

- Debug 日志：运行目录中的 `debug.log`；标准输出文件 `stdout.json` 只包含一条 `needs_manual_pdf` 结果；
- Agent 图片目录名：`sciretriever-agent-debug-tly4w5ki`；`manifest.ndjson` 将 5 次 Provider-bound 图片输入与调用序号对应；
- 目标：本计划第 4 节所述 Elsevier 文章记录。

逐轮对照结果：

| Agent 输入 | 页面/状态机证据 | Network/结果证据 |
| --- | --- | --- |
| 第 1–2 轮 | Cloudflare “Are you a robot?” 页面；`page_state=challenge`；同一页面指纹只有尺寸/渲染细节变化 | Provider 调用成功；没有 PDF capture |
| 第 3 轮 | Challenge 清除后进入 ScienceDirect 文章预览；截图可见包含 `does not subscribe to this content on ScienceDirect` 的未订阅提示（机构名称不记录）；`page_state=normal`、`entitlement=unknown` | 没有 `CANDIDATE`、`CAPTURED`、PDF response 或 native download |
| 第 4 轮 | Agent 将页面向下滚动到摘要；仍是文章预览，没有订阅权限，也没有 PDF 入口 | 仍无 PDF response/download/capture |
| 第 5 轮 | Agent 收到与第 3 轮语义等价的页面并再次滚动；状态机识别已知 cycle edge | `terminal_cause=repeated-cycle-edge`，`capture_state=none`，最终为 `normal-miss` / `needs-manual-pdf` |

这条证据把本次具体失败从“页面没有资源 / Agent 未找到入口 / capture 失败”三者中的未定状态收敛为：**页面已经明确展示未订阅提示，旧规则没有识别该提示，因此 Agent 在无 PDF 入口的页面上继续探索，最后由 cycle fuse 安全停止**。仍需保持的谨慎边界是：本结论只适用于这次 Elsevier 运行，不推断其它 Publisher 或其它机构身份。

同时确认一个实现层缺口：ScienceDirect 的未订阅提示是稳定的正文语义，但旧版 `sciencedirect-pdf` 规则只有 CSS/HTTP marker，没有相应的 `NOT_ENTITLED` text marker。因此旧运行只能记录 `entitlement=unknown`，不能在第一次 normal observation 时给出明确的 `not-entitled` 终态。

### 6.2 修复后真实回归：首次运行事实（2026-09-04）

按本计划的剩余验收项，使用同一条 Literature 执行了单篇真实命令：

```text
uv run --frozen sciretriever --debug complete pdf --literature-id <同一 Literature ID> --json
```

stdout、stderr 和 Debug 图片均写入系统临时目录；本节不记录凭据、PDF 字节或完整请求地址。外层 shell 汇总退出码时误用了 zsh 保留变量，导致包装命令最终返回 `1`，但 SciRetriever 已经写出完整 JSON，故业务结果以 JSON 为准。

已确认事实：

- JSON 为 `database-completion`、`goal=ASSET_READY`，目标未进入 `goal_reached`、`needs_manual_pdf` 或 `interrupted`；
- 目标进入 `failed`，阶段为 `acquisition`，稳定失败码为 `browser-agent-internal`，不是预期的 `not-entitled`；
- Debug 日志显示 Browser Agent 实际完成了 2 次 Provider Model 调用（`stream=on`、图像输入、工具决策）并发送了 1 次 `click-point`；动作 dispatch 为 `applied`，随后页面仍分类为 `challenge`；
- Network 未记录 PDF response、native download 或 capture，cleanup 前 capture 数为 `0`，cleanup 本身成功；
- 本次运行创建了 Debug 图片目录并保存了至少两轮实际发送图片；
- 当前 Agent 结果被记录为 `browser-agent-internal`，日志中的 `action_count` 与 `model_call_count` 被重置为 `0`，说明控制器内部异常被统一的内部错误兜底覆盖，尚未能从稳定结果直接看出原始异常点。

本节只固化运行事实，不把 `browser-agent-internal` 的具体原因提前归因。下一步先检查该异常发生在哪一个已记录的 Browser transition 边界；若需要改代码，先在本计划的调查区补充根因和最小方案，再进入实施区。

### 6.3 修复后真实回归：正文未订阅路径（2026-09-04）

在 ScienceDirect 规则加入 `NOT_ENTITLED` 正文 marker 后，使用同一条 Literature 再次执行单篇真实命令：

```text
uv run --frozen sciretriever --debug complete pdf --literature-id <同一 Literature ID> --json
```

证据目录仍在系统临时目录，不进入仓库：

- 结果：`/tmp/sciretriever-live-WvJTMh/result.json`；
- Debug 日志：`/tmp/sciretriever-live-WvJTMh/debug.log`。

本次运行确认：

- JSON 结果为 `needs_manual_pdf`，`failed=0`、`interrupted=0`，没有交付 PDF；
- 页面分类稳定为 `page_state=not-entitled`、`entitlement=denied`，命中 `sciencedirect-not-entitled`；
- Browser Agent 在终态页前停止，`agent-model-call-count=0`、`agent-action-count=0`，没有再出现 `browser-agent-internal`；
- 没有 PDF response、native download 或 capture，cleanup 前后 capture 数均为 `0`，cleanup 成功且结果未被替换；
- 该结果证明未订阅页面路径已经可解释、可安全停止；由于目标文章没有可用订阅，尚不能以此运行证明“已授权页面的 Agent 点击和 PDF capture”成功。

这次运行同时确认上一节的内部异常不再复现，但没有把“未订阅”推断为任意 Publisher 的通用结论；要验收 Agent 实际操作和 PDF 交付，还需要一条明确有权限且存在 PDF 入口的真实 Literature。

### 6.4 独立 Browser Model 真实探针（2026-09-04）

为把“页面未订阅而未调用 Agent”和“Agent 模型本身是否可用”分开，另外执行了不携带文献、页面或 PDF 的 Browser Model probe：

```text
uv run --frozen sciretriever --debug config test browser model --json
```

结果保存在系统临时目录（不进入仓库）：

- 结果：`/tmp/sciretriever-browser-model-wtFQDO/result.json`；
- Debug 日志：`/tmp/sciretriever-browser-model-wtFQDO/debug.log`。

已确认：

- probe `outcome=passed`、`local_ready=true`，且 `persisted=false`；
- Provider 为 `qiuzk`，wire model 为 `gpt-5.6-luna`，协议为 `openai-responses`，请求为 `POST`，`stream=true`；
- 发送 1 张合成图片和 1 个工具声明，Provider 返回可解析的 tool decision；
- 日志未记录文献、页面正文或 PDF，未暴露凭据。

这证明当前 Agent Provider/Model、图片输入、工具决策和默认 stream 配置可以独立工作；它仍不等价于“在有权限的真实 Publisher 页面上点击并捕获 PDF”。

### 6.5 开放许可文章的真实 Agent 回归（2026-09-04）

为验证实际页面动作与 PDF capture，从本地仍缺 `primary-pdf` 的记录中选择了两个已由公开元数据确认许可的候选；所有运行仍只针对单篇 Literature，证据保存在系统临时目录。

第一条 RSC Advances 候选具有 `CC BY-NC 3.0` 许可，但 DOI 服务返回的第一跳是 `http://pubs.rsc.org/...`。SciRetriever 安全策略拒绝该非 HTTPS 中间跳转，最终为 `acquisition-doi-resolution-network-failed`，没有进入 Browser。证据：

- `/tmp/sciretriever-rsc-agent-cDyEVQ/result.json`；
- `/tmp/sciretriever-rsc-agent-cDyEVQ/debug.log`。

第二条 Wiley Advanced Energy Materials 候选具有 `CC BY-NC 4.0` 许可，DOI 直接落到已允许的 Wiley HTTPS origin，因此进入了真实 Browser Agent 流程。证据：

- `/tmp/sciretriever-wiley-agent-5cwFiL/result.json`；
- `/tmp/sciretriever-wiley-agent-5cwFiL/debug.log`；
- Agent 图片目录 `/tmp/sciretriever-agent-debug-qb7kjqyv`。

已确认事实：

- Browser 最初处于 Cloudflare Challenge；Agent 完成 3 次模型调用并发出 1 次 `click-point`，Network receipt 为 `applied`；
- Challenge 页面随后自动转向 Wiley 的外部身份服务 origin；该跨 origin 顶层导航不在当前规则允许集合中，Network 连续拒绝并返回 `acquisition-browser-policy-failed`；
- 最终仍无 PDF response、native download 或 capture，capture 数为 `0`；cleanup 成功，结果没有被替换；
- 本次不再出现 `browser-agent-internal`，最终证据保留 `agent-model-call-count=3`、`agent-action-count=1` 和最后的 `click-point`；
- Debug 保存了三张实际模型输入图：前两张是 Challenge 的自动验证/人工复选框状态，第三张是受策略阻断后的浏览器错误页。图片中可能含短期页面参数，不进入仓库、普通日志或文档正文。

因此该次运行证明 Agent 能看到 Challenge、选择动作并由程序执行，但也暴露两个发生在 PDF capture 之前的独立站点接入缺口：RSC 的 HTTP 中间 DOI 跳转，以及 Wiley 的外部身份服务导航。是否允许、如何限定这些 origin 必须先按 Network/Publisher 安全边界设计和测试，不能为了单次成功临时放宽。

### 6.6 ACS 开放可读文章的真实 Agent 回归（2026-09-04）

为避开 RSC 的非 HTTPS DOI 中间跳转和 Wiley 的跨 origin 身份服务，选择 DOI `10.1021/acsami.4c13590` 进行第三次单篇验证。OpenAlex 将该文章标记为公开可读 `bronze`，并给出 ACS 官方 PDF 位置；普通 HTTP 客户端访问出版商页面会得到 `403`，因此该样本既有可用 PDF，又确实需要 Browser 接管。运行证据保存在系统临时目录：

- 结果：`/tmp/sciretriever-acs-agent-AoBLgz/result.json`；
- Debug 日志：`/tmp/sciretriever-acs-agent-AoBLgz/debug.log`；
- Agent 图片目录：`/tmp/sciretriever-agent-debug-f_9fp4f5`。

已确认事实：

- Browser Agent 完成 4 次模型调用，实际 dispatch 了 `click-point` 和 `wait-for-change` 两个动作；重复的 `wait-for-change` 被 cycle fuse 在 dispatch 前安全阻止；
- `click-point` receipt 为 `applied`，图片依次显示自动验证、人工验证提示和验证成功等待 Publisher 响应；
- 点击后 Network 明确观察到 `media-category=pdf`、`download-expected=true` 的 capture candidate，并收到一次 native download；这证明正确的 PDF 网络事件已经真实发生；
- 同一时刻 Publisher 页面分类仍为 `page_state=challenge`，capture permission 为 false；response candidate 和 native download 均被 `capture-guard` 拒绝，最终 capture 数为 `0`；
- 运行最终以 `acquisition-browser-challenge-no-progress` 结束，cleanup 前仍能看见一个未交付 download，cleanup 成功且没有业务 PDF 被发布。

这次结果把故障边界进一步收敛为：Agent 已成功点击 Challenge，Publisher 也已返回 PDF；失败不在模型、点击或“页面是否存在 PDF”，而在 Challenge 成功到可信 PDF capture 许可之间的状态交接。当前最强假说是验证成功后的残留 Challenge DOM/text 使页面分类尚未退出 `challenge`，导致 capture guard 拒绝同时到达的真实 PDF；在检查 guard 的精确绑定与更新时机前，不能把该假说当成已证明根因，也不能简单允许 Challenge 状态下的任意 PDF。

### 6.7 同一 ACS 文章的会话复测（2026-09-04）

在首次验证可能已经建立 Publisher 会话后，再次只运行同一 Literature。证据保存在：

- 结果：`/tmp/sciretriever-acs-retry-uWG8mk/result.json`；
- Debug 日志：`/tmp/sciretriever-acs-retry-uWG8mk/debug.log`。

复测时重新查询 OpenAlex：题名为 *Organic Battery Materials*，`is_oa=true`、`oa_status=bronze`，最佳开放位置是 ACS 的 published version 且存在 PDF URL；OpenAlex 没有提供机器可读 license。因此这里严格称为“Publisher 官方公开可读”，不把 bronze 状态误写成某一种开放许可。

本次取得了更精确的时序证据：

```text
Browser 顶层导航
  -> 301
  -> 200 PDF response（correlation matched）
  -> capture candidate 登记，但 capture-allowed=false
  -> native download 到达，被 capture-guard 拒绝
  -> Browser Agent controller 启动并进行首次 Publisher observation
  -> 页面分类为 normal、Challenge marker 未命中
```

Agent 随后完成 2 次模型调用、实际 dispatch 1 次 `wait-for-change`，最后由 cycle fuse 以 `no-progress` 停止；capture 数仍为 `0`。本次 CLI 进程正常完成并返回退出码 `0`，但目标结果明确列入 `failed`：此前 direct public locator 的 `403` 被保留为最终稳定失败 `acquisition-public-locator-response-failed`，不能把进程退出码误读为文章成功。

本次 Debug 目录保存了两张实际发送给 Agent 的图片，二者 hash 相同且都是空白白页；不包含可点击 PDF 入口。结合已经收到 native download 的 Network 证据，这不是 Agent 漏看按钮，而是 PDF 导航已经转为下载、正文页面没有留下可供 Agent 操作的 UI，随后让 Agent 在空白页上等待没有意义。

这次复测推翻了“只有残留 Challenge 分类导致拒绝”的过窄解释：即使随后页面已经是 `normal`，正确 PDF 也可能在 controller 首次观察并更新 capture permission 之前到达。当前更强的根因方向是 **Browser 导航开始时 capture guard 尚未绑定可接受的文章事务，首个、且可能唯一的 PDF response/download 因初始化竞态被 fail-closed 丢弃**。仍需从源码确认许可的所有者、建立条件和生命周期，再设计既不接受任意跨站 PDF、又不丢失已关联首导航 PDF 的安全交接。

## 7. 无 PDF 的候选根因分类

后续日志和测试必须把以下类别分开，而不是统一写成 `normal-miss` 或 generic runtime failure：

1. **页面没有可用资源**：Challenge 已清除，但 entitlement/PDF 入口不存在，或明确 paywall/not-entitled/access-denied；
2. **Agent 决策未找到入口**：页面 observation 中存在可操作入口，Agent 仍重复无效动作或选择错误 surface；
3. **没有 PDF 网络事件**：页面没有发起 PDF response/native download；
4. **Capture guard 拒绝**：有 response/download，但 destination、媒体类型、来源或授权条件不满足；
5. **Correlation 失败**：事件出现，但 request/response/download 无法证明为已接管的 article-local 资源；
6. **Capture 尚未完成**：候选已登记但 body/callback 在 deadline、取消或 successor 交接前未完成；
7. **状态机安全停止**：Observation 语义重复形成 self/cycle edge，或达到动作/模型调用上限；
8. **Cleanup failure**：运行时资源未完整释放，导致尚未发布的 capture 不可交付；
9. **真正运行时失败**：Browser/context/process 退出、不可恢复 vendor 错误、取消或 deadline。

## 8. 实施方案（调查冻结之后执行）

### 8.1 页面分类证据

在 Publisher 分类和 Agent observation 边界记录脱敏 Debug 证据：`page_state`、`authenticated`、entitlement 的 `present/unknown/denied/conflict/not-configured` 语义、匹配的静态 marker kind/id、`actions_require_entitlement`、HTTP status、surface/element 数、root scroll `y/max_y`、revision、capture state 和最近 action receipt。`entitled=False` 只表示没有 `ENTITLED` marker，不能直接当作 denied。

### 8.2 Network response/download/capture 证据

在 response、download、capture body、client observation 处记录安全分类：HTTP status/class、`pdf/other` media category、capture kind、capture allowed、download expected、request correlation、`accepted/pending-candidate/rejected/ignored/non-2xx/non-correlation/captured` 结果、body bytes、capture count、pending/local download 数和 callback 数。目标是明确区分“没事件”“事件被拒绝”“候选未完成”“native download correlation miss”和“已捕获后交付失败”。

### 8.3 Cycle-stop 证据

把 cycle 记录从只保存 fingerprint 的 `dict[(before, intent)] -> after` 扩充为 payload-free transition evidence：前后 fingerprint、page id、revision、page state、capture state、surface 数、root scroll、action intent、dispatch receipt 和 settle outcome。在 fuse 停止前输出前后证据、`page_id_changed`、`scroll_changed`、是否同一 intent 及当前 capture state。先增加证据，不删除 fuse，也不根据猜测放宽循环规则。

### 8.4 Cleanup/result 证据

在 `BrowserClient.run()`/cleanup 记录 cleanup 开始前 capture 数、result 是否含 capture、runtime resource counts、cleanup scope/outcome、result 是否因 cleanup 被替换，以及业务结果是否已发布/仍可交付。保持既有 fail-closed 语义：未发布 capture 在 cleanup failure 后不能交付，已发布事实不能回滚。

### 8.5 Debug 图片

继续使用显式 `--debug` 才启用的 `AgentDebugImageRecorder`，确保它记录 Provider adapter 实际收到的 `AgentProviderCall.image_parts` 原始字节，而不是更早或另造的截图。每轮保存图片和 `manifest.ndjson`（序号、role、媒体类型、尺寸、字节数、hash），目录使用 `sciretriever-agent-debug-*`、权限 0700/0600；不写 prompt、输出、URL、Cookie、Token 或 reasoning。写盘失败只产生 warning，不改变 Agent 调用。

### 8.6 基于真实证据已实施的根因修复

在不扩大 Browser 能力边界的前提下，已为 ScienceDirect 规则增加一个限定在 `body` 文本中的 `NOT_ENTITLED` marker，匹配本次已观察到的稳定短语（同时保留已有 paywall/CSS marker）。分类命中后：

1. 将页面状态设为 `not-entitled`、`entitlement=denied`，并记录 marker id；
2. 在 Agent 决策前结束该候选，不再发送无意义的滚动调用；
3. 返回现有的、可重试语义明确的未订阅失败/正常 miss 结果，不改变 capture guard、destination guard、cycle fuse 或 Catalog 事务；
4. 用离线页面 fixture 覆盖命中与相似但不命中的文本，避免把普通文章正文误判为权限拒绝；规则 revision 升至 `4`，并同步 production catalog 与 fixture。

这是规则证据补全，不是为某一次页面硬编码“看到截图就停止”；如果真实页面改版导致短语消失，仍回到 `entitlement=unknown` 并由现有安全停止路径兜底。本阶段没有新增外部调研，新增判断均来自第 6.1 节的已记录证据。

## 9. 已实施内容、直接回归测试与验收标准

调查已经先在本计划第 4-7 节固化；第 8 节方案随后已落地到源码、测试和技术文档。本轮实现闭环包括：

- `AgentDebugImageRecorder` 只在显式 Debug object graph 中启用，在 Provider adapter 调用前保存实际 `image_parts`，并用受限权限的 `manifest.ndjson` 记录序号、role、媒体类型、尺寸、字节数与 hash；普通日志只显示 `directory_name`，不显示机器相关绝对路径；
- Browser Agent 终态携带 `model_call_count`、`terminal_cause`、最后动作和 capture state；route/candidate evidence 同时记录 Agent disposition、终止原因、动作/模型调用次数、capture state 和 failure code；
- `CANDIDATE`、`CAPTURED` 与 `NONE` 的结果组合在 `BrowserAgentResult` 构造时校验，不能把候选误报成已交付 PDF；
- Network 诊断中的 vendor resource token 只保留有限公共类别，未知值折叠为 `other`，异常值折叠为 `unknown`；
- ScienceDirect `sciencedirect-pdf@4` 增加未订阅正文 marker；命中后在 Agent 决策前进入 `not-entitled`/`entitlement=denied`，不再发送滚动或点击调用；
- 保留 readiness/settle、self/cycle fuse、capture guard、correlation guard 和 cleanup 的 fail-closed 语义，不把 runtime cleanup 描述为业务回滚。

最终工作树的离线验证证据（包含 marker、revision 和格式修正）：

```text
相关 Browser/Agents/Network/Acquisition 回归 unittest: 93 tests, OK
scripts/harness.py quick: passed
scripts/harness.py full: passed（全量 unittest discovery 当前计数 2277）
  - Pyright: 0 errors, 0 warnings, 0 informations
  - 全量 unittest: passed（Harness test gate）
  - wheel build: passed
  - wheel contents: passed
Ruff check/format/compile（Quick 内）: passed
git diff --check: passed
```

新增的 Debug 日志回归还验证了：日志包含临时目录名而不包含绝对临时路径。以上证据证明实现和离线对象图闭环，不证明任意真实 Publisher 会产生 PDF。

验收清单：

- [x] Debug 每轮保存实际 Browser 图片；非 Debug 不保存；写盘失败不影响 Agent；
- [x] Challenge 点击后变 normal 但 entitlement unknown、无 candidate 时，结果明确为 normal miss；
- [x] ScienceDirect 未订阅正文命中 `NOT_ENTITLED` marker 时，进入 `not-entitled`/`entitlement=denied`，Agent model call count 为 0；
- [x] candidate 出现但尚未 captured；response 出现但 capture guard 拒绝；
- [x] response/download correlation miss 有明确事件；
- [x] scroll A → B → A 的 cycle 日志含前后 page/scroll/revision/page-state 证据；
- [x] page/frame/popup successor 可观察；真正 Browser/context/process 退出仍返回 failed；
- [x] cleanup 日志区分 runtime resource cleanup 与业务结果保留/不可交付；
- [x] 既有安全边界、Report、Catalog、资产不可变和 normal-miss 失败选择不变。

真实环境证据与剩余验收：

- [x] 修复前的真实 `--debug complete pdf` 调查已逐轮对照日志、图片目录/manifest、Network 事件和最终结果，并确认本次 Elsevier 失败属于明确未订阅页面；
- [x] 修复后再次运行真实 `--debug complete pdf`，确认线上页面仍命中正文 marker，并验证 `agent_model_call_count=0`；该项已在真实 Publisher 环境完成。当时尚不能证明已授权页面的 Agent/PDF 路径，后续 ACS 条目补齐了这一诊断样本。
- [x] 使用 ACS 官方公开可读文章完成可访问样本回归：Agent 点击、200 PDF response 和 native download 均有真实证据；capture guard 因交接时序拒绝候选。该结果完成“解释无 PDF”的诊断目标，但不冒充 PDF 获取成功；修复属于新的 Browser capture handoff 工作。

验证顺序：相关 unittest → `scripts/harness.py quick` → `scripts/harness.py full` →（如获授权）修复后真实 `--debug complete pdf` 回归。每次真实运行必须检查图片目录、日志和结果三者是否能解释同一轮状态；不读取或展示凭据。

## 10. 停止条件与残余风险

若实现要求新增站点 selector/固定等待、放宽 destination/capture guard、持久化截图/页面正文、改变 Catalog/Artifact 事务、读取未授权凭据或修改公开 schema，先暂停并更新 ADR/计划，不直接实现。

修复前的真实基线已经足以断言本次运行：页面明确无当前机构订阅、没有已记录的 PDF response/download/capture，cycle fuse 是安全停止，未发现业务回滚。修复后的真实回归已确认该页面仍命中 marker，并以稳定的 `not-entitled` 终态结束；这不代表任意 Publisher 或已授权页面的线上保证。其它残余风险仍包括页面改版、机构 entitlement 变化、Network correlation 失败和真实 Browser runtime 差异。

## 11. 计划变更记录

| 日期 | 变化 | 原因 | 影响 |
| --- | --- | --- | --- |
| 2026-09-03 | 创建调查记录并标记 Ready for implementation | 用户要求先保存已有调研结果，再提出方案并实施，避免重复调研 | 先固化事实，再进入实现 |
| 2026-09-03 | 调查后的方案已实施；状态改为 Implemented / Offline verification passed | 完成 Agent 图片 Debug、Browser 终止证据、capture-state 不变量、Network resource token 脱敏及直接回归；Quick、Full 和 diff 检查通过 | 真实 Debug Publisher 回归仍需单独授权和执行，不能由离线测试代替 |
| 2026-09-03 | 将真实运行明确标记为“修复前基线”，并实施 `sciencedirect-pdf@4` 未订阅正文 marker | 避免把调查证据和修复后验收混为一谈；新增规则 fixture 与 Agent/Rules 直接回归 | 修复后真实 Publisher 回归仍是独立验收项 |
| 2026-09-03 | 增加 ScienceDirect 未订阅正文近似文本的反误判回归 | 让“命中与相似但不命中”两条规则证据都可复核 | 相关回归增至 93 项，保持 marker 精确匹配 |
| 2026-09-03 | 修正 Provider 说明中“正文读取”表述 | 实现会在分类边界短暂读取受限文本，但不记录或持久化正文；文档必须与实际行为一致 | 明确隐私边界，避免把瞬时分类读取误解为正文留存 |
| 2026-09-03 | 最终工作树重新通过相关测试、Quick、Full 和 diff 检查 | marker/revision 修改后重新取得门禁证据，修正一处 Ruff 格式问题 | 离线对象图闭环；不替代真实线上回归 |
| 2026-09-03 | 补充流程说明，明确本计划是部分实施后的事实固化，并冻结后续阶段门 | 响应“先记录调查、再定方案、再修改”的协作要求，避免把回填文档误述为原始时间线 | 后续新增事实必须先进入调查区；修复后真实 Publisher 回归仍待授权 |
| 2026-09-04 | 修复后真实回归完成；正文未订阅路径通过 | 同一条 ScienceDirect Literature 命中 `NOT_ENTITLED`，没有 Agent 内部异常，计数保持为 0，cleanup 成功 | 已完成未订阅路径验收；可访问页面的 Agent/PDF capture 仍待真实样本 |
| 2026-09-04 | Browser Model 独立真实探针通过 | 合成图片/工具请求被 `qiuzk/gpt-5.6-luna` 接受并返回可解析 tool decision，未持久化任何结果 | Agent Provider/Model 基础链路可用；真实授权页面的动作与 PDF capture 仍待样本 |
| 2026-09-04 | ACS 开放可读文章真实回归发现 capture 状态交接缺口 | Agent 点击验证后真实 PDF response/native download 已出现，但页面仍分类为 Challenge，capture guard 拒绝交付 | 已排除模型、点击和资源不存在；需复测并审查 Challenge 到 capture permission 的安全交接 |
| 2026-09-04 | 同一 ACS 文章会话复测复现 PDF 被 guard 拒绝 | 关联成功的 200 PDF 顶层导航早于 controller 首次观察到达；随后页面已为 normal，capture 仍为 0 | 根因方向收敛到导航与 capture permission 初始化时序，而非只归因于残留 Challenge DOM |
| 2026-09-04 | 调查与可观测性计划完成并移入归档 | 真实样本已经区分 Agent、页面、Network、capture guard 和 cleanup，原计划诊断目标闭环 | 不在旧计划内扩张实现；Browser capture handoff 作为独立后续变化重新计划和验收 |
| 2026-09-04 | 建立 [Browser Capture 交接修复计划](../2026-09-04-browser-capture-handoff/README.md) | 归档交接最初只有文字、没有活动执行入口；用户指出遗漏 | 后续合同、实现、验证与授权状态均由新计划追踪，本归档停止更新实施状态 |
