# BASE-02 盘点证据

日期：2026-09-09；当前工作树复核：2026-09-10

## 来源和方法

本盘点直接读取仓库中的 `src/sciretriever/**/*.py`、`tests/**/*.py` 和
`src/sciretriever/entry/cli/main.py`，用标准库 AST 提取模块、公开符号、adapter 类和方法；CLI 参数规格按
`_build_parser()` 的实际定义记录；配置 section 和字段按 `Configuration.model_fields` 及其嵌套模型记录。
没有读取个人配置、运行时 Catalog、Profile、凭据、文献资产或任何外部服务。

## 结果

| 对象 | 数量 | 清单字段 |
| --- | ---: | --- |
| Python 源模块 | 242 | `modules[]`，含原始基线 235 个模块及迁移期间新增的 7 个活动 bridge |
| 公开 `api.py` 入口 | 8 | `public_entry_points[]`，含 source、target、exported_symbols |
| Metadata adapter | 11 | `metadata_providers[]`，含 adapter symbols/methods 和 neutral contract |
| Acquisition source | 7 | `acquisition_sources[]`，含 source adapter symbols/methods |
| 授权 Acquisition provider | 3 | `acquisition_authorized_providers[]`，含 capability contract |
| CLI command path | 23 | `cli_command_specs[]`，含源码位置和参数 |
| ordinary configuration section | 11 | `configuration_sections[]`，对应 `Configuration` 的顶层字段 |
| 既有 Python 测试文件 | 161 | `direct_tests[]`，每项含 source、area、disposition |

## 结论

- 原始 `master@e1a33d5` 计划基线有 235 个 Python 模块；当前工作树新增 `configuration` 3 个、`entry` 2 个、`parsing` 2 个迁移 bridge，因此活动清单为 242 个。7 个 bridge 已进入 `working_tree_snapshot`，最终由 T012/T041/T042/T044 迁移、T061 退役，不再保留数量疑点。
- 每个源模块都有明确 target、owner 和细化后的 `port`/`redesign` disposition；当前没有批准退役项。
- 每个模块还记录 `consumers`、`task_ids`、`mapping`、TS target、直接测试和 evidence；历史测试记录含直接 TS
  测试或历史 oracle 的 `mapping_reason`，因此清单可以从文件盘点交接到任务验收。
- 每个 Metadata/Acquisition adapter 都有独立迁移目标和行为测试名称；T037/T039 只有全部 adapter 均有实现或批准退役证据后才能完成。
- CLI 和配置盘点来自实际 parser/model，而不是历史计划或目录猜测。
- `reference/original-bundle/` 不在 inventory 的任何映射、状态、验收或恢复字段中。
- `INVENTORY-MODULES`、`INVENTORY-ENTRY`、`INVENTORY-METADATA`、`INVENTORY-ACQUISITION`、`INVENTORY-CLI`、
  `INVENTORY-CONFIG` 和 `INVENTORY-TESTS` 的完整机器清单已经生成。下表只说明已经实现的首阶段用户旅程；
  其它模块逐项 TS parity 和全量 Provider 迁移属于当前 M4/T037–T045 的必做范围。

## 当前用户旅程的精简清单

| 旅程区域 | Python owner / 入口 | 直接 Python 测试索引 | 当前 TS 衔接 |
| --- | --- | --- | --- |
| 配置与 TUI | `configuration/`；`entry/configuration_bridge.py`；`entry/cli/config_ui.py`；`entry/cli/config_center/` | `test_configuration_*`、`test_config_center_*`、`test_config_ui.py`、`test_cli.py` | `configuration-owner-bridge.test.ts`、`configuration-tui-journey.test.ts`、`configuration-probe-journey.test.ts` 通过实际 Python owner 验证 projection、publication、credential、readiness 和取消 |
| Browser | `bootstrap/browser.py`；`configuration/browser_*`；`configuration/cloak_runtime.py`；`acquisition/browser_*`；`acquisition/sources/browser.py` | `test_browser_*`、`test_cloak_runtime_configuration.py`、`test_network_browser.py`、`test_network_cloakbrowser*.py` | `browser-host.test.ts`、`workbench-session.test.ts`、`workbench-http.test.ts` 和 `live-workbench.test.ts` 覆盖目标 Cloak、控制权、SSE、画面与人工输入 |
| Acquisition / Candidate | `acquisition/api.py`；`acquisition/publication.py`；`acquisition/pdf_identity.py`；`acquisition/sources/` | `test_acquisition_*`、`test_tiered_acquisition_service.py`、`test_pdf_acquisition_reform_contracts.py` | `browser-transfer.test.ts`、`candidate-recovery.test.ts`、`candidate-acceptance.test.ts`、`candidate-abandonment.test.ts` 覆盖 PDF 准入、持久 Candidate、receipt、发布和放弃 |
| Literature / Library | `literature/api.py`；`literature/service.py`；`literature/query.py`；`entry/library.py`；`entry/completion.py` | `test_literature_*`、`test_entry_library.py`、`test_entry_current_facts.py`、`test_entry_completion*.py` | `literature-*.test.ts`、`workbench-library.test.ts`、`browser-mineru-analysis-journey.test.ts` 覆盖身份、正式事实、查询、Parser/Analysis 和完整 loopback 旅程 |

机器清单保留当前 242 个 Python 模块（原始 235 个 + 7 个迁移 bridge）、161 个 Python 测试、11 个 Metadata adapter 和 7 个 Acquisition source，
没有把范围外代码标成已迁移或已退役。代表 Provider 与后续清单见
[Provider compatibility follow-ups](../runtime/provider-compatibility-followups.md)。

可重放检查：

```text
python tests/test_migration_inventory.py
```

结果：退出码 0。该测试只校验合成清单和仓库源文件存在性，不触碰用户状态。
