# 10｜来源、证据范围与待验证前提

**核查日期：2026-09-07。** 仓库来源固定到e1a33d5；外部官方文档为核查时版本，实施时需固定依赖并复验。来源用于支持现有事实与API能力，不表示本计划的架构已由这些项目验证。

## 1. 仓库来源与静态审查范围

<a id="r01"></a>
### R01｜当前master提交

[固定提交来源](https://github.com/LuckRookie/SciRetriever/commit/e1a33d5986f654f2692d7619dd58448944ec3463)。分支与commit元数据已读取；2026-09-07冻结基线。

<a id="r02"></a>
### R02｜AGENTS.md

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/AGENTS.md)。全文读取：范围、所有权、协作、测试及授权边界。

<a id="r03"></a>
### R03｜HARNESS.md

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/HARNESS.md)。读取1–180行：旧质量门禁、离线约束和文档职责。

<a id="r04"></a>
### R04｜代码与文档映射

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/docs/development/documentation-map.md)。读取模块映射，长响应部分截断；不能作为逐文件完整清单。

<a id="r05"></a>
### R05｜当前依赖与Python入口

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/pyproject.toml)。全文读取：CloakBrowser 0.5.8、Playwright 1.55.0等实际依赖。

<a id="r06"></a>
### R06｜通用Browser Source与导航预取

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/src/sciretriever/acquisition/sources/browser.py)。读取1–540行：控制边界、_GenericCapturePolicy、全导航prefetch及内存候选。

<a id="r07"></a>
### R07｜当前Browser Agent Controller

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/src/sciretriever/acquisition/browser_control.py)。读取1–156行：六动作、预算、系统提示和禁止事项。

<a id="r08"></a>
### R08｜当前PDF身份判断

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/src/sciretriever/acquisition/pdf_identity.py)。全文读取：前三页、supplement判断、DOI集合与标题作者匹配。

<a id="r09"></a>
### R09｜CloakBrowser运行适配

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/src/sciretriever/network/cloakbrowser.py)。读取1–220行：线程所有权、Linux fs context、环境清理和binary基线。

<a id="r10"></a>
### R10｜SQLite schema manifest

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/src/sciretriever/storage/sqlite/schema.py)。全文读取：version=1 CHECK、原始DDL、fingerprint生成。

<a id="r11"></a>
### R11｜SQLite引擎

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/src/sciretriever/storage/sqlite/engine.py)。读取1–240行：只创建或验证、路径检查、WAL/FK、完整对象集合。

<a id="r12"></a>
### R12｜内容规范序列化与接纳

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/src/sciretriever/literature/content.py)。读取1–215行：metadata/content JSON字节和hash、stale条件。

<a id="r13"></a>
### R13｜当前配置示例

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/example/config.example.toml)。全文读取：仍包含旧download/rules字段，必须与活动解析器核对。

<a id="r14"></a>
### R14｜ADR 0023：通用Browser Agent

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/docs/architecture/decisions/0023-generic-browser-agent-executor.md)。全文已读取：通用路线、六动作、Network-owned交接、capture与验收。

<a id="r15"></a>
### R15｜CONNECT与Xvfb

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/src/sciretriever/network/browser_connect.py)。读取1–150行：非TLS终止隧道与Xvfb lease。

<a id="r16"></a>
### R16｜当前README

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/README.md)。重点读取入口、运行行为、来源、三模型协议、配置与MinerU说明；示例与实际代码冲突处需M0核验。

<a id="r17"></a>
### R17｜Storage技术合同

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/docs/architecture/technical/storage.md)。读取SQLite/文件安全/事务/发布/锁/恢复等章节；本轮重点复核210–350行。

<a id="r18"></a>
### R18｜原语与UTC时间合同

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/src/sciretriever/model/primitives.py)。全文读取：严格值对象、相对路径和UTC字符串。

<a id="r19"></a>
### R19｜PDF归属直接测试

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/tests/test_acquisition_pdf_identity.py)。读取1–220行：空白PDF加元数据fixture与主要测试。

<a id="r20"></a>
### R20｜Browser相关测试位置

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/tests/test_network_browser.py)。通过仓库搜索定位_GenericCapturePolicy相关引用；未声称全文审查。

<a id="r21"></a>
### R21｜ADR索引

