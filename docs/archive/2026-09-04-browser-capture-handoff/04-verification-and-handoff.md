# Block 4：验证、文档与真实交接

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | BCH18–BCH23 |
| 前置块 | Blocks 1-3 Completed |
| 下游块 | 无；R5 后完成或返回对应 Block |
| 恢复点 | 无；离线实现、文档、Full 与 R5 已闭环，真实 ACS 未授权状态已交接 |

## 块结果

证明新的 capture handoff 在生产对象图、共享 persistent Browser 等价环境和全部离线门禁下成立，并
同步长期合同与当前行为文档。获得授权时只重跑固定 ACS 样本，以“有效主 PDF 已发布”为真实通过
标准；任何相反事实都回到对应 Block，不以页面成功或进程退出码代替验收。

## 进入条件

- Blocks 1-3 的 Tasks、直接测试和 R3 均通过；
- ADR、Network/Acquisition 实现与 production Bootstrap 只存在一套合同；
- 工作树无凭据、Profile、PDF、数据库、截图或构建产物；
- 真实回归是否获授权已经明确，未授权时保持离线模式。

## 责任与改动面

- Owner：Primary Agent；
- 主要文件：跨模块集成/acceptance 测试、`docs/architecture/technical/acquisition.md`、
  `technical/network.md`、必要的 `README.md`/用户指南、本计划完成证据；
- 验证对象：Network、Acquisition、Agents controller 门控、Bootstrap、Entry Report、PDF publication；
- 受保护：真实用户配置/凭据/Profile/Catalog、其它工作树改动、CI/Harness 定义。

## 需要保持的行为

- 测试/Harness 不联网、不读取真实配置或用户 Catalog；
- 真实回归只在单独授权后运行固定 Literature，不扩大到 pending 集合；
- Debug 图片、日志和 PDF 只进入 owner-only 系统临时目录；
- Full 失败不能通过删测、放宽类型或排除文件恢复绿色；
- 文档不把未完成或单站成功写成普遍 Publisher 保证。

## Tasks

- [x] **BCH18 — 完成生产对象图集成矩阵。** 使用 Bootstrap 等价组装覆盖 direct PDF early response、
  Challenge action early response、persistent-clearance、response/download duplicate 和 Report。
  - 验收：不使用预先全允许的 fake guard；真实 policy、controller 和 Network handler 同时参与。
- [x] **BCH19 — 完成本地 Cloak Browser 回归。** 扩展本地 HTTPS Challenge fixture，使同一 fixed identity
  第一轮通过 Challenge，第二轮新 article operation 不加载 Challenge resource 而直接返回 PDF。
  - 验收：两轮均捕获正确 PDF，第二轮 admitted Challenge 计数为 0；错误文章对照不读取正文。
- [x] **BCH20 — 回归资源与失败矩阵。** 运行 Network/Acquisition/Agents/Entry 相关测试，检查取消、
  timeout、late event、cleanup、批量局部失败和最深主失败。
  - 验收：全部通过，日志/Report transcript 不含 URL/query/secret/正文。
- [x] **BCH21 — 同步文档。** 更新 ADR amendment、Acquisition/Network technical、必要用户指南和
  documentation map 影响项；明确两阶段 Candidate 与 Agents 无新增权限。
  - 验收：目标文档说应当如何，当前文档只写已经实现并验证的行为；相对链接有效。
- [x] **BCH22 — 运行完整门禁与最终 Review。** 相关测试后运行 Quick、Full、wheel 内容核对、
  `git diff --check`、secret/个人路径/临时产物扫描和 R5 语义审查。
  - 验收：Full 退出码 0，Pyright strict、全量 unittest、build/wheel 均通过；无夹带改动。
- [x] **BCH23 — 处置单篇真实验收授权门。** 获得授权时仅运行固定 ACS Literature，核对 JSON 业务结果、
  capture/validation/publication、Catalog `primary-pdf` 和 Debug 图片。
  - 验收：成功标准是主 PDF 被验证并接纳；若仍失败，记录精确新证据并返回对应 Block；不得运行
    `--all-pending`。本轮没有真实 Publisher、Model 或用户 Catalog 授权，因而未执行并作为残余风险交接，
    不把本地 fixture 写成真实站点通过。

## 执行方式与集成点

顺序为生产矩阵 → 本地 Cloak → 全部相关回归 → 文档 → Quick/Full/R5 → 获授权真实单篇。
真实运行永远不作为调试循环；离线证据未全绿前不访问 Publisher。若真实结果与合同冲突，先写入本计划
事实/变更记录，再返回 Blocks 1-3，不直接在现场补 selector 或放宽 guard。

## 审查门

- R1：验证命令、离线/真实边界和目标 Catalog 已解析；
- R2：集成测试必须经过真实 rule policy，不由 fake 直接返回 capture；
- R3：相关测试与文档闭环；
- R5：用户结果、安全、owner、错误、数据、依赖、打包、真实授权和最终 diff 全面审查；
- blocking：Full 非绿、错误文章被读取、真实范围扩大、凭据/Profile/PDF 进入工作树。

