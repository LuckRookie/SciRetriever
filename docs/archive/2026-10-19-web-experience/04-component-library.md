# 04 组件库与动效基础

状态：Completed。组件、状态、动效、一致性及最终 Full 验证通过，减少动效整轮同时通过。

**Outcome**：`apps/web/src/app/components/` 提供一套完整组件，每个组件都具备六态：默认、悬停、按下、焦点、禁用（附原因）、提交中。`apps/web/src/app/motion/` 提供统一的动效预设，参数来自 G4。

完成后可以观察到：

- 组件画廊（`view=gallery`）可以逐个操作所有组件，切换四个主题和“减少动效”；
- 一致性测试证明画廊上的高度、圆角、焦点样式只取规定值；
- 06–09 实现页面时不需要手写任何控件样式或动画。

**进入条件**：

- G4 已确认；
- `tokens.css`、动效参数 JSON、控件使用规则已交接。

**责任边界**：

- 本块拥有 `components/`、`motion/`、`styles/components.css` 以及组件测试；
- 不接入真实数据，数据层属于 05；
- 不实现页面。

## 组件实现约定

- 行为基于 **React Aria Components**，样式由我们的 CSS 提供。六态通过 React Aria 暴露的数据属性写 CSS，不在 JS 中拼接类名：
  - `data-hovered`、`data-pressed`、`data-focus-visible`、`data-disabled`；
  - `data-selected`、`data-entering`、`data-exiting`。
- “按下”使用 React Aria 的 press 事件，在指针按下（pointerdown）时就进入按下态，并兼容触摸和键盘。
- 弹层（Popover、Menu、Dialog、Tooltip）的定位、避让屏幕边缘、焦点圈定和焦点归还，都使用 React Aria 的内置能力。
- 动画只通过 `motion/` 模块调用，组件内不直接写 Motion 参数。
- 组件对外的属性统一命名：`variant`、`size`、`icon`、`isPending`、`disabledReason`、`confirm`。

## Tasks

- [x] **4.1 基础样式层**
  - `styles/` 下按顺序组织：`tokens.css`（来自 G4）、`base.css`（重置、排版、焦点）、`components.css`。
  - 用 `@layer tokens, base, components, pages` 声明层级顺序。
  - 禁止在任何地方使用 ID 选择器写样式；不使用 `!important`（“减少动效”的兜底规则除外）。
- [x] **4.2 动效模块 `motion/`**
  - 把 G4 的参数写成预设：`press`、`indicator`、`popover`、`dialog`、`drawer`、`panelContent`、`collapse`、`toast`、`highlight`、`listItem`、`fadeIn`。
  - 提供以下接口：
    - 读取“减少动效”的 hook：`prefers-reduced-motion`，加上设置中的手动开关（如果 G4 要求提供）；
    - `AnimatePresence` 的统一封装，不使用会注入 `<style>` 的模式（见 02 的 CSP 验证）；
    - 布局过渡的统一封装，即 Motion 的 `layout`（FLIP），只能作用在 transform 上。
  - 规则：
    - 业务状态先同步改变，动画只是装饰；
    - 动画可以被打断，新动画接续当前位置；
    - “减少动效”或页面不可见时动画立即完成。
  - 测试：连续两次开关、动画进行中卸载组件、减少动效、页面隐藏。
- [x] **4.3 动作类组件**
  - `Button`：
    - 变体：主要、次要、文字、危险、加工；
    - 尺寸：40 / 36；
    - 可带图标；
    - `isPending` 时显示内嵌加载指示并锁定宽度；
    - 提交成功或失败时可以短暂显示“✓ 已提交”或错误；
    - 按下缩放与弹回按 G4 参数。
  - `IconButton`：尺寸 40 / 36 / 28，必须有 `aria-label` 和提示。
  - **加工按钮**（`variant="process"`）：
    - 点击后先弹出 `ConfirmDialog`，说明范围、会调用的外部服务和预计规模；
    - 确认后才执行；
    - 取消后不发出任何请求。
  - `disabledReason`：禁用时悬停或聚焦显示原因，读屏可读。
