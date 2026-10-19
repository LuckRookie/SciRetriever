# 功能对等清单（新旧界面）

状态：**新界面验收完成**。保留54个旧用例与69条能力映射，按Owner最新决定撤销旧前端兼容。最终正式根入口代码的Full为285文件 / 1,981项全部通过、无跳过；生产版减少动效另跑36文件 / 84项全部通过。

旧实现路径相对 `apps/web/src/`；新测试名称相对 `apps/web/test/`，省略 `.test.ts`。读表时同时检查“实际覆盖与缺口”，不能用新测试总数替代业务断言对照。

06–09 迁移时逐行更新状态，11 的 GB 之前逐项核验。

本清单是本计划附属的验收表，不是产品需求。能力的真相源仍然是 [Web 指南](../../guides/web-workbench.md)、ADR 0032 的 G1–G3，以及现有测试。

## 规则

- **状态**只能取以下值：
  - 待迁移
  - 新界面实现中
  - 新界面通过
  - 需新增测试（旧界面有该能力，但没有直接测试）
  - 经 Owner 同意移除（必须附原因和日期）
- **“新界面通过”的条件**：对应的新测试已经存在，并在 Full 中通过。只有截图不算通过。
- **旧测试的写法**：`文件 › 用例`，文件名省略 `.test.ts`。
- **断言要求**：迁移后的测试必须保留旧测试的全部业务断言，只调整定位方式（见 [05 的 5.7](05-app-shell-and-data.md)）。

## 全局与外壳（05、09）

| 编号  | 能力                                                                                        | 旧测试                                                                                                                                          | 负责块             | 新测试                                                                                                                             | 状态         | 旧实现入口                                                   | 实际覆盖与缺口                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| P-001 | 登录、登录后回到原链接、不依赖 secure-context API、退出、退出后不能通过缓存返回 | remote-login-browser › logs in, preserves a link, operates without secure-context APIs, logs out and prevents a cached return | 09 | next-remote-login；next-auth | 新界面通过 | `remote-login.ts` | 原非secure HTTP/IP完整旅程迁移并定向通过：无randomUUID/subtle、登录/原链接/仅保存任务/剪贴板fallback/PDF/退出缓存边界 |
| P-002 | URL 参数（`view`、`query`、`sort`、`literature`、`reader` 等）恢复同一视图，前进 / 后退可用 | library-workbench › restores search/detail history and paginates more than 25 references（历史部分） | 05 | next-query-cache › parses current view links and fixed sources…；next-library-relations；next-retrieval | 新界面通过 | `workspace/app.ts、workspace/library.ts` | 当前URL、固定source参数、搜索详情前后退和固定结果返回保留；旧workspace别名按Owner最新决定撤销，待最终回归 |
| P-003 | 四种主题与跟随系统 | workspace-experience › keeps tabs and browser empty states aligned…（四主题截图部分） | 05 / 09 | next-theme › preserves the current system theme…；design-consistency | 新界面通过 | `theme.ts、workspace/settings.ts` | 四主题、system跟随与固定主题隔离保留；旧键兼容按Owner最新决定撤销，待当前命名空间最终回归 |
| P-004 | 导航栏与信息栏可拖动调宽、支持方向键、双击恢复默认，刷新后保留 | workspace-experience › keeps tabs and browser empty states aligned, provides adjustable panels and readable metadata on narrow screens | 05 / 07 | next-shell；components-gallery；next-reader-boundaries › renders metadata provenance… | 新界面通过 | `workspace/panels.ts` | 信息栏鼠标+80、键盘+16、reload保持、双击默认与390px隐藏分隔/来源可达均普通和reduce通过；导航栏与共享SplitPane另有直接回归 |
| P-005 | ⌘K 搜索入口 | 无 | 05 | next-library-workflows › opens keyboard search and live activity… | 新界面通过 | `workspace/app.ts` | Ctrl/⌘K搜索入口与提交至库已有直接回归，定向通过 |
| P-006 | 工作区与阅读标签的打开、切换、关闭（关闭时释放资源）；对话框与标签键盘可达 | workspace-resilience › preserves library pages, selection and scroll across reading and history, and keeps dialogs and tabs keyboard accessible | 05 / 06 / 07 | next-library；next-reader；next-reader-boundaries；components-gallery | 新界面通过 | `workspace/app.ts、reading/frame.ts` | 库页码/选择/滚动返回、阅读关闭资源、键盘与200%等效视口/两种动效模式 |
| P-007 | 活动入口与抽屉，实时任务状态 | 无直接用例（在 jobs-workbench 中间接覆盖） | 09 | next-library-workflows；next-tasks | 新界面通过 | `workspace/tasks.ts` | 活动抽屉显示新任务、转入完整任务页且不自动启动；103任务范围另有回归，定向通过 |
| P-008 | 重复刷新时释放 client grant；CSP 下允许 WebAssembly，不允许 JavaScript eval | workspace-retrieval › releases grants on repeated reloads and permits WebAssembly without JavaScript eval | 02 / 05 | next-retrieval › releases grants on repeated reloads… | 新界面通过 | `workspace/api.ts` | 重复刷新client grant释放与WASM/eval CSP边界已迁移；统一Full结果另记 |
| P-009 | 快速切换时取消在途请求，迟到响应不污染当前视图（通用要求） | 分散在各页面用例中，见 P-033、P-036、P-043、P-048、P-056 | 05 | next-library-workflows › aborts a library search…；next-retrieval；next-reader；next-reader-boundaries；next-insights；next-query-cache | 新界面通过 | `workspace/api.ts、workspace/retrieval.ts、reading/entry.ts` | 库搜索跨页面到洞察实测ERR_ABORTED且迟到响应不覆盖；检索/全文/PDF/图查询与Browser推送的局部竞争也有直接回归 |
| P-010 | 390 px 宽度下所有页面可用，无横向滚动 | 分散在 workspace-experience、browser-workbench、live-workbench 中 | 06–09 | design-audit；design-consistency；next-reader；next-library-relations；browser-workbench | 新界面通过 | `workspace.css、reading/frame.ts` | 9个主页面×四宽度×四主题计算样式与截图已采集，390px均无页面横向溢出；阅读/真实Browser/样本另有窄屏交互测试；最终矩阵结论在11汇总 |
| P-011 | 启动时拒绝不支持的身份和非法端口（服务端与 CLI，不属于前端） | workspace-launch › rejects unsupported identities and invalid ports before starting a service | 09 / 11 | next-launch › rejects unsupported identities and invalid ports…；› launches Web with %s storage… | 新界面通过 | `服务端/CLI 启动边界` | 原CLI拒绝断言已迁移并定向通过；default/configured启动、入库与运行时绑定的两个参数分支同时保留 |

