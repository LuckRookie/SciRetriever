# Web 阅读渲染依赖与兼容性

2026-10-19 核对。以下依赖用于已确认的 G2/G3 生产接入；验收证据以当前计划与测试为准。

| 组件 | 固定版本 | 许可 | 作用与运行边界 |
| --- | --- | --- | --- |
| `pdfjs-dist` | 6.4.299 | Apache-2.0 | 浏览器端固定 PDF 字节渲染、文字层、页码、目录和查找；Node engine 为 >=22.13.0 或 >=24，当前 Node 22.19.0 可构建 |
| `marked` | 18.1.1 | MIT | Markdown 词法/语法解析；**本身不消毒 HTML**，必须禁用原始 HTML、过滤链接并受控解析资源 |
| `fflate` | 0.8.2 | MIT | 在浏览器中把 CSV/Markdown 正文和来源说明打包为单个 ZIP，无外部请求 |
| `katex` | 0.19.0 | MIT | 本地数学排版与字体；`trust:false`，限制宏展开与尺寸，错误回退为可见原式 |

依赖固定在 `apps/web/package.json` 与 pnpm lock，仅为本轮阅读组件所需，不升级其它已锁定依赖。PDF.js 依赖树包含可选的 `@napi-rs/canvas`，浏览器打包无需引入其原生执行路径；正式安装资产必须单独核对，不能把完整 npm 包约 35 MB 的体积等同于实际 Web 下载。

PDF.js 的主模块与 worker 必须同版本、从本地静态白名单提供；cMaps、standard_fonts、wasm 与 KaTeX CSS/字体也需随正式构建交付。不以 CDN 或原始 Markdown 中的远程 URL 补缺少资产。生产使用 6.4.299 的官方 `legacy/build` 主模块和 worker，以支持项目 Playwright 1.55 所带的 Chromium 140；默认 `build` 依赖其尚未实现的 `Map.getOrInsertComputed`，会出现文件读入成功但页面无法绘制。兼容构建内含 core-js 3.50.0（MIT），其[上游许可证](https://github.com/zloirock/core-js/blob/v3.50.0/LICENSE)随第三方声明一起打包，无需新增运行时依赖。仍使用受控 Worker、`enableXfa:false` 与固定字节；该版本类型已不提供旧 `isEvalSupported` 选项，CSP 不开放 unsafe-eval；解析产物中的 HTML/脚本按文本处理，图片需经固定文档资源 owner 读取，不能直接把任意解析 HTML 交给 DOM。

6.4.299 的文字层样式使用 `--total-scale-factor`、`--font-height` 和缩放变量。只复制旧版 TextLayer 的绝对定位样式会导致选择区域与可见字形不一致。可从同版本 `web/pdf_viewer.css` 提取必要样式，保留 Apache 许可标注；正式控件继续使用 SciRetriever 设计，不整页照搬 PDF.js viewer。

2026-10-19 最终兼容构建的阅读主模块约 1.72 MB、worker 约 2.42 MB，reader 支持资源目录合计约 7.05 MB（已含 worker）；均为未压缩体积，支持资源按需请求。生产实现按阅读路径加载独立模块，常规文献列表不提前解析阅读代码。PDF.js/Marked/KaTeX/fflate 及兼容构建内含 core-js 的许可证作为 third-party-notices.txt 随静态资源一起交付。

主工作台生产 CSP 已支持本地 worker 和 PDF 字体 Blob（`worker-src 'self'; font-src 'self' blob:`）；页面/文字层/公式布局使用受控 style 属性，沿用正式工作台已有的 `style-src-attr 'unsafe-inline'` 范围。无需允许 `unsafe-eval`、外部脚本、对象插件或远程连接。独立只读入口现有 CSP 更严格，接入时必须同步验证，不靠开发预览放行证明可发布。

真实含图 PDF 复测后，主工作台 `script-src` 增加精确的 `'wasm-unsafe-eval'`，允许本地 PDF.js WASM 解码／色彩管理；仍不允许 JavaScript `eval`／`Function`。浏览器回归分别验证 WASM 编译可用和动态 JavaScript 编译被拒绝，不能用普通脚本放宽替代这项权限。

一次性性能与资源测量只说明固定合成样本和环境，保存在本机 sandbox。当前样本是 100 页、每页两行文字的 36,419 字节 PDF，不能外推为扫描论文或复杂图片的性能。G3 已确认本机该合成样本冷首屏 ≤2 s、热首屏 ≤1 s、翻页/缩放/查找 ≤500 ms；实际测试须区分字节读取/校验、PDF 解析和可见页绘制，并在相同环境完成最终复测；渲染不是科学内容正确性的证明。

参考：[PDF.js](https://github.com/mozilla/pdf.js) · [PDF.js 发行包](https://github.com/mozilla/pdfjs-dist) · [Marked 安全说明](https://marked.js.org/) · [KaTeX 安全选项](https://katex.org/docs/options.html)。

[Notes 导航](README.md) · [Web 设计](../architecture/web/README.md) · [阅读计划](../plans/2026-10-18-web-capability-and-reading/04-reading-workspace.md)