- [x] **4.4 输入类组件**
  - `TextField`、`SearchField`（前置图标、清除按钮、Esc 清空）、`Select`（统一箭头，弹层列表）、`TextArea`（自动增高，有上限）、`NumberField`、`Checkbox`、`Radio`、`Switch`。
  - 共用 `Field` 外框：标签、说明、错误信息、必填或可选标记。
  - 校验错误就地显示，并通过 `aria-describedby` 关联。
- [x] **4.5 选择与导航类组件**
  - `SegmentedControl`：同一对象的不同视图；滑块随选中项平移（`indicator` 预设）；方向键切换。
  - `Tabs`：页内并列分区；下划线指示条平移；面板内容直接替换，不滑动。
  - `FilterChip` / `ChipGroup`：筛选；可带数量与移除按钮。
  - `Badge`：固定语义色（仅元数据、有 PDF、内容已就绪、进行中、部分完成、完成、失败、无法获取）；不可点击。
  - `Disclosure`：展开区；统一箭头；高度展开用 `collapse` 预设，短内容才加动画，长内容直接展开。
- [x] **4.6 浮层类组件**
  - `Menu` / `MenuTrigger`：从触发点方向出现；支持分组与快捷键提示。
  - `Popover`、`Tooltip`：悬停延迟统一。
  - `Dialog` / `ConfirmDialog`：打开时焦点进入对话框，关闭后焦点归还触发点；Esc 关闭。
  - `Drawer`：活动抽屉、证据侧栏等。
  - `Toast`：
    - 由全局队列管理，同一时间只显示一条；
    - 显示 4 秒，悬停时暂停；
    - 可带“查看”或“撤销”；
    - 读屏通过 `aria-live` 播报。
- [x] **4.7 内容类组件**
  - `EmptyState`：一句事实、一句下一步、最多一个按钮。
  - `Skeleton`：等待超过 300 ms 才出现。
  - `ErrorNotice`：说明保留了什么、如何重试。
  - `Card`、`ListRow`（标题、书目、徽标的对齐规则）、`DataTable`（TanStack Table 加我们的样式：表头吸顶、行选择、排序指示）。
  - `SplitPane`：可拖动的栏宽，支持键盘调整、双击恢复默认；拖动时不加动画。
  - `TechDetails`：统一的“技术详情”折叠区，用等宽字体，带复制按钮。
- [x] **4.8 组件画廊**
  - `view=gallery` 页面列出 4.3–4.7 的全部组件和变体，每个组件都展示六态。
  - 每个组件注明“用于什么、不用于什么”。
  - 页面顶部可以切换四个主题和“减少动效”。
  - 只在开发构建或带参数时可见。
- [x] **4.9 组件测试**（在真实 Chromium 中运行画廊）
  - 每个组件覆盖：键盘操作、ARIA 角色与名称、焦点归还、禁用原因可读。
  - 加工按钮：确认取消后没有回调；确认后只执行一次；`isPending` 期间重复点击无效。
  - 动效：默认模式与“减少动效”双跑；连续开关 10 次后状态正确。
  - CSP：画廊页面控制台没有违规。
- [x] **4.10 一致性测试**
  - 新增 `apps/web/test/design-consistency.test.ts`，复用 03 的审计脚本，在画廊上断言：
    - 高度只有 {40, 36, 28} 三档；
    - 圆角只取变量值；
    - 焦点样式只有一种；
    - 没有浏览器默认外观的表单控件。
  - CSS 静态检查：
    - `border-radius`、`transition-duration`、`animation-duration` 只能使用变量；
    - `transition` 不包含 `width`、`height`、`top`、`left`、`all`；
    - 不出现 ID 选择器；
    - 不出现 `!important`（兜底规则除外）。
  - 06–09各页加入统一计算样式矩阵（design-audit）与相应组件/业务状态回归，复用同一审计数据模型。
- [x] **4.11 字体（G4 选择方案 A 时）**
  - woff2 子集与 `@font-face`（`font-display: swap`）随新工程打包。
  - OFL 声明并入第三方声明。
  - 验证离线可用，记录体积变化。

## 本轮实施记录（2026-10-19）

Owner 对 G4 的反馈为“目前就挺好的，加了 motion 之后手感好多了”，本轮以实验台当前参数为准。共享组件、四主题令牌、动效模块、真实组件画廊和 12 类 A/B/C 交互实验均已接入；保留 18 px 界面、20 px 阅读、40 / 36 / 28 px 控件尺度。