## 文献库（06）

| 编号  | 能力                                                             | 旧测试                                                                                                   | 负责块 | 新测试                                                                            | 状态         | 旧实现入口                                   | 实际覆盖与缺口                                                                                         |
| ----- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------- | ------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| P-020 | 状态筛选、文本搜索、高级筛选、排序 | 无完整用例（workspace-resilience 有部分覆盖） | 06 | next-shell；next-library；next-library-workflows | 新界面通过 | `workspace/library.ts` | 年份筛选、搜索、状态筛选、排序和筛选移除有直接回归；库高级字段由公共Query合同校验 |
| P-021 | 已保存的筛选（当前本机存储，按库隔离） | 无 | 06 | next-library；next-library-workflows › loads catalog-scoped saved filters…；next-preferences | 新界面通过 | `workspace/library.ts` | 保存/重载、51项截为50、追加仍50、删除持久49、按catalog隔离保留；仅当前React键生效，旧键回退/迁移按Owner要求删除，待最终回归 |
| P-022 | 分页加载与总数显示；从阅读器或历史返回时保留页码、选择与滚动位置 | workspace-resilience › preserves library pages, selection and scroll across reading and history… | 06 | next-library › paginates a 30,000-record library… | 新界面通过 | `workspace/library.ts` | 30,002篇真实合成SQLite、首屏11行、90帧滚动0 long task；分页/选择/滚动/半选/保存筛选/SSE无storm定向通过 |
| P-023 | 多选、全选、选择条；“用这些文献做…”菜单与上限规则 | 无直接用例 | 06 | next-library；next-library-workflows；next-processing | 新界面通过 | `workspace/library.ts、workspace/actions.ts` | 1000篇范围上限、选择计数/半选、固定确认范围与操作不隐式执行 |
| P-024 | 预览面板 | 无 | 06 | next-library-workflows › opens keyboard search and live activity… | 新界面通过 | `workspace/library.ts` | 预览展示对应记录、不会改变阅读URL或启动加工；键盘关闭 |
| P-025 | 入库（导入 / 上传） | 无直接用例 | 06 | next-intake；next-library-workflows › requires confirmation before a PDF dropped… | 新界面通过 | `workspace/intake.ts、workspace/actions.ts` | 书目导入与发现页上传、库行拖入PDF均先确认；不会自动解析/分析 |
| P-026 | 文献详情中的参考文献超过 25 条时分页 | library-workbench › restores search/detail history and paginates more than 25 references（参考文献部分） | 07 | next-library-relations › restores search and detail history… | 新界面通过 | `workspace/library.ts` | 27条分页、独立来源证据、前后退、身份未验证、窄屏和不存在文献回执 |

## 阅读器（07）

