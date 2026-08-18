# 受控 Browser 现场核实门

- 建立日期：2026-08-15
- 当前状态：门已建立；SpringerLink 已有 production route，四个脱敏文章样本已形成三个可解释 normal-miss 和一个机构网段 PDF 交付；其它账号/文章环境证据仍单独核实
- 当前 production Browser Profile：`1`（`springerlink`）
- 当前 production Browser rule：`1`（`springerlink-pdf@4`）
- 文档性质：真实 Provider 访问前的人工作业门；不是自动测试、运行指南或访问授权

本门只约束把一个已经完成离线证据包的 Publisher Browser route 带到真实 Provider 环境核实的
过程。它不批准任何 Provider、文章、账号、机构、profile 或网络访问，也不能用来把
`unsupported` 自动改成 `fixture-verified`/`production-ready`。Harness、CI、安装 wheel 验收和
普通开发运行始终离线。

## 1. 当前队列

| 类别 | 数量 | 当前结论 |
| --- | ---: | --- |
| production-ready Browser Profile | 1 | SpringerLink 的 route/rule/policy/安装对象图已闭环；不证明当前 session 或文章 entitlement |
| fixture-verified Browser Profile | 0 | 无待现场核实项 |
| 已审查且 Browser unsupported | 23 个矩阵 Profile 中除 SpringerLink 外的 22 项 Browser capability | 不是现场核实候选；先补官方政策、规则和离线证据 |
| API-only production Profile | CORE、Elsevier、Wiley | 只证明已列出的授权 API capability；Browser 仍 unsupported |
| 已完成且可公开提交的现场核实摘要 | 1 | 2026-08-18 SpringerLink 四样本均为非超时终态：三个 normal miss、一个机构网段 primary PDF 交付；同进程双样本证明 session reuse；不推导任意文章 entitlement |

原 P83 只建立门和模板，当时没有读取真实凭据、打开真实 Provider Browser 或请求论文。
后续 SpringerLink 已完成官方证据、规则、生产 adapter 和离线 Chromium 准入；用户特定环境的
登录/文章核实仍要复制
[单项核实单模板](profile-template.md)创建
`browser-live-verification/<access-key>.md`。每个 access key 必须使用自己的文件，不能用一张
通用授权覆盖多个 Provider。

当前唯一可公开的文章级摘要使用用户已授权的现有网段和 operator-managed profile。revision 3
先把旧的无界页面等待收敛为顶层 navigation-only、capture-first 和 entitlement-gated static
click；revision 4 又修复两处真实证据桥：带 `%2F` opaque DOI path 的 Provider AssetHint 只用于
提取精确 origin，不作为 Browser 导航目标；精确 SpringerLink 强证据与唯一 DOI 改由 rule-owned
模板构造官方 PDF locator，不再依赖 DOI resolver 回跳。

四个原始 SpringerLink 样本在 revision 4 下都形成 `actions=1` 和非超时终态，单个 Browser Source
耗时约 2.67–7.90 秒。三个样本返回可解释 normal miss；一个样本从初始 response 捕获并经主文
归属/PDF 验证后交付 3,588,396 bytes 的 primary PDF，未要求个人登录。一个同进程双样本批次中，
首个 session 以 reusable 释放，第二个记录 `session-reused=true`；文章开始相隔约 66.06 秒，超过
10 秒下限且始终同组串行。四个样本均未出现 login、paywall、MFA、challenge 或 action-required。
这些事实证明当前机器网段对其中一个明确样本可交付，并证明生产 session reuse；它们不证明
任意文章 entitlement、个人登录、机构协议范围或长期下载成功率。完整 URL、DOI、selector、
页面正文、响应正文、Cookie、profile 内容和 PDF 字节没有进入本目录。

## 2. 进入候选队列的必要条件

建立单项核实单之前，全部条件都必须满足：

- 对应 Provider Notes 有当前官方访问条款、自动访问/TDM 权利、Browser 适用性和核对日期；
- 已根据官方政策提出明确的 `browser_rate_limit_group`、`concurrency = 1`、文章启动间隔、
  window、完成/失败/限速 cooldown 和 circuit threshold；未知数字不能用统一默认值填充；
- 已有封闭的 `BrowserSiteRule`、rule revision、精确 landing/allowed/capture origins 和稳定文章
  identity，不执行任意 JavaScript、不猜 selector、不使用 wildcard generic fallback；
- 离线 fixture 已覆盖 authenticated/entitled、login-required、not-entitled/paywall、MFA/
  challenge/rate/IP/account warning，以及 primary/supplement/excluded/wrong-article；
- local HTTPS/Chromium 验收已证明 pre-navigation、redirect、popup、download、response、viewer、
  字节预算、PDF validation、publication 和清理边界；
- Profile 在验证矩阵中是 `fixture-verified` 或已有待核实环境证据缺口的
  `production-ready`，不是 `unsupported`；
- 拟使用的账号、机构订阅、网络和文章样本由 operator 自行确认有权使用；项目文档不作法律或
  entitlement 判断。

任何条件缺失时，先回到 Notes、rule/fixture 或离线测试，不能通过真实站点“边试边猜”补设计。

## 3. 另行授权必须精确到一张核实单

用户授权必须在执行前明确确认同一文件中的以下封闭范围：

