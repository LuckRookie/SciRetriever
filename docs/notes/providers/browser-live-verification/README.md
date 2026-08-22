# 受控 Browser 现场核实门

- 建立日期：2026-08-15
- 最后同步：2026-08-22
- 当前状态：Browser 使用所选持久 Profile、唯一 CloakBrowser runtime、当前机器
  网络出口和单项明确授权
- 当前 production Browser Profile：`9`（均由总开关显式启用并逐文章检查）
- 当前 production Browser rule：`9`
- 文档性质：真实 Provider 访问前的人工作业门；不是自动测试、运行指南或访问授权

本门只约束把一个已经完成官方政策审查、离线证据包和生产组装的 Publisher Browser route
带到真实 Provider 环境做最小只读核实的过程。它不批准任何 Provider、文章、机构或网络访问，
也不能用来把 `unsupported` 或 `fixture-verified` 自动改成 `production-ready`，也不能替代组织
授权、Publisher 条款或逐文章 entitlement 检查。Harness、CI、安装 wheel 验收和普通开发运行
始终离线。

自动 Browser 固定以 `headless = false` 运行；无 GUI Linux 由 Xvfb 提供虚拟显示，现场探测本身
不提供交互窗口，也不填写密码、选择机构、读取登录结果或处理 MFA/CAPTCHA。第一版没有另行打开
可见 Browser 的认证流程；需要登录、机构选择、MFA 或明确人工 challenge 的样本必须停止。自动运行
使用执行机器的正常网络出口，由站点逐文章判断公开可达性、Profile 状态、机构 IP 和具体
entitlement。一个 Completion 对象图只启动一个 patched Chromium process 和一个 persistent context；不同 Publisher lane
共享它们，同一 Publisher risk group 严格串行。关闭对象图只清理 process/context 与临时下载
工作区；Chrome 管理的 Profile 跨命令保留，只有显式删除操作才能移除。

## 1. 当前队列

| 类别 | 当前结论 |
| --- | --- |
| Production-ready Browser Profile | ACS、AIP、Elsevier / ScienceDirect、IOP、Oxford Academic、RSC、Science / AAAS、SpringerLink、Wiley Online Library，共 9 项；总开关和 runtime 就绪后逐文章检查 |
| 其它矩阵 Profile | 没有 production Browser route；不是现场核实候选 |
| 已公开的历史现场摘要 | 2026-08-18 SpringerLink 四个脱敏样本：三个 normal miss、一个通过当时机构网段交付 primary PDF；该小样本不证明当前 IP、其它文章或长期成功率 |
| 本次脱敏现场摘要 | 2026-08-20 Browser-only 九 route 各一个样本：一个交付 primary PDF、一个 normal miss、七个由页面明确识别为 challenge；同 revision 的独立单项复验又有另一 Publisher 交付 primary PDF。两个成功文件分别为 30 页和 5 页，magic、严格 PDF reader、DOI/完整题名、SHA-256、Catalog/Artifact/SQLite 一致性均通过；批次内部 policy/runtime/timeout/cleanup/budget/correlation failure 为 0。时点结果不代表供应商成功率或未来 entitlement |
| 切换前对照基线 | [2026-08-21 服务器 Browser 脱敏基线](2026-08-21-server-baseline.md)：同一 Profile/process/context、服务器 direct 出口，SpringerLink/IOP 2/9 成功；七家 challenge、Cloudflare dependency 被本地 guard 阻断、诊断放行后出现明确互动控件。该记录只用于 Cloak/challenge A/B，不是普遍 entitlement |
| 最终 Cloak-only 现场准入 | 2026-08-22 固定九家每家一个代表样本：SpringerLink 以唯一 Cloak runtime 捕获并验证正文 PDF，记为 `ready`；ACS、AIP、Elsevier、Oxford、RSC、Science 和 Wiley 各加载 17 个 Cloudflare 受限资源且本地阻断为 0，但有界 settle 超时；IOP 转向未审查 PerfDrive 顶层 origin 并正确 fail closed，八家均记为 `deferred`。这只证明 Springer 固定样本无回归、Cloudflare 资源不再被本地误拦和未知验证 origin 保持 fail closed；不证明 Cloak 提高总体下载率，不外推任何文章 entitlement。逐家依据见[Publisher 准入矩阵](../publisher-access-matrix.md) |

SpringerLink 历史运行还证明了当时实现中的 operation-local session reuse 和 Provider-specific
pacing；它不能反向证明当前持久 Profile 已认证、能够跨命令复用某个登录，或对其它文章有权限。
完整 URL、DOI、selector、页面正文、响应正文、Cookie、Profile 内容/路径和 PDF 字节没有进入本目录。

## 2. 进入现场核实的必要条件

建立[单项核实单](profile-template.md)之前，必须同时满足：

- 对应 Provider Notes 已记录当前官方访问条款、自动访问/TDM 边界、Browser 适用性和核对日期；
- Profile 已是 `production-ready`，生产对象图中存在真实 `BrowserSiteRule`，不能用现场探测替代
  官方政策或离线准入；
- 用户已明确授权本次真实只读 Browser 探测，并确认拟使用的机器网络出口、样本与用途处于其
  组织授权和 Publisher 条款边界内；Browser 总开关本身不证明这些事实；
- 一个不含敏感信息的 Browser Profile identity 已通过配置中心选择并安全初始化；现场核实只取得
  该 Profile 的独占 runtime lease，不检查其中的 Cookie、站点、账号、机构或登录详情；
- 已按 Provider 声明 `browser_rate_limit_group`、`browser_session_key`、`max_concurrency=1`、
  最小文章启动间隔、window/cooldown 和 circuit；未知数字不能用统一默认值填充；
