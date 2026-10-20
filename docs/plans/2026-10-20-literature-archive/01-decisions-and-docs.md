# 01 决策与文档同步

状态：Completed（2026-10-20）。执行者：文档执行者；GA 由 Owner 确认。

**Outcome**：

1. ADR 0037《文献建档、校订稿与算子输入》已经 Accepted：整体取代 ADR 0008 与 0010，修订 ADR 0002、0003、0007、0026、0034 中相冲突的条款。
2. 技术文档改为描述新的目标形态，并标明尚未实现。
3. 提案移入归档。
4. 代码执行者可以只依据 ADR 和技术文档开工，不需要回头翻讨论记录。

**进入条件**：
- 提案第 2 节的规则与第 9 节的答复已经确定；
- 本计划已经创建。

**责任边界**：
- 本块负责：`docs/architecture/decisions/`、`docs/architecture/technical/`、`docs/architecture/design.md`、`docs/architecture/requirements.md` 中受影响的段落，以及提案的归档。
- 本块不负责：任何代码与测试。

## Tasks

- [x] **1.1 起草 ADR 0037**（状态 Proposed）

  2026-10-20 完成：`docs/architecture/decisions/0037-literature-archive-and-proofread-text.md`。起草时核对发现两处补充：一是 ADR 0002 的严格后备匹配依赖 `document_type`，一并修订，并在 07 中增加任务 7.9；二是 ADR 0008 §6“关键词不建标签”与标签词表冲突，因此 0037 改为整体取代 0008 和 0010，不再只做修订。

  内容依次包括：

  - **背景**：
    - 算子显得像脚本的原因；
    - 解析结果不可信的证据摘要（引用提案 1.2，不复制完整表格）。
  - **术语**：

    | 术语 | 含义 |
    | --- | --- |
    | 建档 | 文献进入就绪状态前必须完成的流程 |
    | 文献档案 | 建档的产物 |
    | 部分 | 正文或补充材料 |
    | 原始解析 | 某个部分在某种 backend 下的解析结果 |
    | 校订稿 | 由两份原始解析校订得到的文本 |
    | 结构 | 章节角色与图表清单 |
    | 内容版本 | 由校订稿与结构决定的版本 |
    | 描述版本 | 由元数据与标签决定的版本 |
    | 快照 | 冻结的一组文献及其版本 |
    | 主标签 | 排在第一位的标签 |
    | 就绪 | 文献可以进入算子的状态 |
  - **决定**：
    - 提案第 2 节的 13 条规则；
    - 元数据拆分：出版形式与文章性质；
    - 标签规则摘要：
      - 粒度为领域级；
      - 总数有上限，初值 6；
      - 标签按重要性排序；
      - 不设维度；
      - 主要化合物必须在题名或摘要中出现；
      - 回溯手动执行；
      - 整理全自动执行，并且可以撤销；
    - 原始解析的保留范围：区块列表 v2、Markdown、实际引用的图片；
    - 现有文献从已有的 VLM Markdown 开始重新建档。
  - **对旧 ADR 的修订**：

    | ADR | 修订的条款 |
    | --- | --- |
    | 0003 | MinerU 适配增加 pipeline profile；服务仍由运维方管理 |
    | 0007 | 参考文献从校订稿解析；新增支持类型 `ArchiveReferenceTextSupport`（见 06 的 6.8）；`ContentReferenceTextSupport` 随 `LiteratureContent` 退役 |
    | 0008 / 0026 | 总结不再承担校订、确定元数据和打标签的职责，改为单篇算子；元数据在建档中确定；`LiteratureContent` 由 12 退役 |
    | 0010 | 每个部分保存两份原始解析，允许保留区块和坐标，并合并成校订稿；取代“单一当前 ParserResult”和“私有输出一律清理”两条 |
    | 0026 | 新增页码区域定位方案；文档按部分组织 |
    | 0034 | 算子只能读取校订稿；单篇算子之间不互相依赖；多篇算子先逐篇读取再汇总；集合结果改为“标记过时，由人决定是否重算”；引入区块级仲裁 |
  - **未采用的方案**：提案附录中的四种方案。
  - **后果**：
    - GPU 时间增加；
    - schema 变更；
    - CLI 参数变更（`--document-type`）；
    - 旧结果不兼容。

  输出文件：`docs/architecture/decisions/0037-literature-archive-and-proofread-text.md`。
- [x] **1.2 同步受影响的 ADR 头部与索引**

  2026-10-20 完成：0002、0003、0007、0026、0034 加注“拟修订（Proposed）”，0008、0010 加注“拟被取代（Proposed）”，ADR 索引新增 0037。
  - 在 0003、0007、0008、0010、0026、0034 的头部加上 `Amended by: ADR 0037`，并在正文顶部加一行修订说明。旧条文保留原文。
  - 更新 ADR 索引 README（`docs/architecture/decisions/README.md`）的列表与表格。

  验收：所有链接都能打开；每个被修订的 ADR 都能找到指向 0037 的说明。
