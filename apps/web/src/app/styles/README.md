# 设计语言样式

加载次序为 `tokens.css`、`base.css`、`components.css`，页面样式放在 `pages` 层。四主题沿用已确认原型配色，界面18px、文献与阅读20px、辅助17px，控件40/36/28px。所有圆角、状态、焦点与时长由变量定义。

本目录不改变 `prototype.html`。页面不复写共享控件样式，不使用 ID 选择器；减少动效的兜底规则外不使用 important。字体资产若未提供，按已确定字体栈回退，不能声称已加载内置字体。

[应用源码](../README.md) · [组件](../components/README.md)
