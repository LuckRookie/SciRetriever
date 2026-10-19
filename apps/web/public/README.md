# Web 页面与样式

保存可维护的 HTML/CSS 页面源文件。

## 内容入口

- [index.html](index.html)：静态样本入口。
- [live.html](live.html)：按定稿原型接入的正式文献库工作空间与共享表单模板。
- [query.html](query.html)：只读文献查询页面。
- [maintenance.html](maintenance.html)：显式维护工作台页面。
- [styles.css](styles.css)：公共样式。
- [workspace.css](workspace.css)：定稿原型样式及生产功能的样式适配。
- [reading.css](reading.css)：连续阅读、全文排版、PDF 页与文字层的布局。
- [live.css](live.css)：独立查询与维护页面使用的共享样式。
- [core-js-LICENSE.txt](core-js-LICENSE.txt)：PDF.js 官方兼容构建内含的 core-js 3.50.0 上游许可，构建时并入第三方声明；来源见[依赖说明](../../../docs/notes/web-reading-dependencies.md)。

## 放置边界

交互逻辑放 ../src；构建后的 bundle 由 scripts/build-workbench-assets.mjs 生成，不手工编辑 dist。

[上级目录](../README.md) · [项目 README](../../../README.md)
