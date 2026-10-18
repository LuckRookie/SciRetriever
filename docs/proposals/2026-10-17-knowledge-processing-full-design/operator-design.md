# 算子抽象：完整版设计

> 状态：参考设计，首版不实施。本文记录 2026-10-17 至 2026-10-18 讨论中形成的算子抽象，作为[完整版设计](README.md)的一部分。

## 1. 目标

系统不理解方法内部做什么，也能自动完成增量、复用、并行、重试、溯源和权限控制。依靠三点：

1. **形状决定执行规律**：形状封闭，由系统拥有，决定方法能拿到什么、交出什么，以及系统怎样调度和更新。
2. **上下文是方法读取外界的唯一窗口**：依赖登记、可见范围限制和证据检查由运行时统一完成。
3. **多数方法是数据而非代码**：通用的提问、分类、提取、综合方法由模板与 schema 定义。

三层划分：

| 层次 | 负责什么 | 是否封闭 |
| --- | --- | --- |
| 算子形状 | 输入输出基数、可见范围、增量规则、重试粒度、状态语义 | 封闭 |
| 处理方法 | 一次处理具体怎么做 | 开放 |
| 配方 | 为完成任务怎样组合形状与方法 | 开放 |

判别两个操作是否属于不同形状，只看增量规则、调度方式和状态语义是否不同。打标签与写摘要属于同一形状；单位换算是某形状下的程序方法。

## 2. 方法

```ts
interface Method<In, Out, P> {
  id: string; version: string            // 版本变化则旧结果不可直接复用
  kind: "program" | "llm" | "agent" | "external"
  input: TypeName<In>; output: TypeName<Out>
  params: Schema<P>                      // 所有影响结果的参数
  modelRole?: "analysis" | "extraction"  // 声明模型角色，绑定由配置决定
  run(input: In, params: P, ctx: MethodContext): Promise<Outcome<Out>>
}
```

| kind | 说明 | 例子 |
| --- | --- | --- |
| program | 普通 TypeScript 函数，结果确定 | 单位换算、分组统计、MinerU 输出转换 |
| llm | 数据定义：提示词模板、输出 schema、读取策略、证据要求 | 提问、分类、记录提取、综合 |
| agent | DSH 受控会话，只能使用 `ctx` 工具 | 文档复查修复、复杂阅读 |
| external | 外部 Agent 或程序执行，通过提交接口交回 | 现有提取交付的外部生产者 |

`llm` 方法示例：

```yaml
method: extract-records@1
kind: llm
input: Document
output: Record[]
read:
  locate: by_field_hints
  prefer: [table, caption, si]
  max_units: 40
prompt: templates/extract-records.v1.md
output_schema: from_spec
evidence: required_per_field
checks: [value_in_cited_unit, unit_parsable, range_sane]
```

## 3. 上下文

```ts
interface MethodContext {
  read: {
    units(doc: DocRef, q?: UnitQuery): Promise<Unit[]>
    unitContext(u: UnitRef): Promise<UnitContext>           // 单元格 + 表头 + 脚注 + 所在段落
    search(doc: DocRef, query: string): Promise<UnitHit[]>
    pageImage(doc: DocRef, page: number, region?: Box): Promise<Image>
    shared<T>(name: string): Promise<T>                     // 仅限步骤声明的共享输入
  }
  model: { json; text; agent }                               // 经 DSH，自动记录成本与 provenance
  cite(u: UnitRef, quote?: string): EvidenceRef
  signal: AbortSignal
}
```

运行时强制：

1. 逐项类形状下的方法只能读本条目及声明的共享输入，越界读取被拒绝。
2. 每次读取自动登记为依赖，精确到 Unit 版本。
3. 输出证据只能引用已读取的 Unit。
4. 方法无法直接访问存储、网络、凭据或 Browser。

## 4. 结果状态与形状

```ts
type Outcome<T> =
  | { status: "ok"; value: T; evidence: EvidenceRef[] }
  | { status: "empty"; searched: MaterialScope }
  | { status: "undecidable"; reason: string }
  | { status: "failed"; error: string; retryable: boolean }
```

| 形状 | `run` 的输入 | 输出 | 允许的状态 | 工作单位 | 输入变化时 |
| --- | --- | --- | --- | --- | --- |
| map 逐项变换 | 一个条目 | 一个值 | ok、failed | 每个条目 | 只重算依赖变化的条目 |
| filter 逐项筛选 | 一个条目 | 是或否及理由 | ok、undecidable、failed | 每个条目 | 同上 |
| expand 逐项展开 | 一个条目 | 0..N 条记录及局部键 | ok、empty、failed | 每个条目 | 同上，并匹配新旧记录 |
| group 按组处理 | 键与成员 | 一个值 | ok、failed | 每个组 | 只重算成员变化的组 |
| whole 整集合成 | 整个集合 | 一个值 | ok、failed | 整体 | 标为待更新，由用户显式重跑 |

