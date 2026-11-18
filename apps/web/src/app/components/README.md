# 共享控件

React Aria 提供按下、键盘、焦点和弹层行为；`index.tsx` 是页面唯一组件入口。动作、字段、导航、内容和结果表分别实现，样式统一消费上级 `styles/` 的变量。业务请求、URL 与偏好属于 `data/`，不在此保存事实。

加工按钮通过 `confirm` 给出范围和服务后才调用 `onPress`；取消没有回调。`disabledReason` 同时禁用动作并提供键盘可读原因。`DataTable` 采用 TanStack Table v9，排序仅针对传入行，不声称重新查询全部结果。`SplitPane` 的受控宽度由外壳保存为本机偏好。

组件使用示例和可交互状态位于 [画廊](../features/lab/README.md)。[应用源码](../README.md)

普通 Button 在等待超过1秒后给出“正在提交…”；原标签继续提供稳定的可访问名称和宽度，pending覆盖层不挤动布局。提交中的React Aria状态保留焦点且阻止重复执行。Disclosure折叠不卸载子组件；短内容采用共同collapse/position FLIP，超过480px的内容及减少动效直接展开，不逐帧改变高度。

证据 Popover 以触发点所在阅读区域限制尺寸与定位，最大高度交给 React Aria 的定位器计算；保留关闭预览按钮和 Escape 关闭，异步内容、缩放或视口变化后也能恢复页面操作。文内悬停预览保留独立非模态行为。

状态到颜色的映射只在 `status.ts`（设计内核规则 5）：页面给状态标签或状态图的填充写上 `data-tone`（done、pdf、problem、other、running），颜色由 `components.css` 按令牌给出。