| 编号  | 能力                                                                                      | 旧测试                                                                                                                                                                                         | 负责块           | 新测试                                                                                                     | 状态         | 旧实现入口                                 | 实际覆盖与缺口                                                                        |
| ----- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| P-030 | 100 页 PDF 有界渲染；十次切换后每篇的页码和缩放恢复；worker 与对象 URL 被释放 | workspace-reading › reads a 100 page PDF with bounded rendering, restores per-paper page/zoom over ten switches and releases workers and URLs | 07 | next-reader › keeps a 100-page PDF bounded… | 新界面通过 | `reading/pdf.ts、reading/state.ts` | 100页、十次切换、每篇页码/125%与适宽恢复、worker/对象URL/canvas释放；普通与reduce定向通过 |
| P-031 | 固定 Markdown 渐进排版：Unicode、表格、安全的数学公式；恢复阅读位置；隔离恶意或缺失的资源 | workspace-reading › progressively typesets fixed Markdown with Unicode, tables and safe math, restores position and isolates malicious/missing resources | 07 | next-reader-boundaries › continues fixed Unicode Markdown…；› keeps the latest outline target… | 新界面通过 | `reading/document.ts、reading/markdown.ts` | 排版/恶意资源/有界续读恢复已迁；目录20→60晚响应优先、24px与宽行、离开返回scroll差<80、已加载范围查找及资源同源在普通/reduce均通过 |
| P-032 | 规范化后的 Markdown 块映射回原始 UTF-8 边界（CRLF、非 BMP 字符） | workspace-reading › maps normalized Markdown blocks back to original UTF-8 boundaries including CRLF and non-BMP text | 07（引擎，保持） | reading-markdown › maps normalized Markdown blocks… | 新界面通过 | `reading/markdown.ts` | 纯引擎测试已迁入reading-markdown，CRLF/非BMP原UTF-8边界及不安全Markdown断言保持 |
| P-033 | 说明纯扫描件和无效 PDF；取消迟到的原始字节读取，不替换当前文档 | workspace-reading › explains scan-only and invalid PDFs and cancels a late original-byte read without replacing the active document | 07 | next-reader-boundaries › explains scan-only PDFs…；next-reader › does not let a late PDF… | 新界面通过 | `reading/pdf.ts、reading/entry.ts` | 原“invalid”用例实际断言篡改字节hash拒绝；扫描件、该完整性拒绝及迟到PDF边界均已迁移 |
| P-034 | 加密 PDF 在入库边界被拒绝，不展示未被接纳的资产 | workspace-reading › rejects encrypted PDFs at the existing ingestion boundary and does not present an unaccepted asset | 07 | next-reader-boundaries › keeps encrypted PDF rejection… | 新界面通过 | `服务端PDF接纳边界、reading/entry.ts` | 加密资产拒绝且阅读器不暴露未接纳PDF |
| P-035 | PDF worker 失败时给出报告，已核验的原始文件仍可下载 | workspace-reading › reports a failed PDF worker and keeps the verified original download available | 07 | next-reader-boundaries › keeps a verified PDF download… | 新界面通过 | `reading/pdf.ts` | worker失败可重试，已核验原始PDF仍下载 |
| P-036 | 全文自动有界续读，已渲染的块保留，失败可恢复；离开阅读器后丢弃迟到的续读结果 | workspace-experience › automatically continues bounded text reads while retaining rendered blocks and a recoverable failure；› discards a late automatic continuation after leaving the reader | 07 | next-reader-boundaries › continues fixed Unicode Markdown…；› discards a late automatic text continuation… | 新界面通过 | `reading/document.ts` | 自动有界续读、稳定块复用、失败重试、离开后丢弃迟到结果 |
| P-037 | 读取原始字节，执行持久解析与分析，重新打开已核验的知识 | knowledge-workbench-integration › uses the authenticated library workspace to read original bytes, run durable parsing and analysis, and reopen verified knowledge | 07 | next-knowledge-journey › uses the authenticated library workspace… | 新界面通过 | `workspace/actions.ts、reading/entry.ts` | 原完整durable解析/分析/原始字节/固定知识与综合旅程迁移，定向通过 |
| P-038 | 显式重解析后发布为新的默认版本，并显示默认回执 | workspace-resilience › publishes an explicit reparse as the new default and shows its default receipt | 07 | next-knowledge-journey › preserves explicit reparse publication…（true） | 新界面通过 | `workspace/actions.ts、reading/entry.ts` | 新默认文档ID与解析回执、任务结果跳回新全文，定向通过 |
| P-039 | 缺少分析配置时给出说明和恢复入口，同时保留机器错误信息 | workspace-resilience › explains missing analysis configuration with a recovery action while retaining the machine failure | 07 | next-knowledge-journey › preserves explicit reparse publication…（false） | 新界面通过 | `workspace/actions.ts` | 缺模型任务失败可转设置，技术错误码保留，模型未被调用，定向通过 |
| P-040 | 摘要与来源分开展示（来源名、时间、原记录、书目），窄屏可达 | workspace-experience › keeps tabs…readable metadata on narrow screens（元数据部分） | 07 | next-reader-boundaries › renders metadata provenance as human fields… | 新界面通过 | `reading/frame.ts、workspace/library.ts` | 来源名/原摘要/人类字段、信息栏键盘调整与reload；200%等效视口另有两动效回归 |