[固定提交来源](https://github.com/LuckRookie/SciRetriever/blob/e1a33d5986f654f2692d7619dd58448944ec3463/docs/architecture/decisions/README.md)。读取0001–0023当前决策与主题关系；长响应可能截断尾部说明。

## 2. 官方依赖参考

<a id="w01"></a>
### W01｜Node.js版本支持状态

[官方文档/项目](https://nodejs.org/en/about/previous-releases)。Node 24 LTS为拟验证基线；具体补丁版本待实施冻结。

<a id="w02"></a>
### W02｜Playwright Screencast

[官方文档/项目](https://playwright.dev/docs/api/class-screencast)。1.59接口、JPEG回调与视口信息；仅说明API，不证明Cloak组合兼容。

<a id="w03"></a>
### W03｜better-sqlite3项目文档

[官方文档/项目](https://github.com/WiseLibs/better-sqlite3)。同步驱动与worker使用；生产版本和预编译资源须冻结。

<a id="w04"></a>
### W04｜Node SQLite API

[官方文档/项目](https://nodejs.org/api/sqlite.html)。当前文档分支不能当成Node24完全相同的能力/稳定等级。

<a id="w05"></a>
### W05｜Node Worker Threads

[官方文档/项目](https://nodejs.org/api/worker_threads.html)。独立JS线程与消息交互；本方案用于隔离同步任务。

<a id="w06"></a>
### W06｜Chrome DevTools Protocol Page

[官方文档/项目](https://chromedevtools.github.io/devtools-protocol/tot/Page/)。screencast/ACK与页面相关事件；实验性协议仅作经测试适配路径。

<a id="w07"></a>
### W07｜Fastify Server参考

[官方文档/项目](https://fastify.dev/docs/latest/Reference/Server/)。拟选HTTP服务基础；工作区业务协议为本计划自行设计。

<a id="w08"></a>
### W08｜Zod基础

[官方文档/项目](https://zod.dev/basics)。运行时解析；strict与交叉字段规则由项目明确实现。

<a id="w09"></a>
### W09｜Vitest指南

[官方文档/项目](https://vitest.dev/guide/)。拟选测试工具；具体Harness尚待实现。

<a id="w10"></a>
### W10｜Playwright下载指南

[官方文档/项目](https://playwright.dev/docs/downloads)。下载事件与主流程、文件保存及Context生命周期。

<a id="w11"></a>
### W11｜Playwright Download参考

[官方文档/项目](https://playwright.dev/docs/api/class-download)。saveAs/下载完成语义；不代表Acquisition已入库。

<a id="w12"></a>
### W12｜Playwright Route参考

[官方文档/项目](https://playwright.dev/docs/api/class-route)。continue与fetch/fulfill机制区别。

<a id="w13"></a>
### W13｜Playwright网络指南

[官方文档/项目](https://playwright.dev/docs/network)。Service Worker与路由可见性边界。

<a id="w14"></a>
### W14｜Playwright CI环境

[官方文档/项目](https://playwright.dev/docs/ci)。Linux headed执行所需显示环境；投屏不能消除启动依赖。

<a id="w15"></a>
### W15｜SQLite WAL官方说明

[官方文档/项目](https://sqlite.org/wal.html)。单写入者、共享内存与WAL文件关系、部署约束。

<a id="w16"></a>
### W16｜Node文件系统API

[官方文档/项目](https://nodejs.org/api/fs.html)。FileHandle/fsync等基础能力；不能据此推断全平台无竞态原语齐全。

<a id="w17"></a>
### W17｜PDF.js官方示例

[官方文档/项目](https://mozilla.github.io/pdf.js/examples/)。候选PDF处理引擎的参考；验收质量需要本项目fixture验证。

<a id="w18"></a>
### W18｜Node Single Executable Applications

[官方文档/项目](https://nodejs.org/api/single-executable-applications.html)。可选发行方向；原生与浏览器资源仍需专项打包验证。

<a id="w19"></a>
### W19｜CloakBrowser官方仓库

[官方文档/项目](https://github.com/CloakHQ/CloakBrowser)。存在JavaScript wrapper；不采信“所有反爬均通过”等营销承诺。

<a id="w20"></a>
### W20｜Playwright Auto-waiting

[官方文档/项目](https://playwright.dev/docs/actionability)。元素可操作性等待；本计划的partial Observation是拟新增设计。

## 3. 本次已完成与未完成

已完成：通过GitHub连接读取当前分支、关键源码、设计与直接测试；对照官方依赖文档；形成目标架构、任务DAG与验收计划；检查交付文档的本地链接、引用ID、任务依赖与测试ID。

未完成：没有在用户机器运行代码、没有取得完整工作树逐文件执行、没有跑Python Harness、没有启动TS/Cloak组合、没有操作真实Catalog/Profile、没有访问出版社验证下载率。M0中的能力spike和完整清单是待实施任务，不是本次成果。

本次观察到的代码风险是静态推断。能够确定prefetch和身份判断代码怎样写，不能从这些静态证据确定某个真实403的唯一根因。

## 4. 必须由实施证据关闭的前提

浏览器与投屏版本组合；目标平台系统依赖及发行许可；原生文件锁/目录访问与Node等价性；旧库manifest/FTS跨驱动表现；PDF引擎对真实排版身份文字的提取；完整Provider/CLI/配置能力清单；Profile升级与回退；用户实际授权访问的真实站点成功率。
