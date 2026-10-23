# SciRetriever 文档导航

类型：导航与文档规则。负责：文档体系、主题归属表、文档维护规则。状态：现行（2026-10-23 起）。

SciRetriever 面向科研 Agent 供应文献材料、知识压缩与通用提取交付，也提供人类配置、生产浏览器协作和阅读。查询已有数据库与主动扩充/加工是独立操作；缺口不自动启动搜索或下载。

## 文档类型

每类问题只有一个归属文档。其它文档需要提到时，只写一句并链接过去，不复述内容。

| 类型        | 回答什么                       | 位置                                                                                                                         | 怎么写                                                                               |
| ----------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 需求        | 用户要什么、为什么、怎样算做到 | [requirements](architecture/requirements.md)                                                                                 | 写现状；只改结论，不留修订日志                                                       |
| 决策（ADR） | 一个长期选择、理由与后果       | [ADR 索引](architecture/decisions/README.md)                                                                                 | 一事一篇；接受后正文冻结，只有状态行可改；改主意写新 ADR，旧 ADR 标为被取代          |
| 规格        | 系统应该是什么样               | 后端：[design](architecture/design.md)、[technical](architecture/technical.md)；前端：[Web 设计](architecture/web/README.md) | 原地修改，只写现在；不写“某日补充”段落                                               |
| 指南        | 现在能怎么用                   | [README](../README.md)、[用户指南](guides/README.md)                                                                         | 只写已经实现、可以复现的行为                                                         |
| 计划        | 怎么从现状做到目标             | [活动计划](plans/README.md)                                                                                                  | 只写任务、门槛、证据与恢复；规格改动写成“改某文档某节”，不在计划里写规格；完成后归档 |
| 提案        | 尚未决定的方案                 | [活动提案](proposals/README.md)                                                                                              | 决定后结论进入 ADR 或规格，提案归档                                                  |
| 外部事实    | 供应商、依赖、许可等外部资料   | [notes](notes/README.md)                                                                                                     | 注明日期与来源                                                                       |
| 开发        | 工程入口与验证                 | [开发文档](development/README.md)、[HARNESS](../HARNESS.md)                                                                  | 写现行命令                                                                           |
| 代码导航    | 代码在哪、模块职责             | 各目录 `README.md`；`src/` 内自包含                                                                                          | 不链接源码树外                                                                       |
| 历史        | 过去怎样讨论、实现             | [历史归档](archive/README.md)、Git 历史                                                                                      | 不作为现行依据                                                                       |

本机测试材料与报告放在 Git 忽略的 `sandbox/`，共享合成材料放在 `tests/`，见[测试目录说明](../tests/README.md)。

## 主题归属表

常被多处提到的主题，归属如下。表中没有的主题，按上一节的类型判断；拿不准时先补进本表再写。

| 主题                                         | 唯一归属                                                                                                                                                                                                              | 其它文档只链接                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 产品范围、R1–R13 验收                        | [requirements](architecture/requirements.md)                                                                                                                                                                          | design、ADR、PRODUCT.md          |
| 八个模块的责任与数据所有权                   | [design](architecture/design.md)                                                                                                                                                                                      | technical、ADR                   |
| 模块实现、接口、持久化                       | [technical/](architecture/technical.md) 对应模块篇                                                                                                                                                                    | design、源码 README              |
| Web 的定位与设计依据                         | [ADR 0038](architecture/decisions/0038-web-design-basis.md)                                                                                                                                                           | design、technical/01、PRODUCT.md |
| Web 视觉规则（字体、字号、颜色、间距、组件） | [设计内核](architecture/web/design-core.md)                                                                                                                                                                           | 指南、PRODUCT.md、计划           |
| Web 信息架构与各页面排布                     | [页面规格](architecture/web/page-specs.md)                                                                                                                                                                            | design、technical/01、指南、计划 |
| Web 当前可用功能与操作                       | [Web 指南](guides/web-workbench.md)                                                                                                                                                                                   | README                           |
| Web 前端技术栈                               | [ADR 0036](architecture/decisions/0036-react-web-frontend.md)、[technical/01 第 4 节](architecture/technical/01-product-interface.md#4-人类工作台与知识阅读)                                                          | apps/web/README                  |
| 建档、校订稿与算子输入                       | [ADR 0037](architecture/decisions/0037-literature-archive-and-proofread-text.md) 与 [technical/04](architecture/technical/04-document-evidence.md)、[technical/05](architecture/technical/05-knowledge-processing.md) | 指南                             |
| 配置项与默认值                               | [配置手册](guides/configuration.md)                                                                                                                                                                                   | 其它指南                         |
| 测试层级、并发与 Full                        | [HARNESS](../HARNESS.md)                                                                                                                                                                                              | 计划、AGENTS                     |
| 代码变更要同步哪些文档                       | [文档影响映射](development/documentation-map.md)                                                                                                                                                                      | —                                |

## 维护规则

1. **先查后写。** 写之前按上表找到归属文档，只改那一份；别处需要时写一句并链接。
2. **只写现在。** 规格、指南和需求描述当前结论，不保留“某日确认”“某日补充”的段落；为什么改、何时改由 ADR、计划和 Git 历史记录。
3. **ADR 不当规格用。** ADR 接受后正文冻结；细节写进规格。方向变化就写新 ADR，并把旧 ADR 的状态行改为“被 ADR NNNN 取代”（可以是部分取代，注明哪几节）。
4. **退役就移走。** 内容被取代时直接改掉或删除，不在原处加“已退役”注；整份文档被取代时移出现行目录（归档或删除），指向它的链接同一次改完。
5. **计划不写规格。** 计划里的“规格改动”指向规格文档的具体章节；规格先改（可标为草案），计划只记录任务与验收。
6. **开头三行。** 现行文档开头写明：类型、负责的主题、状态。
7. **区分目标与现状。** 规格写应当实现什么，指南写已经实现什么；不用当前实现否定已接受设计，也不把未实现的能力写成已发布。

既有文档尚未全部符合以上规则，整理工作见[文档体系整理计划](plans/2026-10-23-docs-consolidation/README.md)。

## 子目录导航

- [architecture/](architecture/README.md)：需求、决策与规格。
- [guides/](guides/README.md)：用户指南。
- [plans/](plans/README.md)：活动计划。
- [proposals/](proposals/README.md)：活动提案。
- [notes/](notes/README.md)：外部事实。
- [development/](development/README.md)：开发与验证。
- [archive/](archive/README.md)：历史归档。
