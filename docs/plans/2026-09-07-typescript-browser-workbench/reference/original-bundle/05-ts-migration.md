# 05｜全量 TypeScript 迁移：模块、合同与兼容

## 1. 迁移原则

最终发布包不依赖 Python 解释器，不通过 Python 子进程执行数据库或 Agent。迁移期 Python 只用于离线 oracle、生成测试库和比较结果，运行在独立测试数据上。禁止新旧实现同时写用户 Catalog/Profile。

不是逐行翻译。对 domain/storage 的稳定语义做等价迁移；对 browser/runtime/policy 的已确认新需求重新设计；已发现的误拒等缺陷进入“有意行为变更清单”，不把旧错误结果当必须复制的 oracle。

不要在迁移中悄悄删除原有文献数据库维护功能。具体每个活动文件必须进入 M0 自动盘点；下表是模块级计划，不冒充完整文件清单。[R02](10-sources.md#r02)[R04](10-sources.md#r04)

## 2. 活动模块映射

目标默认位于 `apps/server/src/`，所有跨模块类型来自 `packages/contracts` 或领域模块公开接口。

| 当前模块 | 目标 | 必须保留/改造的功能 | 主要验收 |
|---|---|---|---|
| `model/` | `packages/contracts` + 领域模块 types | strict/frozen、名义ID、枚举、来源与版本、报告 | golden JSON、非法输入拒绝、业务不在 validator 中 |
| `literature/` | `literature/` | MetaLiterature/Literature、身份冲突、版本、引用support、状态与当前结果 | 同输入身份/关系/哈希一致；有意变化单独批准 |
| `storage/` | `storage/` + DB Worker | SQL repositories、不可变字节、锁、快照、发布与对账 | v1往返、崩溃恢复、不覆盖、不逃逸 |
| `network/` | `network/` + 拆出的 `browser/` | HTTP准入、凭据绑定、限速；浏览器过程迁出 | redirect/DNS/私网/大小/取消/错误脱敏 |
| `acquisition/` | `acquisition/` | public/API/browser路线、统一验收与primary-pdf | 全来源能力矩阵；相同发布门；候选不中途丢失 |
| `agents/` | `agents/` | 模型提供者中性接口、文本/图像/tool、三协议SSE | 协议fixtures、限额、取消、错误与usage |
| `metadata/` | `metadata/` | 来源搜索/lookup/引用、分页、Auto/Custom | 来源逐项测试；原始limit与结果limit不混淆 |
| `parsing/` | `parsing/` | MinerU客户端、上传授权、parser-neutral结果 | 协议fixture、资源路径、hash/current结果 |
| `analysis/` | `analysis/` | 元数据→正文两阶段、NoUsableContent、引用文本 | 输出schema、旧事实不被失败撤销 |
| `entry/` | `entry/` + `application/` | CLI、selectors、导入导出、完整服务编排 | 旧命令结果/退出码；新增serve/jobs独立测试 |
| `configuration/` | `configuration/` | 固定配置home、credentials、Models、Source选择 | 有界解析、版本迁移、secret不泄露、示例可用 |
| `logging/` | `logging/` | 安全日志、报告分离、进度事件 | stdout/stderr与稳定failure；无secret正文 |
| `bootstrap/` | `bootstrap/` | 单一组装入口、能力readiness、依赖所有权 | 真实安装后的对象图；无隐藏第二运行时 |
| `scripts/`、CI | TS/Node工具链、CI | Quick/Full、测试发现、包内容核对 | 不弱化旧质量目的，切换时更新规范 |
| `tests/` | Vitest/Playwright/fixtures | 保留所有有效验收语义 | 测试—功能映射，不能只计数量 |
| `archive/`、`docs/archive/` | 保留历史或经批准移出发行包 | 不恢复已撤销设计，不把历史代码算迁移缺失 | 新发行包不包含历史运行模块 |

Provider 盘点至少覆盖当前启用的 Metadata Auto 集合与所有可配置 adapter，而不是只实现 Crossref/arXiv 就称完整迁移。Acquisition 的 direct/landing hints、公开来源与现有授权 API 能力分别盘点；非默认 source 不在迁移中自动启用。[R16](10-sources.md#r16)

## 3. 合同与序列化：先于业务重写

Pydantic 的 `strict=True/extra=forbid/frozen` 不能用 TS interface 等价替代。外部输入统一经运行时 schema；内部 ID 用品牌类型防误传，但品牌不能替代值检查。错误输出不得附带secret或用户原文。[R18](10-sources.md#r18)[W08](10-sources.md#w08)

先导出以下 oracle：Model有效/无效输入、正常化结果、canonical JSON原字节、哈希、关系快照、查询排序、所有公开报告与配置解析。时间和UUID通过注入时钟/ID工厂固定，不在比较时粗暴删除所有变化字段。

高风险差异：

| 差异 | 迁移要求 |
|---|---|
| Python casefold 与 JS lowerCase | 身份字符串需要明确 Unicode case folding，不用 lowerCase 冒充；固定测试如 ß、组合字符、非BMP |
| 正则 `\w` / Unicode | 逐函数确认语义；PDF匹配和身份归一不能共享一个未经验证的替代式 |
| UTF-8字节与JS字符串长度 | 所有 byte budget 使用实际编码长度，不能使用UTF-16 code unit数 |
| Python sort_keys 与JS属性顺序 | 递归规范化并按旧算法产生相同原字节；不要只比较解析后的JSON |
| null / undefined / 默认值 | 旧hash字段的缺失与null明确；模型dump行为不能由undefined自动消失 |
| 数字 | SQLite int64按范围处理；超过安全整数用BigInt/明确字符串wire编码，不让JSON悄悄舍入 |
| 时间 | 保留旧RFC3339字符串与小数精度，不经Date转一遍截断微秒 |
| URL / DOI | 标准化、percent decode、IDNA、尾标点和arXiv版本沿用已验收规则 |
| Python迭代顺序 | 作者/关键词/引用保留ordinal；不能无意用Set或排序改变含义 |

当前 metadata/content 的 hash 基于指定 JSON 编码，必须先比较输出字节。不能为修复新实现的hash不一致而重算所有旧资产或旧元数据。[R12](10-sources.md#r12)

## 4. Agents、Provider 与 Parser

模型运行时保持三协议：`openai-responses`、`openai-chat-completions`、`anthropic-messages`。沿用用户选择的 `provider/model`、reasoning/image/stream配置；不能换SDK后静默改模型、丢reasoning或强制改stream。[R16](10-sources.md#r16)

先定义中性请求/结果，再选择官方SDK或受控协议适配实现。SDK默认重试、超时、重定向、模型名映射和fetch必须经过Network；关闭重复重试，避免“任务重试×SDK重试”放大访问量。SSE要处理跨chunk UTF-8、分段tool参数、流结束缺字段、取消、输出上限、usage缺失，不凭HTTP200判成功。

Metadata适配器逐项迁移endpoint、凭据、分页终止、逐Source原始扫描上限、lookup与引用支持。保留用户导入非空值优先、来源observation不可变、provider record ID与正式identifier的区别。

MinerU继续是operator-managed外部服务。全量TS只要求客户端与业务代码不依赖Python，不要求重写外部MinerU或把模型推理打包进产品。上传权限、remote origin绑定、资源包路径检查、Markdown输出和current ParserResult语义必须保留。[R02](10-sources.md#r02)[R16](10-sources.md#r16)

PDF基础检查器与MinerU全文解析不同：基础检查必须在不启动外部服务时可用；全文结构化结果继续使用既有解析合同，不用PDF.js文本提取冒充MinerU等价替换。

## 5. CLI、Web 与配置

旧命令树 `discover/complete/literature/import/export/config` 保留；新增 `serve/jobs/workspaces` 使用同一 Application Service，不复制业务逻辑。公开Python API无法在无Python最终包中原样保留，需明确退役说明及TS/API替代入口，而非假装兼容。[R16](10-sources.md#r16)

本地查询/导出继续不联网。CLI若连接已有daemon，必须确认catalog身份并认证；没有daemon时可用同一TS应用的单次模式，但写操作仍遵守同一catalog独占锁，不自动启动第二写入者。批量失败和进程失败的退出语义从实际旧CLI生成golden，再决定哪些新命令需要独立结果合同。

BibTeX/BibLaTeX、RIS、CSL-JSON都需往返测试，覆盖转义、Unicode、多人作者、机构作者、缺失字段、重复标识符与大输入。导出默认不覆盖、stdin/stdout与`--json`组合语义保留。

配置home继续 `~/.sciretriever/`；secret独立。M0以实际loader/schema导出为真，不按已过时的example构建新解析器。新加server/runtime/policy配置需严格schema；迁移命令支持只读预览、显式备份、原子写入和可恢复失败，不打印secret值。只迁移本计划冻结的受支持基线，不复活历次已撤销配置。[R13](10-sources.md#r13)[R14](10-sources.md#r14)

## 6. 迁移实施方法

每一能力切片依次完成：冻结公开输入输出与直接测试；实现TS；离线golden差分；故障与负例；真实依赖fixture；组装到唯一应用入口；文档/配置同步；完成清单后才退役旧实现。

稳定模块按等价迁移验收；新设计按明确的intentional-change ledger验收。每个旧文件记录 `port/redesign/retire-approved/historical-nonruntime` 与对应任务，没有“暂时留着反正还能跑”的永久Python后门。

不要求在整个项目迁完前对外发布混合架构。可以在独立开发入口同时保留旧Python和新TS测试目标；生产切换发生在M6，确保用户只见一个受支持运行时。

## 7. Rust 的使用边界

先做现有OS锁、descriptor-relative/no-follow文件访问和发布语义的Node能力spike。若纯Node无法在已支持平台保留所需保证，选择一个窄原生适配器或明确缩小支持平台；该选择进入ADR，不隐式放松安全合同。

可以局部使用Rust实现必要原语，但没有理由为此把整个SQLite或业务服务搬到Rust。原生模块由发布流水线预编译并随包分发，最终用户不安装Rust工具链。没有实测缺口时不增加Rust。