- 一个 `access_key`、一个 Provider/Access Platform 和一个 evidence/rule revision；
- 由用户提供并确认可用的精确文章样本；样本标识和正文只保存在获准的仓库外运行目录；
- 最大文章数、文章流程数、顶层导航数、动作数、popup/download 数、总请求数、总字节和总时长；
- 生效时间窗和授权到期时间；过期后不能沿用；
- 精确 Browser policy、执行确认、生产受控无头 Browser/独立人工可见登录的选择，以及同组串行边界；
- operator-managed profile identity，以及 Catalog、ArtifactStore、temporary、report 和 log 的
  仓库外落点；核实单只写安全占位或位置类别，不写个人绝对路径；
- 是否允许人工登录；SciRetriever 不填写凭据、不选择机构、不处理 MFA/CAPTCHA；
- 允许的 landing/capture origins 与停止条件；
- 运行后保留或删除 profile、临时下载、Catalog、ArtifactStore 和原始日志的明确选择。

“测试一下 Browser”“使用我的现有配置”或一般性开发授权不满足本门。没有逐项预算、样本和落点
的授权视为未授权。

## 4. 执行边界

现场核实一次只执行一张核实单。即使产品设计允许不同 Provider risk group 并行，首次现场核实
也不并行多个 Provider，避免混淆账号风险、日志、限速反馈和归属证据。执行必须：

1. 在副作用前再次显示 access key、样本数、policy、预算、落点和停止条件；
2. 自动 route/probe 使用生产受控无头 Browser 和该 Provider 自己的 operator-managed profile；
   只有需要用户人工登录/机构/MFA 时才另行打开可见空白 Browser，自动流程不接管该操作；
3. 同一 risk group 严格 `concurrency = 1`，所有重试重新排队并服从 interval/window/cooldown；
4. Public/API 已正常耗尽且 Browser admission 明确允许后才执行文章流程；
5. 所有成功只交付 `TemporaryPdf`，继续经过实际 PDF 字节、reader、页面树、归属和不可变发布；
6. 正常/Debug 日志都只记录稳定 code、group/state/action 和匿名候选，不记录完整 URL、query、
   selector、页面正文、header、Cookie、token、profile 内容或 PDF 字节；
7. 不启用代理轮换、反检测、CAPTCHA 绕过、自动 MFA、任意脚本或未在 rule 中封闭的备用入口。

## 5. 强制停止条件

出现以下任一情况立即停止对应 Provider 核实，不自动换入口或提高重试频率：

- 用户取消、授权到期或任何预算达到上限；
- 官方政策、robots、产品/entitlement 或页面合同与核实单不一致；
- `429`、quota、`Retry-After`、rate-limited、IP blocked 或服务明确要求降低频率；
- CAPTCHA、MFA、challenge、账号警告、异常登录、机构选择不确定或会话身份不明确；
- landing/capture 跳到未批准 origin，DNS/TLS/binding/redirect 检查失败；
- 只得到 supplement、front matter、wrong article、HTML/XML、oversize 或无法验证的 PDF；
- timeout、runtime、cleanup、publication、Catalog/ArtifactStore 或数据完整性失败；
- 原始日志、异常或输出可能包含 secret、Cookie、签名 locator、个人路径或受限正文。

Provider 返回一次成功不允许扩大样本或预算。失败、无 entitlement 或不确定结果也不能通过另一
账号、另一 profile、另一网络或另一 Provider 核实单继续，除非用户重新给出精确授权。

## 6. 结果、脱敏与清理

现场原始材料只进入核实单批准的仓库外运行目录。执行结束后先停止 Browser/worker、关闭 page/
context/session、清理临时下载并核对没有残留进程，再按用户选择处理 profile、Catalog、ArtifactStore
和日志。不得擅自删除 operator 既有 profile 或用户文件。

可提交的结果只有脱敏后的维护事实：

- 日期、代码/evidence/rule revision、样本数量和预算使用量；
- 稳定 outcome/code、媒体类型类别、页面状态类别和 primary/supplement/wrong-article 结论；
- Provider policy/页面事实是否与 Notes 一致；
- 是否通过，或为什么是 failed/inconclusive；
- 下一次必须先完成的代码、fixture、文档或授权动作。

不得提交真实 DOI/PII、完整 URL、响应、HTML、PDF、截图、Cookie、token、账号、机构、个人路径、
profile、数据库或原始日志。若仅靠脱敏摘要无法审查，状态保持 `fixture-verified`/`unsupported`，
而不是提交敏感证据。

## 7. 现场通过不等于自动上线

单项核实通过后仍必须独立完成：

1. 更新对应 Provider Notes 的 evidence 日期和脱敏事实；
2. 根据现场结果确认或更新 evidence manifest、Profile/rule revision 与 production status；
3. 增加或更新离线 fixture、直接测试、对象图 identity 和安装 wheel acceptance；
4. 复跑 P79–P85 对应检查和 Full Harness；
5. 完成产品、架构、并发、Browser/secret 安全和数据完整性审查；
6. 由维护者明确批准 production-ready 变更。

未通过、授权撤回、证据过期或政策漂移时，不得把现场失败隐藏为成功；应区分
用户特定 session/entitlement 失败与 route 合同失效。只有后者需要把 Profile 退回
`fixture-verified`/`unsupported`；已验证的 Browser foundation 和独立 API-only Profile 不因此失效。
