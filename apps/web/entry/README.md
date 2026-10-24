# React 工作台静态入口

类型：代码导航
负责：React 工作台静态入口
状态：现行

本目录提供 Vite 的 HTML 入口和 `public/` 中不经 JavaScript 注入的固定样式。
界面源码位于 [`src/app/`](../src/app/README.md)，构建由
[`build-react-assets.mjs`](../../../scripts/build-react-assets.mjs) 交付到服务端。

`react-aria.css` 外置 React Aria 的触摸与移动端滚动规则。HTML 中的
`react-aria-pressable-style` stylesheet ID 让依赖识别已经交付的规则；移动端滚动
通过[锁定补丁](../../../patches/README.md)切换属性，保持生产 CSP 不变。

[Web 导航](../README.md)
