# 受控 Browser 现场核实门

- 建立日期：2026-08-15
- 当前状态：门已建立；没有获准执行的 Provider 核实单
- 当前拟 production Browser Profile：`0`
- 当前 production Browser rule：`0`
- 文档性质：真实 Provider 访问前的人工作业门；不是自动测试、运行指南或访问授权

本门只约束把一个已经完成离线证据包的 Publisher Browser route 带到真实 Provider 环境核实的
过程。它不批准任何 Provider、文章、账号、机构、profile 或网络访问，也不能用来把
`unsupported` 自动改成 `fixture-verified`/`production-ready`。Harness、CI、安装 wheel 验收和
普通开发运行始终离线。

## 1. 当前队列

| 类别 | 数量 | 当前结论 |
| --- | ---: | --- |
| production-ready Browser Profile | 0 | 无真实 Browser 流量 |
| fixture-verified Browser Profile | 0 | 无待现场核实项 |
| 已审查且 Browser unsupported | 23 个矩阵 Profile 中的全部 Browser capability | 不是现场核实候选；先补官方政策、规则和离线证据 |
| API-only production Profile | CORE、Elsevier、Wiley | 只证明已列出的授权 API capability；Browser 仍 unsupported |
| 已获用户现场授权核实单 | 0 | 不执行真实请求、登录或下载 |

因此本轮 P83 只建立门和模板，不读取真实凭据，不打开真实 Provider Browser，不使用个人
profile，不请求论文，也不产生 Cookie、响应、PDF、截图或现场日志。将来只有某个 Profile 先
形成独立的 `fixture-verified` Browser route，并满足下节的候选条件，才能复制
[单项核实单模板](profile-template.md)创建
`browser-live-verification/<access-key>.md`。每个 access key 必须使用自己的文件，不能用一张
通用授权覆盖多个 Provider。

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
- Profile 在验证矩阵中是 `fixture-verified`，不是 `unsupported`；
- 拟使用的账号、机构订阅、网络和文章样本由 operator 自行确认有权使用；项目文档不作法律或
  entitlement 判断。

任何条件缺失时，先回到 Notes、rule/fixture 或离线测试，不能通过真实站点“边试边猜”补设计。

## 3. 另行授权必须精确到一张核实单

用户授权必须在执行前明确确认同一文件中的以下封闭范围：

- 一个 `access_key`、一个 Provider/Access Platform 和一个 evidence/rule revision；
- 由用户提供并确认可用的精确文章样本；样本标识和正文只保存在获准的仓库外运行目录；
- 最大文章数、文章流程数、顶层导航数、动作数、popup/download 数、总请求数、总字节和总时长；
- 生效时间窗和授权到期时间；过期后不能沿用；
- 精确 Browser policy、执行确认、可见/非 headless Browser 和同组串行边界；
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
2. 使用可见 Browser 和该 Provider 自己的 operator-managed profile；
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
2. 更新 evidence manifest、Profile/rule revision 与 production status；
3. 增加或更新离线 fixture、直接测试、对象图 identity 和安装 wheel acceptance；
4. 复跑 P79–P85 对应检查和 Full Harness；
5. 完成产品、架构、并发、Browser/secret 安全和数据完整性审查；
6. 由维护者明确批准 production-ready 变更。

未通过、授权撤回、证据过期或政策漂移时，Profile 保持或退回 `fixture-verified`/`unsupported`；
已验证的 Browser foundation 和 API-only Profile 不因此失效。