## 接口、数据与依赖影响

- 接口：只验证 Blocks 1-3 已接受的内部一次性切换；
- 数据：离线无变化；真实成功时只通过正常产品事务为指定 Literature 增加主 PDF；
- 配置/schema/依赖：预期无变化；出现变化必须回计划说明并重新审查；
- 发布：本计划不含 commit、push、PR 或发布授权。

## 验证与证据

最低命令集合：

```bash
uv run --frozen python -m unittest discover -s tests -p 'test_network_browser.py'
uv run --frozen python -m unittest discover -s tests -p 'test_network_cloakbrowser_challenge_local.py'
uv run --frozen python -m unittest discover -s tests -p 'test_acquisition_browser.py'
uv run --frozen python -m unittest discover -s tests -p 'test_browser_agent_integration.py'
uv run --frozen python -m unittest discover -s tests -p 'test_browser_challenge_lifecycle.py'
uv run --frozen python -m unittest discover -s tests -p 'test_acquisition_cohorts.py'
uv run --frozen python -m unittest discover -s tests -p 'test_entry_completion.py'
uv run --frozen python scripts/harness.py quick
uv run --frozen python scripts/harness.py full
git diff --check
```

真实命令只有在授权门打开后记录，输出进入 `/tmp/sciretriever-*`；计划只记 payload-free 摘要。

## 退出条件

- BCH18–BCH22 全部完成，BCH23 已成功或其未授权状态被准确交接；
- AC-1–AC-8 和 Full 全部成立；
- 获授权真实验收时 AC-9 得到有效主 PDF，否则计划不能声称真实 capture 已通过；
- R5 无未处理 blocking/material finding；
- 文档和最终 diff 不含敏感/临时/无关内容。

## 完成证据

2026-09-04 完成：

- 生产等价与跨模块矩阵：Acquisition、Agent controller、Challenge、cohort、Bootstrap 和 Entry 共
  212 项通过，1 项按自身环境条件跳过；真实 `_RuleCapturePolicy`、Network handler 与 controller 同时参与；
- Network 直接回归：`test_network_browser.py` 86 项、`test_network_cloakbrowser.py` 30 项、
  `test_network_playwright_control.py` 5 项全部通过；覆盖早到 response/download、三态重新判定、重复交付、
  wrong-article/supplement、candidate timeout、取消、late event 与 cleanup；
- 本地真实 runtime：`test_network_cloakbrowser_local.py` 4 项、Cloudflare-shaped Challenge 1 项、安装后
  JavaScript `fetch -> blob` 1 项全部通过。Challenge 首轮有已审核资源，persistent PDF operation 的
  Challenge 资源计数为 `(0, 0)`，两条路径都取得正确 PDF；
- 目标 Ruff lint/format 与 Pyright 通过；Quick 通过 413 个活动 Python 文件的 lint、format、compile；
  Full 退出码 0，发现 2287 项测试并完成 Pyright strict、全部 unittest、wheel 构建和 wheel 内容核对；
- ADR 0017、Network technical 与 PDF 获取指南已经同步 response/download 仲裁、顶层 native download、
  rejected cleanup reservation、callback drain 和临时 Cloak welcome marker 边界；
- `git diff --check` 通过；旧 `BrowserCaptureGuard/capture_allowed` 只留在本历史计划的 baseline 叙述，
  活动源码、测试和 current architecture/guides 不再存在旧生产合同；
- R5 对用户结果、Acquisition/Network owner、ACCEPT 前 body read、错误文章/补充材料、callback/timeout/
  cancel/late event、persistent context、stderr/log、wheel、配置/schema/依赖和授权范围完成复核，无未处理
  blocking/material finding。新增 diff 没有凭据、个人配置、Profile、PDF、数据库、截图或构建产物；
  工作区既有 ignored 用户材料不属于 diff，也未读取或修改。

本轮唯一 accepted residual risk 是真实 ACS 单篇没有获得外部访问和用户 Catalog 写入授权，因此未执行；
不能据此宣称真实 Publisher 主 PDF 已验收。后续若明确授权，仍须以有效 `primary-pdf` 发布而非页面或
download event 作为通过标准。

## 失败与恢复

- 生产矩阵失败回 Block 2/3 的责任 owner；
- 本地 Cloak 时序不符回 Block 1 更新事实，不直接调等待常量；
- Full finding 回产生它的 Block，修复后重跑相关测试与 Full；
- 真实失败先保存脱敏证据并更新计划，再判断是合同、Network、Acquisition 或站点外部变化；
- 恢复时不重新运行已经通过且未受 diff 漂移影响的高成本真实步骤。

## 下游交接

无下游实现块。完成后更新根 README 的 AC、状态、变更记录和最终交接；长期行为进入 ADR/technical/
current docs，本计划随后按 `docs/plans/README.md` 移入 archive。未完成问题必须建立明确新 owner，不能
只写“后续处理”。