- `components-gallery.test.ts` 覆盖显式加工取消/确认、焦点恢复、菜单/字段/标签键盘行为、禁用原因、栏宽、连续十次开关和 CSP；`design-consistency.test.ts` 覆盖四主题控件尺度、窄屏溢出与静态规则。生产处理器/阅读/设置测试同时验证共享控件在实际表单中的行为。
- 支持系统减少动效、手动减少动效和页面不可见；未使用 `popLayout` 或动态 `<style>`。`AnchoredPopover` 供阅读引擎已验证的显式链接使用，定位与焦点仍归 React Aria。
- Source Sans 3 / Source Serif 4 的 Latin normal/italic variable WOFF2 共 159,612 bytes；本地自托管、`font-display: swap`，OFL 声明随发行包。登录入口使用系统字体，避免认证前请求受保护字库。
- 四个固定主题与跟随系统保留：跟随系统仅在 light/dark 间选择，显式 green/warm 不随系统变化。偏好仅使用当前React命名空间；旧键兼容按Owner最新决定撤销，测试验证当前键、刷新、系统变化和旧键不生效。
- 控件边框使用独立 `--control-border`，装饰分隔线保持原值。沉降后的四主题各 20 个有边框控件计算样式样本，最小对比度为 light/green/warm 3.06:1、dark 3.51:1；报告为 `feature-review/controls-*.json`，不把透明文字按钮或动画中间帧误计为边框失败。焦点环不再错误套住整个 Tabs 容器。
- 4.10组件基线、最终生产版144默认页面矩阵及对应状态回归已通过；新入口结果独立于旧基线。

### 4.10 的验收范围

`design-consistency.test.ts` 已验证画廊四主题按钮的 40/36/28 px 高度、8 px 按钮圆角、390 px 无全页横向溢出，以及 tokens/base/components 三份 CSS 的 ID/圆角/几何 transition 规则；`components-gallery.test.ts` 验证键盘、Dialog 焦点归还、禁用原因与无运行时 `<style>`。这些是具体样本与规则，不是“每种组件六态全部自动扫描”的证明。业务页采用相同组件；默认页面矩阵由design-audit覆盖，浮层、错误、加载、提交及禁用状态由具体组件/业务旅程覆盖，不冒称全页面全状态笛卡尔积扫描。

系统初始为减少动效时，实验台开关本来已打开，第一次切换理应关闭减少动效。回归现在先核对初态，再分别验证显式 full 与 reduced 能覆盖系统偏好，不用把固定 `true` 断言当成控件行为。

最终Quick包含在 `final/full-root.log`；Full与生产版减少动效整轮均已通过，见11。

## 集成与影响

- 共享组件服务于唯一React前端；旧界面已删除。
- 组件 API 一旦被页面使用就保持稳定；需要修改时，在本块记录并同步所有调用方。

## 验证

- 组件测试与一致性测试通过；
- 审计脚本在画廊上的“组件基线”达到 G4 的目标；
- 画廊截图（四主题）与 G4 实验台的选择一致；
- Quick 通过。

## 退出条件

- 4.1–4.10 完成（4.11 取决于 G4 的选择）；
- 05–09 只依赖这些组件即可实现页面。

## 恢复与交接

- 某个组件不符合 G4 选择时，只修改该组件，不在页面层打补丁覆盖。
- React Aria 的某个行为与需求冲突时，优先通过它的 API 配置解决；确需自写时记录原因。

交给 05–09 的内容：

- 组件清单与 API；
- 动效预设清单；
- 画廊链接。

[计划入口](README.md)

补充实施：Button的原标签留在正常布局和可访问名称中，pending反馈用绝对定位层覆盖，1秒后给出“正在提交…”；React Aria的isPending维持焦点并阻止重复执行，不再用disabled替换提交中。Disclosure内容不因折叠卸载，短内容通过共同AnimatedPanel进入/position FLIP，超过480px或减少动效立即完成，未引入height/width动画。普通/减少动效各2文件5项组件测试通过，包括原名称可定位、提交中宽度/焦点、单次执行、草稿保留和长内容直接显示。

最终统一验收：`pnpm full` 退出0，285文件 / 1,981项全部通过、无跳过；生产版减少动效另跑36文件 / 84项全部通过。完整证据与环境边界见 [11 最终验收](11-cutover-and-cleanup.md)。