## 检索与洞察（08）

| 编号  | 能力                                                           | 旧测试                                                                                                                                       | 负责块 | 新测试                                                             | 状态         | 旧实现入口                                               | 实际覆盖与缺口                                                                |
| ----- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------ | ------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| P-041 | 原文与知识三种模式检索、分页；说明中文按词法匹配，但不阻止检索 | workspace-retrieval › searches source and knowledge in all three modes, paginates, and explains Chinese lexical matching without blocking it | 08 | next-retrieval › searches source and knowledge in all three modes… | 新界面通过 | `workspace/retrieval.ts` | 原文/知识/混合三模式、分页与中文词法说明原完整用例已迁移 |
| P-042 | 综合类命中以固定 artifact 打开，返回时回到同一查询 | workspace-retrieval › opens a synthesis hit as its own fixed artifact and returns to the same query | 08 | next-retrieval › opens a synthesis hit… | 新界面通过 | `workspace/retrieval.ts、workspace/synthesis.ts` | 固定artifact与返回查询已迁移 |
| P-043 | 迟到或失败的检索不替换更新的页面，可显式重试 | workspace-retrieval › keeps late or failed searches from replacing a newer page and permits an explicit retry | 08 | next-retrieval › keeps late or failed searches… | 新界面通过 | `workspace/retrieval.ts` | 旧晚响应/失败/重试用例迁移 |
| P-044 | 发布新默认版本后打开固定命中，返回时恢复查询与篮子 | workspace-retrieval › opens the fixed hit after a new default is published and restores the query and basket on return | 08 | next-retrieval › opens the fixed hit after a new default… | 新界面通过 | `workspace/retrieval.ts、workspace/source-navigation.ts` | 固定来源hash与查询/篮子返回迁移 |
| P-045 | 索引不可用时如实说明，不称为“关键词未命中”，也不自动启动维护 | workspace-retrieval › explains unavailable indexes without claiming a keyword miss or starting maintenance | 08 | next-retrieval › explains unavailable indexes… | 新界面通过 | `workspace/retrieval.ts` | 未命中与索引不可用区分，无隐式维护 |
| P-046 | 显式重建 v4 索引，并在真实浏览器页面中检索上下文 | retrieval-context-workbench › rebuilds the v4 index explicitly and searches Context in the real browser pages | 08 | next-material-context › rebuilds the v4 index explicitly… | 新界面通过 | `workspace/retrieval.ts、maintenance.ts` | 原v4测试迁移至React独立入口，重建须确认，Context原始证据可核验；定向通过 |
| P-047 | 上下文复制为 Markdown、导出 JSON | 无直接用例 | 08 | next-material-context › rebuilds the v4 index explicitly… | 新界面通过 | `workspace/retrieval.ts` | 空篮子禁用复制导出；实际剪贴板Markdown和JSON下载保留固定文档/文献ID，定向通过 |
| P-048 | 引用图说明抽样范围；迟到的图查询不替换统计 | workspace-experience › explains citation sampling and prevents a late graph read from replacing statistics | 08 | next-insights › explains citation scope and keeps a late graph… | 新界面通过 | `workspace/insights.ts` | 真实范围/零边说明、全库切换、迟到引用读取不能替换统计，定向通过 |
| P-049 | 统计（年份、关键词、期刊、材料状态），图表与表格切换 | 无直接用例 | 08 | next-insights › offers chart and table views… | 新界面通过 | `workspace/insights.ts` | 年份/关键词/期刊/材料状态图表和表格数一致、年份筛选、390px无溢出，定向通过 |

## 综合、提取与发现（08）

