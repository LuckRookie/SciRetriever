# 02 · 测量工具与设计样例库

类型：计划（结果块）
负责：设计样例库的截图脚本、阅读页的样例页面与尺寸、规格第 8.2 节的测量工具与基线
状态：Pending

## Outcome

- `node scripts/design-samples.mjs serve` 与 `capture` 能正常运行，截图包含阅读页，尺寸有 1440×900、1024×768 与 390 宽。
- 一个测量工具在仓库自己的 Playwright 上运行规格第 8.2 节的检查，输出一份带数字的报告。
- 现有代码上的基线数字已经测出并记录，后续每一块都和它比较。

规格：[8.2 浏览器检查](../../architecture/web/reading-experience.md#82-浏览器检查)；样例库的用法见 [Web 设计](../../architecture/web/README.md)“设计原型”一节。

## 进入条件

- G1。
- 测量口径按规格第 8.2 节；“样子不变”的对照按规格第 10 节。

## 责任边界

- 负责：前端实施者。
- 拥有：`scripts/design-samples.mjs`；`apps/web/test/design-samples-fixture.ts`、`design-samples-pages.ts`；新增的测量工具与测试。
- 触达：`apps/server/test/archive-fixture.ts`（只为拆出不依赖 `vitest` 的部分）；`apps/web/src/` 中提供测试计数器的几处（见 2.4）。
- 不改：样例库现有页面的路由与就绪条件；`design-rules.test.ts` 与 `design-samples.test.ts` 已有的断言；任何服务端源码。

## Tasks

- [ ] **2.1 修复截图脚本**
  - 现状：`scripts/design-samples.mjs` 用 esbuild 打包 `apps/web/test/design-samples-fixture.ts`；它导入 `apps/server/test/archive-fixture.ts`，后者从 `vitest` 导入（`afterAll` 等），打包后的模块在 Node 里无法加载。
  - 做法：把样例库用到的部分（`archiveModel` 等）移到一个不导入 `vitest` 的模块，`archive-fixture.ts` 从那里重新导出，原有测试不受影响；或者在脚本里把 `vitest` 标为外部并确保运行路径不调用它。选择其一并在进度里写明理由。
  - 验收：`node scripts/design-samples.mjs serve` 在 127.0.0.1:4175 就绪；另开终端 `node scripts/design-samples.mjs capture --label baseline --themes light,dark` 截出全部现有页面；`apps/web/test/design-samples.test.ts` 与原有用到 `archive-fixture.ts` 的测试照常通过。
- [ ] **2.2 增加 1024×768 尺寸**
  - `capture` 现在只截 1440 与 390 宽。增加 1024×768，作为规格第 8.2 节“截图”一行要求的第三个尺寸；默认仍截三种，可用参数只截一种。
- [ ] **2.3 阅读页的样例页面**
  - 在 `design-samples-pages.ts` 中补齐第一次交付要看的阅读页状态：PDF、全文、长文档（分批载入）、只有 PDF 没有文本、只有书目、加载中（用延迟响应造出来）。
  - 样例的合成材料放在现有的合成库里；长文档样例的页数与篇幅足以出现分批载入（与计划 19 测量用的长文档同一量级）。
- [ ] **2.4 测试计数器**
  - 按规格第 8.2 节“测量口径”的“计数”：阅读器只在测试构建中提供计数器，记录引擎构建、PDF 字节请求、sha256 计算、worker 启动与终止、画布数、对象 URL 的创建与释放。位置：`app/features/reader/Reader.tsx`（引擎构建）、`reading/transport.ts`（请求与 sha256）、`reading/pdf.ts`（worker、画布）。
  - 生产构建里没有计数器：用构建期常量去掉，并加一项测试确认生产包里不含它们。
  - 只计数，不改行为，不显示任何界面。
- [ ] **2.5 测量工具**
  - 新增 `apps/web/test/reader-smoothness.test.ts`（Vitest + Playwright，沿用 `design-samples-browser.ts` 启动样例库的方式），按[规格第 8.2 节的测量口径](../../architecture/web/reading-experience.md#82-浏览器检查)（静止、锚点移动、有画面、视图切换的耗时、计数）逐项实现检查。第一次交付期间，阅读线按[规格第 10 节](../../architecture/web/reading-experience.md#10-新版面之前的规则)。检查项：锚点保持、视图之间的位置、不出现空白画面（逐帧采样）、后台刷新、不重复下载、PDF 缩放、过渡、性能。
  - 书脊、排版、截图三行在第二次交付才有对象，先留出结构，标为“未实现”而不是跳过后算通过。
  - 每项输出数字，写入 JSON 报告；环境变量给出报告目录时写到那里（`sandbox/reports/2026-11-13-reader/<块号>/`），否则写到系统临时目录。
  - 时限遵守 HARNESS：Playwright 操作与等待不低于 20 秒。
- [ ] **2.6 现有代码上的基线**
  - 在未改动的阅读页上运行 2.5，记下每项数字（预期多项不通过，例如视图切换会重建引擎）。
  - 基线截图用 2.1 的 `capture --label baseline`，三种尺寸、两种主题都截。其中规格第 10 节列出的四张（1440×900 下的文献库、PDF 视图、全文视图、打开信息栏的阅读页）是第一次交付“样子不变”的对照；如果样例库的页面清单里没有“打开信息栏的阅读页”，在 2.3 中加上。

## 集成与影响

- 样例库与截图是 Owner 审阅的材料，修复后所有计划都能用。
- 计数器只在测试构建中存在，生产代码的行为与包内容不变。

## 验证

- 2.1：上面的两条命令与 `design-samples.test.ts`。
- 2.4：生产构建的产物里不含计数器。
- 2.5：`reader-smoothness.test.ts` 在现有代码上能跑完并产出报告；对故意注入的回归（例如把锚点恢复关掉）能报出失败。
- 定向运行：`pnpm vitest run apps/web/test/design-samples.test.ts apps/web/test/reader-smoothness.test.ts`。

## 证据

修复方式与理由；三种尺寸的基线截图位置；基线报告的位置与各项数字；提交号。

## 退出条件

截图脚本可用；测量工具能对第一次交付的各项检查给出数字；基线已记录。03–06 可以用它验收。

## 恢复与交接

2.1–2.4 各自可单独合入。2.5 未完成时，03–06 的验收用其中已经实现的检查，未实现的检查在交付验收块（07）之前补齐。中断时保留已有报告，不覆盖基线。
