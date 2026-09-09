# 01｜当前仓库审查与改造落点

基线与审查范围见 [总览](00-README.md)。下列“事实”来自已读取的代码或文档；“风险”是由实现推导的可能结果，不是已经完成真实站点复现。

## 1. 需要首先处理的发现

| 编号 | 当前证据 | 判断 | 执行动作 |
|---|---|---|---|
| A01 | `pyproject.toml` 固定 CloakBrowser 0.5.8、Playwright 1.55.0 | 当前依赖不能直接使用 1.59 才出现的 `page.screencast` | M0 验证并锁定新的 JS wrapper / Playwright / binary 组合；旧 CDP 路径只作有测试的适配器 |
| A02 | `_GenericCapturePolicy.prefetch()` 对 GET/POST 文档导航返回 true | 为 PDF 捕获建立的 fetch/fulfill 路径覆盖了普通文章导航 | 新浏览器默认 `continue()`；与旧路径做单变量实验，不把网站失败直接归因于 IP |
| A03 | `browser_control.py` 限定六动作，并禁止文字输入、登录、机构选择等 | 当前能力边界不满足通用浏览器工作助手 | 新增类型化通用动作；敏感操作由授权作用域控制，而不是一刀切禁止表单 |
| A04 | `pdf_identity.py` 在 DOI 判断前扫描前三页全文中的 supplement 词 | 正文提及补充材料也可能被拒绝 | 改为区分首页标题/元数据/正文/参考文献的证据模型；加入明确回归样本 |
| A05 | 同一文件把前三页所有 DOI 汇总成一个集合 | 可能混淆“文章自己的 DOI”和“引用的 DOI” | 保留 DOI 来源位置与证据等级；错误文件引用目标 DOI 不得通过 |
| A06 | Browser 的观察、settlement、capture、cleanup 主要落在 Network | 网络边界和浏览器交互职责重叠 | 抽出 Browser Runtime 与 Collector；Network 只保留网络事实与执行边界 |
| A07 | `schema.py` 的 v1 标记为固定值，DDL 拼接后计算 SHA-256；`engine.py` 验证完整对象集合 | 添加任务表或改变 DDL 格式都可能被旧实现拒绝 | 先逐字保留 v1 manifest，再实施显式 v2 迁移；不能直接改版本常量 |
| A08 | `literature/content.py` 使用有固定选项的 Python JSON 编码计算元数据/内容哈希 | TS `JSON.stringify()` 不自动等价 | 提取 golden byte fixtures，先比较字节，再比较哈希 |
| A09 | `example/config.example.toml` 仍含旧 `browser_controller="rules"` 与规则数量注释；ADR 0023 已要求删除这些字段 | 示例与已接受设计不一致 | 以活动配置解析器和边界测试核对；修正示例，并增加“示例可加载”安装测试 |
| A10 | 现有 README/ADR 把补全目标和报告定义为进程内对象 | 常驻服务的持久任务与恢复不能只包一层 HTTP | 新增运行事实合同，明确不同于文献业务事实；修订相关 ADR |
| A11 | CloakBrowser adapter 使用 engine thread、Linux `unshare(CLONE_FS)`、独立 umask、固定 binary/persona | 不能假定逐句翻译后即支持 Mac/Windows | 做平台能力矩阵；TS child process 隔离环境，单独处理显示与文件安全 |
| A12 | `browser_connect.py` 的 CONNECT 是不解密 TLS 的字节隧道 | 它与 `route.fetch()` 不是同一问题 | 保留网络准入价值；不得把删除 CONNECT 当作默认“恢复原生”的步骤 |

