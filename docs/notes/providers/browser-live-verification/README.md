# 受控 Browser 现场核实门

- 建立日期：2026-08-15
- 最后同步：2026-09-06
- 当前执行器：`browser:generic` + `AgentBrowserController` + `browser-generic`
- 文档性质：真实 Provider 访问前的人工作业门；不是自动测试、运行指南或访问授权

本门约束把已经通过离线合同测试的通用 Browser Agent 带到真实站点做最小核实的过程。它不批准
任何 Provider、文章、机构或网络访问，也不能替代组织授权、站点条款或逐文章 entitlement 检查。
Harness、CI、安装 wheel 验收和普通开发运行始终离线。

Publisher profile 中的 `browser_probe_enabled` 只允许配置中心打开一个已核实首页，检查 runtime 与
目标可达；它不是下载 route。真实文章核实从用户批准的 canonical landing 开始，不要求 Publisher
access key，也不使用 Publisher 点击规则。

自动 Browser 固定以 `headless = false` 运行；无 GUI Linux 由 Xvfb 提供虚拟显示。现场核实不填写
密码、选择机构、读取登录结果、处理 MFA/CAPTCHA、注入 solver/token 或切换身份/出口。一个对象图
只启动一个 patched Chromium process 和一个 persistent context；所有文章进入
`browser-generic` 串行执行，每篇文章使用隔离 page、handler 和临时下载目录。

## 1. 历史证据的含义

2026-08-18 至 2026-08-22 的 SpringerLink、IOP 和九站点结果来自已经删除的 Publisher rule
执行器。这些记录仍保留在本目录和[Publisher 准入矩阵](../publisher-access-matrix.md)中，作为
CloakBrowser、Challenge 资源、capture 与 PDF 验收的历史证据；它们不再证明当前下载 route、页面
策略或成功率。

当前 production 下载只有 `browser:generic`。离线 fixture 已证明稳定 Observation、六种封闭动作、
stale binding、popup/viewer、response/download capture、错误文章与 supplement 拒绝、文章隔离和
cleanup。它没有证明任意真实站点页面、当前 Profile 登录状态、机构 IP 或单篇 entitlement。

## 2. 进入现场核实的必要条件

建立[单项核实单](profile-template.md)之前，必须同时满足：

- 用户明确授权本次真实只读 Browser 探测，并确认机器网络出口、样本和用途处于其授权边界内；
- Browser Model、固定身份 Profile、CloakBrowser/Playwright/binary、headed display 与
  `browser-generic` policy 均就绪；
- 每篇样本有用户确认的 canonical landing，以及 DOI、标题或作者等可用于文章归属的目标线索；
- 离线 fixture 已覆盖本次依赖的 page state、动作、capture 类型、stale/timeout 和清理路径；
- 调试材料使用仓库外目录，预算、停止条件和保留策略已经写入核实单。

任何条件缺失时先回到实现、fixture 或配置，不通过真实站点“边试边猜”补设计。

## 3. 核实单的封闭范围

真实只读核实必须在执行前明确：

- 一组用户确认的文章样本及 canonical landing；真实标识只保存在获准的仓库外运行目录；
- 最大文章数、最大外部请求/字节/时长、有效时间窗和强制停止条件；
- 使用的 Browser Model、普通配置已选择的固定 Profile 与当前机器网络出口；
- Catalog、ArtifactStore、debug 图片、report 和日志的仓库外落点及保留/清理选择。

核实单不能临时指定外部 Profile 路径、导入 Cookie、扩展为人工登录，或允许 Agent 获得任意 URL、
selector、JavaScript、Page/CDP、文件系统和数据库能力。

## 4. 执行边界

一次只执行一张核实单。每篇文章必须：

1. 在副作用前显示匿名样本数、Browser Model、通用 policy、授权预算、落点、时间窗和停止条件；
2. 只有 Public 与适用 Authorized API 层正常结束且 Browser admission 允许后才启动；
3. 使用生产 `browser:generic`、当前机器网络出口、普通配置选中的 Profile 和自动临时目录；
4. 只把 Network 返回的稳定 Observation 交给 Agent；每次 Agent 决定只执行一个封闭动作；
5. 所有 navigation、request、popup/viewer、response 和 download 经过 Network admission，所有文章
   在 `browser-generic` 中 `concurrency=1`；
6. capture 继续经过实际 PDF 字节/reader/页面树与 DOI、标题、作者、起点 lineage 的文章归属验收；
7. 正常与 Debug 日志不记录完整 URL、query、selector、页面正文、header、Cookie、token、临时路径
   或 PDF 字节；Agent 图片只进入核实单批准的临时 debug 目录；
8. Challenge 可以通过同一 Observation/Action 合同处理；登录、MFA、账号警告、机构选择或 Agent
   明确停止分别记录并终止当前样本，不切换 controller 或入口。

## 5. 强制停止条件

出现以下任一情况立即停止，不自动换入口、换网络或提高频率：

- 用户取消、授权到期或任一核实预算达到上限；
- 官方政策、robots、产品/entitlement 或页面合同与核实单不一致；
- `429`、quota、`Retry-After`、rate-limited、IP blocked 或服务明确要求降低频率；
- login、MFA、challenge resource-blocked、账号警告、异常认证或机构选择；
- destination/DNS/TLS/binding/redirect 检查失败；
- 只得到 supplement、front matter、wrong article、HTML/XML、超限或不可验证 PDF；
- timeout、runtime、cleanup、publication 或数据完整性失败；
- 原始材料可能包含 secret、Cookie、签名 URL、个人路径或受限正文。

一次成功或失败都不扩大样本、预算或站点范围，除非用户重新给出精确授权。

## 6. 结果、脱敏与清理

现场原始材料只进入核实单批准的仓库外运行目录。执行结束后关闭 page/context/session/broker，核对
没有残留 Chromium/Playwright 线程，并确认自动临时下载目录已删除；持久 Browser Profile 保留且
不读取内容。

可提交结果只包含日期、实现 revision、匿名样本数、预算使用量、稳定 outcome/code、页面状态类别、
PDF/文章归属结论、policy 是否一致和后续维护动作。不得提交真实 DOI/PII、完整 URL、HTML、PDF、
截图、Cookie、token、账号、机构、个人路径、数据库或原始日志。

现场通过仍需同步当前行为文档、离线 fixture 和生产对象图，并重新运行 Full Harness。现场失败应
区分当前网络/文章无权限、Agent 页面策略不足、Network 交接失败和 PDF 文章归属拒绝；只有后两类
属于实现修复输入。
