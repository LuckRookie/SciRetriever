# 浏览器扩展

类型：代码导航
负责：网页收藏扩展（计划 20 · 09）
状态：现行

Chrome、Edge 用的 Manifest V3 扩展，用法见[浏览器扩展指南](../../docs/guides/browser-extension.md)，弹窗规格见[页面规格](../../docs/architecture/web/page-specs.md#浏览器扩展弹窗)。

| 文件                                           | 职责                                                           |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `src/page.ts`                                  | `readPage`：注入当前页读标识与书目标签，自包含，不引用外部代码 |
| `src/capture.ts`                               | 连接码解析、页面字段到中性书目的转换、文献库收藏接口的客户端   |
| `src/popup.ts`                                 | 弹窗界面：连接、读页、查询、收藏、PDF 下载与上传、设置         |
| `src/manifest.json`、`popup.html`、`popup.css` | 扩展清单与弹窗页面                                             |

构建：根目录 `pnpm build` 的最后一步运行 [`scripts/build-browser-extension.mjs`](../../scripts/build-browser-extension.mjs)，用 esbuild 打包到 `dist/extension/`，再打成 `apps/server/dist/agent-access/browser-extension.zip`，由文献库在 `GET /api/v1/capture/extension` 提供下载。测试在 `test/`：页面读取用 Chromium 加载合成页面，收藏流程对合成文献库走通配对、查询、保存与 PDF 上传。

[应用实现](../README.md)