- [x] **1.3 修订技术文档**

  2026-10-20 完成：03 §8、04 §6、05 §7、07 §6 新增目标形态章节，相关冲突小节加注。

  | 文档 | 修订内容 |
  | --- | --- |
  | `technical/03-literature-materials.md` | 元数据字段（出版形式、文章性质、字段来源与锁定）；文献状态改为建档中、建档失败、就绪 |
  | `technical/04-document-evidence.md` | 原始解析；校订稿表示 `proofread-blocks-v1`；页码区域定位 `page-region-v1`；部分；结构角色 |
  | `technical/05-knowledge-processing.md` | 读取声明、复用键、四种结果状态、快照、多篇算子、过时标记、总结算子、标签与词表 |
  | `technical/07-versioned-storage.md` | 新增的表与不可变产物；引用保护 |

  每处修订都标明“目标形态，实施见计划 2026-10-20-literature-archive”，不写成已经实现。
- [x] **1.4 修订 design 与 requirements 中受影响的段落**

  2026-10-20 完成：`requirements.md` 的兼容格式条目、`knowledge-service-workflows.md` 的 ADR 对照均已加注；`design.md` 中没有冲突语句。

  只修改与“总结即内容就绪”“单一解析结果”“文献类型”冲突的句子，不重写整篇文档。
- [x] **1.5 GA：提交 Owner 确认**

  2026-10-20：Owner 确认，ADR 0037 改为 Accepted。

  提交以下材料：
  - ADR 0037 草稿；
  - 被修订条款的对照表；
  - 本计划。

  Owner 确认后：
  - ADR 0037 的状态改为 Accepted；
  - 本计划根 README 的 GA 一栏记录确认日期。
- [x] **1.6 归档提案与被取代的 ADR**

  2026-10-20 完成：0008、0010 已改为 Superseded 并移入 `docs/archive/decisions/`；`.gitignore` 白名单已更新；被修订 ADR 头部的说明已改为正式修订。

  GA 之后执行：
  - 把 ADR 0008、0010 的状态改为 `Superseded by ADR 0037`，移入 `docs/archive/decisions/`，并更新所有链接；
  - 在 `.gitignore` 的 `docs/archive/decisions/` 白名单中加入这两个文件（`docs/archive/*` 默认被忽略）；
  - 把 0002、0003、0007、0026、0034 头部的“Proposed”字样改为正式修订说明。

- [x] **1.6a 归档提案**

  2026-10-20 完成：提案移入 `docs/archive/2026-10-20-literature-archive-proposal/`，各索引与链接已同步。

  GA 之后执行：
  - 把提案目录移到 `docs/archive/2026-10-20-literature-archive-proposal/`；
  - 更新 `docs/proposals/README.md` 与本计划中的链接。

- [x] **1.7 清理已被取代的 ADR**（Owner 2026-10-20 要求）

  2026-10-20 完成：
  - 已被取代的 ADR 0005、0006、0009、0020 移入 `docs/archive/decisions/`，并新增该目录的 README；
  - 修正全部入站链接，ADR 索引新增“已归档的 ADR”一节；
  - 修正 ADR 索引中 0036 条目的过时文字。
  - 在 `.gitignore` 中为 `docs/archive/decisions/` 增加精确文件白名单，否则归档文件不会进入仓库。

  Owner 2026-10-20 要求“过时的全部归档，不合现在架构的都要改”，追加完成：
  - ADR 0024（TypeScript 迁移边界）已归档，由 ADR 0025 承接；
  - 按 ADR 0037 修订正文：0001、0002、0003、0007、0011、0013、0019、0026、0028、0032、0034；
  - 按现行 ADR 0023/0031 收口正文：0017（运行时与 Browser 预算）、0019（PydanticAI 选型、Python controller、`CONTENT_READY` 目标）；
  - 清除 Python 时期的措辞：0012、0016、0021、0023；
  - 同步 `principles.md` 与 `07-versioned-storage.md` 中的旧模型表述。

## 集成与影响

- 只修改文档，不影响运行行为。
- 修订后，技术文档描述的是目标形态，与代码之间会暂时不一致。每处都要标明“实施中”。

## 验证

- 检查链接，包括相对路径和锚点；
- 检查术语，确保与提案一致；
- 仓库的 `pnpm format:check` 不覆盖 `docs/`，文档以链接、术语和 diff 检查为准；
- 检查 diff，只改动本块范围内的文件。

## 退出条件

- GA 已确认；
- ADR 0037 为 Accepted；
- 技术文档已修订；
- 提案已归档。

## 恢复与交接

- GA 被拒绝或要求修改时，回到 1.1。此时 03–12 不得开工。
- 交给 03–12：ADR 0037 中的术语与规则编号。各块引用规则时使用 ADR 中的编号。

[计划入口](README.md)