| 编号  | 能力                                                                           | 旧测试                                                                                                                                                                      | 负责块  | 新测试                                                             | 状态         | 旧实现入口                                                        | 实际覆盖与缺口                                                                                      |
| ----- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------ | ------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| P-050 | 范围变化时保留综合问题与策略，并使已准备的输入失效 | workspace-resilience › retains synthesis question and policy while invalidating prepared inputs after a scope change | 08 | next-processing › retains the synthesis question and policy… | 新界面通过 | `workspace/synthesis.ts` | 问题/策略保留，范围变化固定输入失效 |
| P-051 | 范围预读失败时就地重试，不声称已提交任务，不丢弃草稿 | workspace-resilience › retries a failed range pre-read in place, without claiming a task was submitted or discarding the draft | 08 | next-processing › retries a failed processor scope read… | 新界面通过 | `workspace/synthesis.ts、workspace/processors.ts` | 旧用例实际覆盖处理器范围预读：失败无任务、草稿保留、可重试；原业务断言已迁移 |
| P-052 | 记录提取：校验记录，固定所选文档，打开已核验的结果（保留原始数值单位与缺失值） | workspace-processors › validates records, fixes the selected document, and opens a verified result with original numeric units and missing values | 08 | next-processing › validates human records… | 新界面通过 | `workspace/processors.ts` | 字段重复/固定文档/数字单位/缺失/完整性拒绝/机器侧读同事实 |
| P-053 | 标签：在显式检索范围上提交枚举标签，缺失文档作为缺口保留 | workspace-processors › submits enum labels over an explicit search scope and keeps missing documents as gaps | 08 | next-processing › submits enum labels… | 新界面通过 | `workspace/processors.ts` | 枚举标签、显式search范围、缺材料作为gap |
| P-054 | 保存回执丢失时保留草稿和幂等性；恢复已保存但启动失败的任务 | workspace-processors › preserves drafts and idempotency after a lost save receipt and recovers a saved task whose start failed | 08 | next-processing › retains drafts and idempotent requests… | 新界面通过 | `workspace/processors.ts` | 丢失回执复用幂等键、已保存任务启动失败恢复 |
| P-055 | 缺少模型配置时给出说明，不丢失有效表单，也不处理缺失的材料 | workspace-processors › explains absent model configuration without losing a valid form or processing missing material | 08 | next-processing › preserves a valid form… | 新界面通过 | `workspace/processors.ts` | 配置缺失保持表单，缺失文档不加工 |
| P-056 | 从 Web 取消处理器任务，并拒绝迟到的模型回答 | workspace-processors › cancels a processor task from Web and refuses a late model answer | 08 / 09 | next-processing › cancels an explicit processor task… | 新界面通过 | `workspace/processors.ts、workspace/tasks.ts` | Web取消后迟到模型结果不得发布 |
| P-057 | 结果查询、跨页选择、固定证据跳转、只综合已确认的行、导出完整结果 | workspace-processor-results › queries, selects across pages, follows fixed evidence and synthesizes only the confirmed rows, while exporting the complete result | 08 | next-processing › keeps cross-page selections… | 新界面通过 | `workspace/processor-results.ts、workspace/processor-evidence.ts` | 固定原文往返保留第2页和两条选择；实际筛选/排序、草稿不发请求、完整CSV/JSON和仅确认2条综合，定向通过 |
| P-058 | 区分 false 与未知标签、恢复关联文献、内容检索与过期索引恢复（不做隐式工作） | workspace-processor-results › keeps false distinct from unknown labels, restores associated papers, and exposes content search and stale-index recovery without hidden work | 08 | next-processor-labels › keeps false distinct from unknown labels… | 新界面通过 | `workspace/processor-results.ts` | 原P058全部业务断言迁移，false/null、关联文献、内容搜索与过期索引 |
| P-059 | 已核验的记录来源与整份结果的输入分开展示；可为空的数值子字段可以筛选 | workspace-processor-results › shows verified record sources separately from whole-result inputs and filters nullable numeric children | 08 | next-processor-sources › shows verified record sources separately… | 新界面通过 | `workspace/processor-results.ts` | 原P059全部业务断言迁移，nullable0/null、字段操作拒绝与201行来源缓存 |
| P-060 | 浏览器中下载完整的大结果，拒绝被篡改的传输分块 | processor-large-result › downloads a complete large result in the browser and rejects altered transfer chunks | 08 | next-processor-large-result › downloads a complete large result… | 新界面通过 | `workspace/processor-data.ts` | >4MiB完整传输，篡改块hash拒绝，无模型调用 |
| P-061 | 发现：主题发现、引用扩展、导入书目、上传 PDF，以及本次会话的运行结果 | 无直接用例 | 08 | next-intake › keeps discovery and bibliography import explicit…；› retains only the latest 30 discovery reports… | 新界面通过 | `workspace/intake.ts` | 主题/引用/书目/PDF四入口确认且无隐式加工；31次显式发现仅留最新30，跨页保留、reload清空，定向通过 |

## 任务、浏览器、设置（09）