代码依据：[R05](10-sources.md#r05)[R06](10-sources.md#r06)[R07](10-sources.md#r07)[R08](10-sources.md#r08)[R09](10-sources.md#r09)[R10](10-sources.md#r10)[R11](10-sources.md#r11)[R12](10-sources.md#r12)[R13](10-sources.md#r13)[R14](10-sources.md#r14)[R15](10-sources.md#r15)。API 版本依据：[W02](10-sources.md#w02)。

## 2. 保留、替换、删除、新增

### 保留语义，迁移实现

保留 `MetaLiterature / Literature` 身份、来源 observations、作者和版本关系、引用与 support、单一 current metadata/content、唯一 `primary-pdf`、provenance 和输入哈希。保留源选择的 Auto/Custom 意义，保留无权限/网络失败/不存在之间的区别。保留用户原始文件不被移动、删除或原地覆盖的原则。[R02](10-sources.md#r02)[R04](10-sources.md#r04)[R16](10-sources.md#r16)

保留 SQLite 与 ArtifactStore 的职责分离、短事务、先持久化字节再建立引用、只回收无引用对象、只读查询不联网。公开 API / CLI 的现有输出不是实现细节，必须有兼容或明确版本化说明。[R16](10-sources.md#r16)[R17](10-sources.md#r17)

### 替换职责，不逐文件翻译

- `network/cloakbrowser.py`、`network/playwright.py`、`network/browser*.py`：拆成浏览器启动/会话、观察与执行、网络守卫、下载接收四类责任。
- `acquisition/browser_control.py`：保留 Acquisition 对目标和策略的所有权；不再拥有六动作限制和隐藏候选进度的合同。
- `acquisition/pdf_identity.py`：从 bool 判定改为带证据的三态身份判断；可从逻辑推导的误拒不能作为迁移一致性目标。
- `entry/`：改为 CLI 和 HTTP 共用应用服务；长任务生命周期不绑定 HTTP 请求。
- `storage/locking.py`：面向单一长驻 writer 重新设计锁生命周期，但不能用进程内 mutex 冒充跨进程排他。

### 删除，且记录删除依据

删除 Publisher-specific 点击规则的残余文档/配置；不恢复旧规则体系。删除全导航 prefetch 默认路径、Python 到 TS 的永久 RPC 桥、双浏览器直接控制者、重复的截图/稳定状态机。最终删除活动 Python 源码、生产 Python 启动器和 Python 构建依赖；归档历史可保留在 Git 历史或明确非活动目录，不参与包发布。

### 新增

新增工作台、控制权租约、分离的帧/事件通道、策略快照、任务/尝试记录、候选文件交接凭据、恢复协调、v2 schema 迁移、分平台打包和真实浏览器 fixture。

## 3. 当前实际业务范围：迁移时不能漏掉

| 模块 | 迁移必须覆盖的行为 |
|---|---|
| Entry | discover topic/citations、complete pdf/content、查询详情/引用、导入导出、配置、报告、退出码；其它已公开 API 由 M0 清单确认 |
| Metadata | 按能力注册 Provider、领域检索、稳定 ID lookup、引用输入、限额、无副作用的来源转换 |
| Literature | 身份归一、冲突、版本归并、元数据优先级、状态推导、引用 support、全文搜索与内容接纳 |
| Acquisition | Public/API/Browser 路由、显式 source 顺序、手动 PDF、候选验证、原子资产发布、耗尽语义 |
| Parsing | 外部 MinerU 的请求/轮询/结果包验证、parser-neutral Markdown 和资源关系 |
| Analysis | 两阶段 metadata/content 分析、结构化结果验收、Markdown 渲染、引用文本与输入 lineage |
| Agents | 三种模型协议、SSE/非流式边界、文本/图像/tool/schema、限额、错误与取消 |
| Infrastructure | Model、Configuration、Bootstrap、Network、Storage、Logging、构建和 CI |

这些边界来自活动文档映射与当前 README，不把 `archive/`、`docs/archive/` 中的旧架构当成迁移对象。[R04](10-sources.md#r04)[R16](10-sources.md#r16)

## 4. M0 必须生成的完整清单

本次审查没有声称完成所有源文件的逐行分析。实现开始前应从冻结 commit 自动生成 `migration/inventory.json`，覆盖：

```text
src/sciretriever/**/*.py
所有公开 api.py / __all__ / CLI leaves
tests/**/*.py 与每个 test_* 用例
scripts/、CI、打包元数据、配置示例
所有当前注册的 Metadata/Acquisition/Model/Parser adapter
```

每个条目记录 `currentPath / publicSymbols / consumers / tests / targetPath / disposition / taskId / evidence`。`disposition` 只能是 `port`、`redesign`、`retire-approved`、`historical-nonruntime`。每个活动文件必须有去向，每个旧验收用例必须有新验收映射或明确变更理由。

这个清单用于防遗漏，不要求新目录与旧文件一一对应。不能以 Python 文件数量减少或测试总数相等证明完成。

## 5. 未验证与不能直接推断的事项

没有在用户出口进行出版社测试，无法判断 Cloudflare/403 的主要成因。没有运行旧 Harness，也没有证明新 Playwright 与 CloakBrowser 的兼容性。没有测量所有目标平台文件 API、PDF.js 文本提取差异、SQLite native module 安装表现。计划中均有对应 spike 与退出条件，不能把这些未知事项埋到最后一次发布里。
