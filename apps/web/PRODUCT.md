# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

主要使用者是个人研究者，在电脑上操作自己的文献库：发现和导入文献、补充材料、检索阅读、核对证据，并按需发起加工和综合。此使用场景已由 Owner 于 2026-10-15 确认。

Web 面向人，CLI 和 MCP 主要面向科研 Agent 与自动化。普通人类流程应能在 Web 中独立完成；深入诊断和维护可借助连接项目 MCP 或使用 CLI 的 Agent。课题组协作、账户权限和移动端优先使用尚未确认为产品目标。

## Product Purpose

SciRetriever 为科研 Agent 和人提供同一逻辑文献库中的元数据、原始论文材料、可读文档、有证据的知识压缩与综合，以及可追溯的检索上下文。用户能够找到材料、判断已有内容是否足以使用，并核对知识所依据的原文。

本文件是供 Impeccable 使用的产品上下文摘要与索引，不另立需求或架构合同。[产品需求](../../docs/architecture/requirements.md)和 Accepted ADR 定义目标与边界；[Web 使用指南](../../docs/guides/web-workbench.md)、源码和测试说明当前行为。修改产品目标时先更新所属真相源，再同步此摘要。

## Positioning

统一文献数据库是产品基础。元数据、材料、知识与证据共享可追溯的身份、来源和版本；Web、CLI、MCP 通过共同业务服务使用这些事实。界面围绕文献、选择范围和查询结果组织功能，用户不必沿固定的获取、解析、分析管线操作。

按 [ADR 0033](../../docs/architecture/decisions/0033-machine-interfaces-cover-web-capabilities.md)，在相同授权、配置和运行条件下，CLI 与 MCP 各自覆盖 Web 的业务能力。Web 的完备性以常用业务能否完成来评价，不要求把全部运维命令或协议表单搬进页面；主题、面板和阅读标签等界面偏好不属于业务能力对等范围。

## Operating Context

- 正式入口是 `sciretriever web`，默认监听 `0.0.0.0`，通过密码或启动时输出的临时 API key 登录。登录后直接使用文献库，无首次启动配置向导；测试也沿用相同认证边界。
- 配置与默认库、资产位置在 `~/.sciretriever/` 下，已有显式配置优先；设置中修改存储路径后重启生效，不隐式搬迁已有数据。
- 用户先确定文献或范围，再按需执行操作。查询和阅读可以独立于材料获取与加工进行。
- 产品面向长期积累、万篇文献起步并持续增长的库。单次视图或批次上限不等于库容量目标；此规模要求不代表当前实现已经通过相应验收，须以指南和测试证据核实。
- 服务运行时，关闭网页标签不等于取消后台任务；停止服务后不承诺有脱离进程的执行器继续工作。共享库路径也不代表多个入口自动共享同一个活 Browser 会话。

运行、配置与当前能力以 [Web 使用指南](../../docs/guides/web-workbench.md)及 [Agent 接口指南](../../docs/guides/agent-interface.md)为准。

## Capabilities and Constraints

- 常用业务包括发现与书目导入、获取及人工补充 PDF、解析与身份核验、分析与集合综合、库内筛选与检索、阅读与证据核对、导出、配置以及任务查看和控制。操作范围、可用前置条件与结果以所属用例为准，不从原型控件推断能力已经实现。
- 查询、阅读、展开证据和观看 Browser 不隐式触发扩充或加工。用户明确发起写操作和外部访问；界面说明实际范围与副作用，不把“已接收任务”显示成“已经完成”。
- 自动获取不依赖人工帮助。主界面不以“缺 PDF”“需人工 PDF”等待办队列为中心；用户愿意时，可从文献记录主动补充 PDF。一次主 PDF 获取的业务结果区分已经获得与没有获得；安全提交失败须作为系统失败处理，不能伪装成没有获得。
- Browser 默认用于观看 Agent 操作。用户明确点击或输入时申请控制权，取得控制权后才发送操作；页面版本、会话和控制状态必须有效。交还须确认成功，意外断线不能等同于主动交还。具体边界见 [ADR 0032](../../docs/architecture/decisions/0032-library-centered-web-workspace.md)。
- 三端共用业务 owner 和文献事实；保留来源、稳定引用、hash 与 lineage，已接纳原始资产和发布产物不可原地覆盖。接纳 PDF 不等于已经核验文章身份。
- 凭据不回显秘密值；不提供任意服务器文件、SQL、JavaScript 或 CDP 访问。常规人类流程无需手写 JSON 或 CLI 命令。
- 保存视图与主题属于界面偏好，不产生另一份文献事实。通用处理器可以按调用方规范生成记录或标签，也支持外部提取交付；结果始终是带证据的候选，领域 schema 和最终数据集归调用方所有。

阅读体验允许继续深化，但须单独设计。现有 PDF、全文与知识阅读不代表已提供阅读批注、笔记、完整精确定位或 Zotero 插件兼容；本轮不作这些承诺。正式无障碍验收标准尚未单独确认。

## Brand Commitments

产品名称为 SciRetriever。界面以明确的对象、动作和真实结果帮助研究者操作，避免让内部协议和服务术语成为普通任务的理解门槛。

设计依据见 [ADR 0038](../../docs/architecture/decisions/0038-web-design-basis.md)，视觉规则与页面排布分别见[设计内核](../../docs/architecture/web/design-core.md)与[页面规格](../../docs/architecture/web/page-specs.md)。具体基准统一见[当前 Web 设计说明](../../docs/architecture/web/README.md)，不退回早期三栏线框或任务工作台方案。

Owner 允许蓝白、墨绿、暖白等色系切换；主题扩展遵循同一已确认布局，默认设计及适用边界以 ADR 0032 和当前设计说明为准。本文件不另定色值、字体、间距或组件规范。

## Evidence on Hand

- [产品需求](../../docs/architecture/requirements.md)、[ADR 0032](../../docs/architecture/decisions/0032-library-centered-web-workspace.md)与 [ADR 0033](../../docs/architecture/decisions/0033-machine-interfaces-cover-web-capabilities.md)：产品边界、库中心 Web 和三端能力关系。
- [当前 Web 设计说明](../../docs/architecture/web/README.md)：现行的布局、视觉和交互依据。
- [Web 使用指南](../../docs/guides/web-workbench.md)和 [React 应用实现](src/app/README.md)：当前功能与界面的实现依据。正式 `/` 使用React；只保留当前界面入口与偏好，不维护迁移期 `/next` 或旧前端兼容。最终验收见[实施计划](../../docs/archive/2026-10-19-web-experience/README.md)。4173合成样本不替代正式入口。

## Product Principles

1. 围绕同一文献库组织能力，让用户自主决定做什么及先后顺序。
2. 让人完成常用任务，让 Agent 能独立调用相同业务并处理更深入的问题。
3. 阅读与查询保持可预测；扩充和加工由明确意图启动，人工帮助始终可选。
4. 知识可回溯到材料和证据；如实呈现结果与限制，不用示例、进度或接收回执代替成功。
5. 延续设计内核与使用反馈，一次围绕具体使用场景迭代，阅读细节另行设计。