| 编号  | 能力                                                                                 | 旧测试                                                                                                                                                | 负责块 | 新测试                                                                           | 状态         | 旧实现入口                                 | 实际覆盖与缺口                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------- | ------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| P-070 | 恢复空、失败、过期、已取消、已完成的任务状态 | jobs-workbench › recovers empty, failed, stale, cancelled and completed task states | 09 | next-jobs-parity › recovers empty, failed, stale…；next-tasks | 新界面通过 | `workspace/tasks.ts` | 原全部状态/分页去重/搜索/过期响应/读取失败保留断言已迁移并通过；103任务测试额外覆盖 |
| P-071 | 提交固定处理操作；失败时保留部分结果，只重试缺失的操作 | jobs-workbench › submits fixed processing operations, preserves partial results on failure and retries only the missing operation | 09 | next-jobs-parity › submits fixed processing operations… | 新界面通过 | `workspace/tasks.ts、workspace/actions.ts` | 部分失败只重试缺失、首结果不变、固定操作pause/resume旧断言保留，定向通过 |
| P-072 | 未提交的生产候选只在其操作运行期间显示为“等待中” | feedback › only describes an uncommitted production candidate as waiting while its operation runs | 09 | feedback › only describes an uncommitted production candidate…（保持纯逻辑测试） | 新界面通过 | `feedback.ts` | 确认React Browser直接复用candidateStatus；原纯逻辑断言保持，无旧DOM依赖 |
| P-073 | 显示已核验并已提交的 PDF，保留合成候选的措辞 | feedback › shows a verified committed PDF and preserves synthetic candidate wording | 09 | feedback › shows a verified committed PDF…（保持纯逻辑测试） | 新界面通过 | `feedback.ts` | React Browser复用candidateStatus；已核验提交与样本措辞均由原纯测试覆盖 |
| P-074 | 只观看不接管控制；第一次点击时绑定控制；拒绝过期回放；关闭前确认释放 | workspace-browser-control › observes without taking control, binds the first click, rejects stale replay and confirms release before closing | 09 | next-browser-control › observes without taking control… | 新界面通过 | `workspace/browser.ts` | 旧全部业务断言迁移，另补返回/前进及释放失败守卫 |
| P-075 | 向两个观看者推送真实画面，捕获持久 PDF，拒绝旧控制者，390 px 下仍可操作 | live-workbench › streams real frames to two viewers, captures a durable PDF, rejects the old controller, and remains operable at 390px | 09 | next-live-browser › streams real frames to two viewers… | 新界面通过 | `live.ts、workspace/browser.ts` | 安装Cloak真实运行时已定向通过：双观看者/控制权/53篇库/XSS/PDF哈希下载/390px；无SCIRETRIEVER_CLOAK_BUNDLE时会skip，Full需单列环境 |
| P-076 | 选中正确的实时文章，关闭时显式交还控制，另一篇文章继续下载并保留文件 | parallel-live-workbench › selects the correct live article, explicitly returns control on close, while another article downloads and retains its file | 09 | next-parallel-browser › selects the correct live article… | 新界面通过 | `workspace/browser.ts` | 原并行文章/显式交还/另一下载持久保存/清理失败不撤已发布均迁移并通过 |
| P-077 | 保存设置；冲突时保留草稿；显式探测；凭据不进入页面状态 | configuration-workbench › saves, preserves a conflicted draft, probes explicitly and keeps credentials out of page state | 09 | next-settings；next-settings-sources | 新界面通过 | `workspace/settings.ts、configuration.ts` | 草稿/分区保存/冲突/来源参数/显式probe/敏感值清除/窄屏已迁；启动缺凭据来源、保存凭据后仍restart-required及下一外部请求核验已补直接回归并通过 |
| P-078 | 注册空的 Provider / Model 目录，绑定 Browser，通过 fake transport 探测已保存的 Model | configuration-workbench › registers an empty Provider/Model catalog, binds Browser and probes the saved Model through a fake transport | 09 | next-settings-catalog › registers an empty model catalog… | 新界面通过 | `workspace/settings.ts、configuration.ts` | 旧空目录注册/绑定/fake transport/重名/编辑/保存绑定保护/解除后删除全迁移 |

## 样本预览、独立查询与维护入口（09 的 9.5，保留并迁移）