- landing、navigation、capture origin、稳定文章 identity、页面动作、primary/supplement/
  wrong-article 归属均为封闭规则；未知站点没有通用 fallback；
- 离线 fixture 覆盖 entitled、login-required、not-entitled/paywall、MFA/challenge/rate/IP/account
  warning，以及 primary/supplement/excluded/wrong-article；
- 本地 HTTPS/真实 Chromium 验收已证明批准页面资源可加载、未批准第三方 tracker 在 DNS 前丢弃，
  点击或页面脚本产生的显式 request 逐项复审，未暴露 route 的 native redirect 只复用同页、live、
  已批准且预绑定的祖先证据，并覆盖 response/download/popup/viewer、预算和清理；
- 用户明确确认拟使用的当前机器网络出口和文章样本在自己的授权范围内。

任何条件缺失时，先回到 Notes、rule/fixture 或离线测试，不能通过真实站点“边试边猜”补设计。

## 3. 用户另行授权的封闭范围

真实只读核实必须在执行前由用户明确确认同一张核实单中的：

- 一个 `access_key`、一个 rule/evidence revision 和一组批准 origin；
- 用户提供并确认可访问的匿名文章样本；真实标识只保存在获准的仓库外运行目录；
- 最大文章数、文章流程、顶层导航、规则动作、popup/download、总请求、总字节和总时长；
- 生效时间窗、Provider-specific policy、同组串行边界和强制停止条件；
- Catalog、ArtifactStore、report 和日志的仓库外落点及运行后保留/清理选择。

访问模式固定为 CloakBrowser patched Chromium、`headless = false`、固定 identity manifest 和
持久 Profile。核实单必须使用普通配置已经选择的 Profile，不能临时指定外部路径、导入 Cookie，
或把 probe 扩展为人工登录；需要认证的样本不在第一版范围内。“测试一下 Browser”“使用我的现有
配置”或一般性开发授权都不满足本门。

## 4. 执行边界

现场核实一次只执行一张核实单。首次核实不并行多个 Provider；产品常规运行仍允许不同 risk
group 并行，同一 group 始终严格串行。执行必须：

1. 在副作用前再次显示 access key、样本数、policy、预算、落点、授权时间窗和停止条件；
2. 只使用生产受控有头 Browser、当前机器网络出口、普通配置选中的持久 Profile 和自动创建的
   临时下载工作区；无 GUI Linux 使用 Xvfb，probe 期间不开放用户交互；
3. Public 与适用的 Authorized API 层正常结束且 Browser admission 明确允许后才启动；
4. 所有显式 navigation、页面 request、popup、viewer、response 和 download 都经过 Profile guard
   与 Network policy；未再次暴露 request 的 native redirect 只有同页 live ancestor、批准且
   预绑定的最终 origin 与 terminal host admission 同时成立时才能关联；普通文章只加载规则批准
   的页面资源；
5. 同组 `concurrency=1`，所有重试重新排队并服从 interval/window/cooldown；
6. 成功捕获继续经过正文归属、实际 PDF 字节/reader/页面树验证和不可变发布；
7. 正常与 Debug 日志只记录稳定 code、group/state/action 和匿名候选，不记录完整 URL、query、
   selector、页面正文、header、Cookie、token、临时路径或 PDF 字节；
8. 经规则审查的 challenge dependency 可以在局部预算内自然加载和 settle；只有自动 clear 才返回
   文章流程。本地资源阻断、settle timeout、明确 CAPTCHA/Turnstile 互动控件、登录、MFA、账号
   警告或机构选择页面形成不同终态并停止，建议改用已授权 API 或手动 PDF。

## 5. 强制停止条件

出现以下任一情况立即停止对应 Provider，不自动换入口、换网络或提高重试频率：

- 用户取消、授权到期或任一预算达到上限；
- 官方政策、robots、产品/entitlement 或页面合同与核实单不一致；
- `429`、quota、`Retry-After`、rate-limited、IP blocked 或服务明确要求降低频率；
- login、CAPTCHA/Turnstile 人工交互、MFA、challenge resource-blocked/settle-timeout、账号警告、
  异常认证或机构选择；
- landing/capture 跳到未批准 origin，或 DNS/TLS/binding/redirect 检查失败；
- 只得到 supplement、front matter、wrong article、HTML/XML、超限或不可验证 PDF；
- timeout、runtime、cleanup、publication 或数据完整性失败；
- 原始日志、异常或输出可能包含 secret、Cookie、签名 locator、个人路径或受限正文。

一次成功或失败都不允许扩大样本、预算、route 或 Provider 范围，除非用户重新给出精确授权。

## 6. 结果、脱敏与清理

现场原始材料只进入核实单批准的仓库外运行目录。执行结束后关闭 page/context/session/broker，
核对没有残留 Chromium/Playwright 线程，并确认自动创建的临时下载工作区已删除；选中的持久
Browser Profile 保留且不读取内容，Catalog、ArtifactStore 和日志按用户确认处理，不删除用户既有
文件。

可提交结果只包含日期、revision、匿名样本数、预算使用量、稳定 outcome/code、页面状态类别、
primary/supplement/wrong-article 结论、policy 是否一致和后续维护动作。不得提交真实 DOI/PII、
完整 URL、响应、HTML、PDF、截图、Cookie、token、账号、机构、个人路径、数据库或原始日志。

现场通过仍不自动上线：必须同步 Provider Notes/evidence、离线 fixture、生产对象图、安装 wheel
acceptance，重新运行 Full Harness，并完成安全与数据完整性审查。现场失败应区分用户当前 IP/
文章无权限和 route 合同失效；只有后者影响 production status。