group 的分组键由程序计算；需要语义分组时，先用 map 打标签，再按标签分组。成对处理（用于比较与矛盾核查）作为第二阶段形状：新增条目只与已有条目按分块配对。

## 5. 步骤与配方

```ts
interface Step {
  name: string
  shape: "map" | "filter" | "expand" | "group" | "whole"
  method: `${string}@${string}`
  params: object
  input: StepRef | AssetRef | ScopeRef
  groupBy?: FieldPath
  shared?: Record<string, AssetRef>
  update?: "auto" | "stale"
}
```

工作项复用键：方法 id@版本 + params 哈希 + 输入条目版本 + 实际读取的依赖集合。复用前核对依赖仍为当时版本。

```yaml
recipe: air-stability@1
steps:
  - {name: papers,  shape: filter, method: judge@1,
     input: scope:air-stability-sulfide,
     params: {question: "是否做了空气/湿度暴露实验并报告了性能变化？", read: abstract_then_fulltext}}
  - {name: records, shape: expand, method: extract-records@1, input: papers,
     params: {spec: air_stability_v1}}
  - {name: normed,  shape: map,    method: normalize-quantities@1, input: records}
  - {name: stats,   shape: group,  method: summary-stats@1, input: normed,
     groupBy: fields.method, params: {metric: retention}}
  - {name: review,  shape: whole,  method: synthesize@1, input: stats,
     params: {question: "各改性方法的效果与适用条件"}, update: stale}
```

同一抽象可用于文档内部：`expand(文档 → 章节块) → map(逐块分析) → group(按文档整合)`，修复一节只重算该节。

## 6. 现有代码映射

| 现有代码 | 位置 | 做法 |
| --- | --- | --- |
| `parsing/service.ts` | 材料区 map：PDF → 原始解析包 | program 方法，仅在材料任务中运行 |
| `document/builder.ts` | 材料区 map：原始解析 → DocumentVersion | 结构化重写 |
| `parsing/article-identity.ts` | 材料区 filter | 判断逻辑成为方法，结论仍由 Literature owner 发布 |
| `analysis/knowledge.ts` | 结果区 map + llm 方法 | 保留提示词与 schema，拆为概览、详细、问题三个方法 |
| `analysis/knowledge-long.ts` | 首版为一个 map 方法 | 后续可拆为 expand → map → group |
| `analysis/synthesis.ts` | 结果区 whole | 综合逻辑成为方法 |
| `analysis/synthesis-prepare.ts`、`extraction/prepare.ts` | 由运行时吸收 | 即输入冻结与 `ctx.read` |
| `extraction/delivery.ts` | external 方法 | 外部提交经同一输出检查后发布 |
| `retrieval/knowledge-index.ts` | 非算子 | 资产发布时同步更新的派生索引 |
| `application/jobs/` | 运行时执行后端 | Run、Attempt 映射到现有任务系统 |
| `storage/knowledge.ts`、`storage/synthesis.ts` | 旧产物只读 | 适配为条目供新配方消费 |
| 发现、获取、Browser | 不做成算子 | 读取外部世界，没有可登记的依赖与复用语义，继续作为任务 |

## 7. 完成形态与代价

完成后系统包含：材料区（PDF、原始解析、带 Unit 与坐标的文档版本、质量报告、复查修复 Agent）、结果区（集合、记录表、汇总表、论断文档及其版本、修订与依赖图）、运行时（形状执行器、方法注册、`ctx`、复用判断、恢复与成本）、配方与模板、约 20 个 CLI/MCP 工具，以及 Web 的结果列、任务页、版本对比、溯源面板和修订影响提示。

相对精简版多出的能力：按 Unit 重算、按组增量、人工修订的下游影响、规范加字段时只补抽并展示记录对应、可保存与由 Agent 编写的配方、历史版本对比、对 Agent 编写代码的隔离。

代价：工期约 6 个月以上；开发者需掌握形状、方法、配方、资产、版本、依赖六个概念；新处理须适配形状；依赖图增加排查难度；版本与依赖记录使存储持续增长；在缺少三个以上真实应用时有抽象失准的风险。

[完整版设计](README.md)
