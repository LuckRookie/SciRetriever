# 锁定依赖补丁

本目录只维护当前依赖确需的最小兼容补丁。pnpm 在锁定版本安装时应用，升级时必须
复核上游实现并重新验证，不修改第三方许可证。

`react-aria@3.52.1.patch` 将移动 WebKit 的 `usePreventScroll` 固定
`overscroll-behavior: contain` 规则从运行时 `<style>` 移到 Web 的外部
[`react-aria.css`](../apps/web/next/public/react-aria.css)，使用可恢复的根元素属性
启停。原来的滚动、触摸和焦点行为保留；同时覆盖 ESM、legacy ESM 与 CommonJS
三个上游发布入口。上游为 Adobe React Spectrum，Apache-2.0。

Button 的固定 `touch-action` 规则也在同一外部文件中，通过上游已有 stylesheet ID
检测避免注入，未修改 `usePress`。Motion 禁止使用会注入样式的 `popLayout` 和
`AnimateView`。兼容性来源与验证见[依赖说明](../docs/notes/web-frontend-dependencies.md)。

[项目导航](../README.md)