| 编号  | 能力                                                     | 旧测试                                                                                                                                    | 负责块 | 新测试                                                                | 状态         | 旧实现入口                      | 实际覆盖与缺口                                                                          |
| ----- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------- | ------------ | ------------------------------- | --------------------------------------------------------------------------------------- |
| P-080 | 样本预览入口只提供样本资产，拒绝文件系统路径和修改操作 | browser-workbench › serves only sample assets and refuses filesystem paths and mutations | 9.5 | browser-workbench › serves only sample assets… | 新界面通过 | `browser.ts、preview-server.ts` | 原用例切换至独立React sample资源，业务断言保留 |
| P-081 | 页面输入需要人工接管；样本发布需要显式确认 | browser-workbench › requires human takeover for page input and explicit confirmation for sample publication | 9.5 | browser-workbench › requires human takeover… | 新界面通过 | `browser.ts` | 原用例切换至React样本入口，接管/显式发布不变 |
| P-082 | 不确定的候选不发布，并解释被拒绝的网络请求 | browser-workbench › keeps uncertain candidates unpublished and explains rejected network requests | 9.5 | browser-workbench › keeps uncertain candidates… | 新界面通过 | `browser.ts` | 原用例切换至React样本入口，拒绝不确定/网络边界不变 |
| P-083 | 接管、暂停、取消或场景变化后，停止延迟捕获 | browser-workbench › stops delayed capture after takeover, pause, cancellation and scenario changes | 9.5 | browser-workbench › stops delayed capture… | 新界面通过 | `browser.ts` | 原用例切换至React样本入口，接管/暂停/取消/场景变化停捕获 |
| P-084 | 390 px 抽屉与键盘操作，无横向滚动 | browser-workbench › supports the 390px drawer and keyboard without horizontal overflow | 9.5 | browser-workbench › supports the 390px drawer… | 新界面通过 | `browser.ts` | 原用例切换至React样本入口，键盘/焦点恢复/窄屏断言保留 |
| P-085 | 查询模式：未初始化时显示相应状态，不创建 home 或 catalog | query-workbench › shows an uninitialized state without creating a home or catalog | 9.5 | next-independent；next-query-parity › shows an uninitialized state… | 新界面通过 | `query.ts` | 未初始化不创建home/catalog，不获取Browser grant，独立协议维持原边界 |
| P-086 | 查询模式：阅读、检索、跟随参考文献、下载 | query-workbench › reads, searches, follows references and downloads through the query-only page | 9.5 | next-query-parity › reads, searches, follows references… | 新界面通过 | `query.ts` | 原完整query断言迁移通过：搜索/引用/下载/损坏PDF/规范及固定输入回执/无写；v4 Context另验 |
| P-087 | 维护模式：选择当前库中的 PDF，校验已发布的 Document 回执 | maintenance-workbench › selects the current Library PDF and validates a published Document receipt in Chromium | 9.5 | next-maintenance › selects the current Library PDF…；next-independent | 新界面通过 | `maintenance.ts` | 原独立选择PDF/解析回执拒绝与固定材料复用回归迁移并通过 |
| P-088 | 维护模式：接纳所选 PDF，读取同一事实，报告拒绝与冲突 | maintenance-workbench › accepts a selected PDF in Chromium, reads the same fact, and reports rejection and conflict | 9.5 | next-maintenance › accepts a selected PDF in Chromium… | 新界面通过 | `maintenance.ts` | 原独立维护上传/读取同事实/拒绝/冲突断言迁移并通过 |
| P-089 | 维护表单：交付 v5 提取批次，拒绝伪造的响应 | extraction-maintenance-workbench › delivers a v5 extraction batch through the real Chromium maintenance form and refuses forged responses | 9.5 | next-extraction-maintenance › delivers a v5 extraction batch… | 新界面通过 | `maintenance.ts` | 原业务/伪造响应/证据/回执安全场景全部迁移 |

## 切换时需要同步的服务端测试（11 的 11.3）

以下测试在初始工作树引用旧静态资源（`live.html`、`workspace.css`、`live.js`、`query.html` 等）。文档、知识与综合的浏览器旅程已改为React资源；默认入口与安装包断言也已随11.3正式切换同步，最终安装与Full结果另记，不改变业务含义：

- `apps/server/test/production-workbench-loopback.test.ts`
- `apps/server/test/knowledge-analysis.test.ts`
- `apps/server/test/document-read.test.ts`
- `apps/server/test/synthesis-service.test.ts`
- `apps/server/test/knowledge-retrieval-migration.test.ts`
- `apps/server/test/web-remote-access.test.ts`
- `packages/contracts/test/package-entrypoints.test.ts`
- `apps/server/test/portable-package.test.ts`（实查补充：发行包资源集合）
- `apps/server/test/installed-public-journey.test.ts`（实查补充：离线安装后的公开入口旅程）

本轮新增的 `next-assets`、`next-entry-http` 和 `next-development` 按最新决定验证唯一正式入口、旧路由404及鉴权/HMR边界；它们不计入54项旧Web测试。精确资源与fixture处置见[11的影响分析](11-cutover-and-cleanup.md)。

## 11.1 旧测试处置与计数

以最初54个具名用例为计数单位；同一用例对应多条能力时只计一次。拆分到多个新测试仍计一个迁移项；两个旧用例合入同一新用例时，按两个旧输入项计“合并”。GB确认后已按此映射切换正式入口并清理20个旧UI测试文件；表中旧文件名作为历史对照保留，不构成活动入口。

| 处置 | 旧用例数 | 说明 |
| --- | --- | --- |
| 迁移或拆分迁移 | 50 | 包括样本预览5项原位迁至React，以及Markdown纯引擎1项迁到独立测试 |
| 合并共享核心 | 2 | 旧Markdown渐进排版和自动续读共用 `next-reader-boundaries › continues fixed Unicode Markdown…` 核心旅程；另用目录/位置恢复用例保留原排版旅程的后半段断言 |
| 原样保留共享逻辑 | 2 | `feedback` 两项改为引用 `app/data/candidate-status.ts`，继续验证当前React调用的同一函数 |
| 经Owner同意移除 | 0 | 没有下线样本、查询、维护或其它旧能力 |
| 合计 | 54 | 统计旧用例的去向，不是新suite运行用例数 |

