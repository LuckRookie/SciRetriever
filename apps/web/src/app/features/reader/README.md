# 阅读界面

这里拥有 React 阅读标签的工具栏、可收起的信息栏、总结分组和证据预览。`Reader.tsx` 根据既有 URL、固定材料与文档来源创建生命周期；`ReaderInformation.tsx` 呈现书目摘要、来源、已保存引用与处理入口；`SummaryView.tsx` 和 `summary-data.ts` 验证并展示已发布的知识 artifact 或处理器 knowledge result。

PDF.js、连续 Markdown/KaTeX 与字节校验保留在 [reading](../../../reading/README.md) 的框架无关引擎中。React 通过 `ReaderFrame` 接收页码、目录、查找、可重试错误与图片/文内链接预览，不接管已稳定渲染的正文节点。切换材料会取消旧请求并释放 worker、canvas 和对象 URL。阅读位置按库、文献、模式及不可变材料隔离；关闭标签释放会话状态。

总结只映射合同已有的 finding、method、result、limitation、disagreement 五种类别，不编造研究背景、不翻译或重新生成内容。证据短编号使用固定版本查询后展示原文；无法映射 PDF 页码时只定位到正文段落。全文中的显式 `#heading` 链接只在目标标题已加载且能确定匹配时提供预览；裸 `[1]`、原始 HTML 锚点和未加载目标不被猜测成参考文献。

`reading.css` 位于 `pages` 层，定义正文、三档行宽、四档字号和窄屏布局；共用的控件与浮层继续由 [components](../../components/README.md) 提供。加工按钮进入既有 `OperationDialog` 确认，不由阅读组件调用解析器或模型。

[上级功能目录](../README.md) · [应用源码](../../README.md)
