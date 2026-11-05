# ADR 0043：配置齐全的元数据来源默认启用

类型：决策（ADR）
负责：Metadata Auto 的选源
状态：Accepted（2026-10-28，Owner 授权 Claude 完成计划 17 的全部决定：“给你完成计划17的所有权限”）

- Date: 2026-10-28
- 依据：Owner 2026-10-27 在计划 17 P15 中提出：“自动模式应把所有能用的来源都用上”。
- 部分取代：[ADR 0022](0022-default-safe-source-selection-and-per-source-limits.md) 第 2 节中“Metadata Auto 是版本固定集合、Key 只改善已启用 Source、不改变集合”的部分；[ADR 0039](0039-configured-acquisition-auto-and-traces.md) 依据行中“Metadata Auto 不变”一句。
- Related: [计划 17](../../archive/2026-10-27-web-usage-review/README.md) P13–P16 与 [02 块](../../archive/2026-10-27-web-usage-review/02-sources-and-acquisition.md)

## 背景

ADR 0039、0040 之后，PDF 的 Auto 已经纳入配置齐全的出版社和通用 API，以及 Sci-Hub。元数据的 Auto 仍是 ADR 0022 定下的固定集合。

Elsevier、Springer Nature、Web of Science 这三家需要凭据，即使用户已经配好，Auto 也不会用它们。设置页的来源目录要按用途列出每个来源是否在用；这时就会出现“已配置却不在用”，与 Owner 的期望相反。

## 决定

1. Metadata Auto 由两部分组成：
   - ADR 0022 的公开集合；
   - 必需凭据与普通参数都已配置齐全的来源：Elsevier、Springer Nature，以及产品与数据库都已配置的 Web of Science。
2. 与 ADR 0039 相同：
   - 选择只看本地是否配置齐全，不读取凭据值，不联网测试权限；
   - 配置不齐的来源不加入，也不报错；
   - Application 冻结当前生效的选择。
3. 每个来源的主题检索、补全书目、引用关系三种用途，跟随同一份 Metadata 选择一起开关；PDF 选择另成一份。来源不提供的用途，不因为加入 Auto 而出现。Web of Science 的引用能力仍按所配产品决定。
4. 以下保持不变：
   - Custom 仍是精确列表；
   - 逐来源扫描上限；
   - ADR 0014 第 2.1 节的引用发现优先级与失败隔离；
   - 主题检索的共同查询行为。

## 后果

- 配好凭据的商业元数据来源会参加主题检索、补全与引用，一次主题检索的请求数随之增加。
- 设置页“自动”的含义，在元数据与 PDF 两边一致。
- 实现与指南的修改见计划 17 的 02 块。

[ADR 索引](README.md)
