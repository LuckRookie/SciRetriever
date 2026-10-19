# 动效预设

统一提供按下、指示条、浮层、对话框、抽屉、面板、展开、提示、证据和淡入的参数。Motion 只装饰已经同步完成的状态变化，不承担任务生命周期。页面不可见或选择减少动效时，运动立即完成。

`MotionProvider` 接受外部偏好；`Presence` 只使用 sync 模式，`AnimatedPanel` 的 layout 只使用 position FLIP。禁止 popLayout、AnimateView 和动态插入 style 标签。控件色彩和按下态由静态 CSS 处理。

[应用源码](../README.md) · [交互实验台](../features/lab/README.md)

`AnimatedPanel`的可选active保持折叠内容挂载，maxAnimatedHeight用于短内容动画的上限；ResizeObserver仅测量已连接内容，超过上限即停止当前动画并立即就位。没有对height或width做动画，也不等待动画决定业务状态。

减少动效在 CSS 层直接关闭动画和过渡；不使用极短动画模拟关闭，以免仍触发弹层的动画结束与同步状态更新。系统偏好和应用内设置采用同一规则。
