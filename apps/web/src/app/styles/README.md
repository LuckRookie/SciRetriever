# 设计语言样式

加载次序为 `tokens.css`、`font-faces.css`、`font-faces-cjk.css`、`base.css`、`components.css`，页面样式放在 `pages` 层；登录页按同样次序引入。颜色、字体、字号与尺寸集中在 `tokens.css`；七套阅读主题（设计内核“主题”）共用同一套组件样式，状态到颜色的映射只在 `components/status.ts`。所有圆角、状态、焦点与时长由变量定义。

页面不复写共享控件样式，不使用 ID 选择器；减少动效的兜底规则外不使用 important。字体资产若未提供，按已确定字体栈回退，不能声称已加载内置字体。

[应用源码](../README.md) · [组件](../components/README.md)
