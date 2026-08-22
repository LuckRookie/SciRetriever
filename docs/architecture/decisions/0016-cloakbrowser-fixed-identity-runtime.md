# ADR 0016：CloakBrowser 固定身份 Browser runtime 与验证页生命周期

- Status: Accepted
- Date: 2026-08-21
- Supersedes: none
- Amends: [ADR 0015](0015-publisher-aware-tiered-pdf-acquisition.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[Network 技术文档](../technical/network.md)、[Configuration 技术文档](../technical/configuration.md)、[Provider Notes](../../notes/providers/README.md)

## 背景

ADR 0015 已经确定 Public → Authorized Provider API → Controlled Browser 的严格风险顺序、一个长期身份 Profile、一个共享 process/context，以及 Publisher 风险组之间并行、组内限速串行。当前 stock Playwright runtime 能执行这些合同，但服务器实测仍暴露 `navigator.webdriver=true`、空 plugin surface 等明显自动化特征；同一长期 Profile 若在每次启动配合随机设备指纹，也会产生“Cookie 和历史不变、设备身份持续变化”的矛盾。

2026-08-21 的九家 Browser-only 小样本还发现了另一个独立问题：七家进入验证页时，`https://challenges.cloudflare.com` 不在对应 Provider 的批准资源集合，SciRetriever 自己的 origin/CONNECT guard 阻断了 challenge iframe 和脚本。页面因此停留在不完整的 `Just a moment...`，随后又被初次状态检查立即统一终止。诊断性放行该 origin 后，页面能够加载真实的人工验证控件，但没有在短时间内自动完成。这说明“验证资源被本地阻断”“自动验证仍在进行”和“明确需要人工交互”必须分别表达；更换 Browser runtime 也不能被当作绕过 CAPTCHA 或内容授权的保证。

## 决策

### 1. CloakBrowser 是唯一目标生产 runtime

生产 Browser 由 CloakBrowser patched Chromium 承担。SciRetriever 继续使用 Playwright API 作为内部控制协议，但不再由 stock Playwright launcher 直接选择系统 Chrome/Chromium：

```text
Acquisition rule / controlled Agent decision
  -> SciRetriever BrowserControlSession
  -> Playwright API
  -> CloakBrowser patched Chromium
```

CloakBrowser 类型不得越过 Network 与 Bootstrap 适配边界。迁移期只允许内部测试持有 stock launcher 作为基线；真实小样本对照和离线门通过后删除 stock discovery、stable Chrome fallback 和旧 adapter，不向用户提供多引擎选择器，也不在生产失败时自动回退旧 runtime。

### 2. 长期 Profile 必须绑定固定设备身份

一个 operator-managed Profile 仍对应一个 Browser process 和一个 persistent BrowserContext。Profile 第一次初始化时生成一次 fingerprint seed，并在 owner-only identity manifest 中绑定：

- identity schema；
- persona 与平台；
- locale、languages、timezone；
- screen/window geometry；
- Browser version policy；
- seed 派生身份的安全 hash。

同一 Profile 后续冷启动复用该身份，不在普通运行中随机换设备；不同新 Profile 不复用 seed。seed、完整 fingerprint、Profile 路径和 Browser 状态不进入普通配置、凭据、日志、Report、Catalog、ArtifactStore 或 provenance。显式删除 Profile 时，Configuration 才删除其身份 manifest 和 Chrome 管理的状态。

第一版 Linux runtime 使用内部一致的 native Linux persona、有头窗口栈和 Xvfb，不用与实际字体、WebGL 和平台表面冲突的默认 Windows persona。字体、时区、语言、屏幕和 Browser version 必须作为同一身份一起验证。所有生产 click、scroll、wait 和后续允许的输入动作通过同一个 CloakBrowser/Playwright humanized 执行器；不得用第二个 CDP client、直接 DOM click 或另一套 Browser 绕过该路径。

### 3. Binary 生命周期与 Profile 迁移显式受控

CloakBrowser Python wrapper 与定制 Chromium binary 的版本、许可和分发分别核实。SciRetriever wheel 不嵌入或重分发 vendor binary；安装、更新和回退只由用户在 Configuration 边界显式触发，普通 Completion 不隐式下载。显式安装必须把 vendor 签名的 version/digest、仓库固定 digest 与本次实际 archive 字节绑定后才能发布，不能根据解压目录存在或 vendor helper 成功返回自行声明已验证。status 只做本地 presence/version/readiness 检查。当前固定 older-free binary 不消费 license；普通 launch 通过一次性无凭据 cache view 只看见已验证版本，不能读取长期 runtime root 或 vendor cache-file credential。未来若需要 Pro secret，只能在新的受审版本线中从 origin-bound `credentials.toml` 注入，不恢复环境变量或 cache-file 回退。

旧 stock Chrome Profile 只有在程序生成的隔离 fixture 证明兼容、且用户显式同意初始化 identity manifest 后才能接纳。无法证明安全时报告 `needs-new-runtime-profile`，创建新的 Cloak runtime Profile，保持旧目录完全不动；不得静默复制、降级、删除或用较旧 Chromium 打开真实用户 Profile。

### 4. 原始出口、共享调度和 Network guard 保持不变

CloakBrowser 继续通过现有 loopback CONNECT 边界使用服务器原始网络出口，不读取环境 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY`。Publisher Profile guard、URL/DNS/地址、host permit、redirect、请求/导航/字节预算、统一 PDF capture 和不可变发布合同不因 runtime 切换而放宽。

所有 Publisher lane 继续共享一个 process/context；同一 `browser_rate_limit_group` 始终只有一个活动文章流程并服从 Provider policy，不同独立组只在全局本机资源 cap 内并行。Cloak runtime、Playwright manager、事件泵、Xvfb、CONNECT、Profile lease 和 close 必须由一个明确的 engine 生命周期拥有，失败、取消和退出不得残留第二套 manager、thread 或 Browser 进程。

### 5. Challenge dependency 是受限页面资源，不是普通 Provider origin

经证据确认使用 Cloudflare 的 Publisher Profile 可以声明 `https://challenges.cloudflare.com` 为受限 challenge dependency。该声明只允许：

- 已批准 Publisher 顶层页面发起的必要 iframe、script 或 request；
- HTTPS/443、经过 DNS/地址和 host admission 的请求；
- 当前文章预算、frame ancestry 和页面生命周期内的资源。

它不允许把 challenge origin 用作初始或任意顶层导航、PDF locator、popup 目标、capture source、跨文章 locator 或未知 Publisher 的通用第三方 origin。Publisher Cookie/Authorization 不由 SciRetriever 复制到该 origin，query、token 和页面正文不进入结果或日志。

### 6. Challenge 使用有界 transient/terminal 生命周期

Browser 页面状态至少区分：

```text
resource-loading
settling
cleared
interaction-required
resource-blocked
settle-timeout
failed
```

出现高特异性 challenge 证据后，系统先在文章总预算内进入局部 settle，允许已经批准的资源和页面脚本自然完成。自动跳转回文章页面时继续正常 DOM/PDF 流程；明确互动控件出现时立即进入 `interaction-required`；本地 origin/CONNECT policy 阻断形成 `resource-blocked`；局部 deadline 到期形成 `settle-timeout`。裸 HTTP 403、普通 paywall、登录、IP block 和 runtime failure 不能仅凭通用文本归入 challenge。

Network 只提供 status、frame/resource admission、navigation、capture 和预算等有界事实；Acquisition/Publisher rule 唯一解释 challenge、paywall、login、entitlement 和文章结果。正常与 Debug 日志只记录证据类别、阶段、资源计数和耗时，不记录 title/body、selector、截图、token 或完整 URL。

第一版不自动点击、破解或外包 CAPTCHA/Turnstile，不自动登录、选择机构或处理 MFA。明确人工验证仍是对应 Publisher 风险组的 action-required 终态。

### 7. 切换采用离线门、真实小样本门和单点删除

切换前必须依次证明：

1. 固定身份、Profile lease、Linux persona、共享 process/context 与清理；
2. 本地 HTTPS 下的 CONNECT、redirect、iframe、service worker 和 PDF 捕获；
3. Cloudflare-shaped 第三方 iframe 的受限加载、自动 clear、人工控件、资源阻断和 origin escape；
4. 用户明确授权的极小 stock/Cloak 串行 A/B，且 SpringerLink/IOP 已有成功链不回归。

通过后一次性删除 stock runtime，再在最终单 runtime 对象图上重新执行 Quick、Full 和 fresh-wheel 验收。切换失败通过完整提交回退，不在产品中保留兼容开关。真实 Provider 结果只决定逐家 ready/deferred/unsupported，不把单篇成功或失败扩写成普遍 entitlement。

## 后果

- 长期 Profile 的 Cookie/历史与设备身份一致，不再因每次随机 seed 自相矛盾。
- CloakBrowser 降低 stock automation surface，但不保证通过 Cloudflare，也不改变 Publisher entitlement。
- Cloudflare 必需资源不再被 SciRetriever 自己无差别阻断；自动检查和人工验证得到不同结果。
- Binary、版本和 Profile 迁移成为明确 operator 生命周期，wheel 保持可安装且不携带 vendor binary。
- Browser 仍是三级获取的最后一层，原始 IP、Provider 限速、一个共享身份和 Network 安全边界保持不变。

## 不采用的方案

- 同时维护 stock Playwright、系统 Chrome CDP 和 CloakBrowser 三套生产 runtime；
- 每次启动随机 fingerprint，却复用同一长期 Cookie/Profile；
- 在 Linux 上无验证地伪装 Windows persona；
- 每 Publisher 一个 Profile、Browser process 或身份池；
- 代理轮换、住宅代理或自动改变机构出口；
- 全局放行 Cloudflare origin，或把 challenge body 当作 PDF/页面内容捕获；
- 自动点击或破解 CAPTCHA、自动登录、自动机构选择或 MFA；
- 为通过 fixture 而关闭 origin、DNS、host admission、资源预算或组内串行。

## 需要新 ADR 的变化

- 同时激活多个身份 Profile、把 Profile 拆为逐 Publisher 身份池或引入代理/IP 池；
- 恢复公开多引擎选择或长期 stock runtime fallback；
- 自动登录、Cookie 导入导出、机构选择、MFA 或 CAPTCHA/Turnstile 处理；
- 允许 Agent、插件或外部 CDP 绕过 SciRetriever BrowserControlSession；
- 将 fingerprint、challenge 页面、Cookie、Profile 内容或 Agent 页面观察持久化为产品事实。