初始清单还没有展开 `workspace-launch` 的 `it.each(["default", "configured"])`。这两个启动分支已迁到 `next-launch`，验证默认/配置库位置、入库和发布路径后当前进程绑定保持不变，作为**额外2个参数分支**单列，不混入54的基线计数。G1/G2、动效、故障回归等新增用例也不用于填补旧用例数量。

| 旧文件 | 初始用例数 | 新文件 / 处置 |
| --- | --- | --- |
| `browser-workbench` | 5 | 同名文件原位迁React sample；5项全保留 |
| `configuration-workbench` | 2 | `next-settings`、`next-settings-sources`、`next-settings-catalog`；按设置边界拆分 |
| `extraction-maintenance-workbench` | 1 | `next-extraction-maintenance` |
| `feedback` | 2 | 同名纯逻辑测试保留；更换为当前共享函数导入 |
| `jobs-workbench` | 2 | `next-jobs-parity` 两项，`next-tasks` 补充大历史场景 |
| `knowledge-workbench-integration` | 1 | `next-knowledge-journey` 主旅程 |
| `library-workbench` | 1 | `next-library-relations`；书签另由 `next-query-cache` 补充 |
| `live-workbench` | 1 | `next-live-browser`；仍明确依赖已安装Cloak运行时 |
| `maintenance-workbench` | 2 | `next-maintenance` 两项 |
| `parallel-live-workbench` | 1 | `next-parallel-browser` |
| `processor-large-result` | 1 | `next-processor-large-result` |
| `query-workbench` | 2 | `next-query-parity` 两项；`next-independent` 补充独立入口边界 |
| `remote-login-browser` | 1 | `next-remote-login`；`next-auth` 补充登录可访问性 |
| `retrieval-context-workbench` | 1 | `next-material-context`；同用例补充剪贴板与导出 |
| `workspace-browser-control` | 1 | `next-browser-control`；展开两种系统动效偏好 |
| `workspace-experience` | 4 | 3项拆到 `next-shell` / `next-reader-boundaries` / `next-insights`；自动续读1项与下列Markdown排版合并 |
| `workspace-launch` | 1 | `next-launch` 的非法身份/端口用例；另加前述2个参数分支 |
| `workspace-processor-results` | 3 | `next-processing` 的跨页结果旅程、`next-processor-labels`、`next-processor-sources` |
| `workspace-processors` | 5 | `next-processing` 的表单/枚举/丢失回执/配置缺失/取消五项 |
| `workspace-reading` | 6 | 5项迁至 `next-reader` / `next-reader-boundaries` / `reading-markdown`；Markdown排版1项参与前述合并 |
| `workspace-resilience` | 5 | `next-library`、`components-gallery`、`next-reader-boundaries`、`next-processing` 两项、`next-knowledge-journey` 两分支；按原用例意图拆分 |
| `workspace-retrieval` | 6 | `next-retrieval` 六项完整迁移 |

服务端中的文档/知识/综合浏览器旅程不属于这54项，也没有因切换而删除：`document-read`、`knowledge-analysis`、`synthesis-service`、`knowledge-retrieval-migration`、`production-workbench-loopback` 使用React资源重新验证。综合来源新增content/manifest/statement三重绑定拒绝；历史v7综合证据不依赖处理器schema。

## 统计

| 项目                                       | 数量                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| 已映射的旧测试用例                         | 54 / 54                                                                    |
| 能力条目                                   | 69                                                                         |
| 初始缺少直接测试的能力（现均已有新入口用例） | 10（P-005、P-007、P-020、P-021、P-023、P-024、P-025、P-047、P-049、P-061） |

当前无条目标记“新界面通过”；统一 Full 通过后再按此表逐项收口。旧入口测试继续通过不等于新入口已对等。

P-009 已新增跨页面实际中止测试；P-061/P-077 的会话上限和运行能力提示补测已通过；P-002/P-003/P-021按新决定改验当前URL/偏好与旧兼容不生效。阅读目录/位置补测已在普通/减少动效模式完成；PDF重复切换的普通/减少动效也已通过；最终Full与离线安装结果仍单独收口。GB已确认，不以用户确认或局部通过代替整体验收。

初始标记“需新增测试”的10项现已有新入口测试；旧行为入口与具体断言见上表。它们不计入原54项迁移数量，避免把新增覆盖冒充已迁移旧测试。

[计划入口](README.md)

## Owner 撤销前端兼容的范围

单一新版决定撤销临时 `/next` 路由、旧workspace参数和旧偏好迁移/回退；这些不再属于功能对等要求。54项历史业务测试的计数与去向保留，当前URL恢复、主题、栏宽、保存筛选本身仍必须通过，不能把取消兼容解释成取消这些功能。catalog、历史产物schema和证据完整性断言不变。
