# 04｜PDF 获取、文件交接与网络边界

## 1. 设计约束

**Agent 停止探索、浏览器触发下载、文件完整落盘、文章验收入库是四个事件。** 默认普通导航使用 Chromium 原生请求；Collector 从浏览器事件接收，不以重新发一遍 HTTP 为正常下载路径。

当前 `_GenericCapturePolicy.prefetch()` 的全导航 fetch/fulfill 不能原样迁移。它是应做对照实验的实现选择，而不是已被证实的网站拒绝根因。[R06](10-sources.md#r06)[W12](10-sources.md#w12)

Public → authorized API → Browser 的来源能力仍保留。统一 Artifact 收口不意味着废弃成本更低且已配置的合法来源，也不恢复 Publisher-specific 点击规则。[R14](10-sources.md#r14)[R16](10-sources.md#r16)

## 2. Collector：独立运行的文件接收器

由 Browser Host 在创建/接入 Context 时安装 Context 与页面事件监听；接管新页面时立即安装下载、响应、导航和关闭观察。为用户操作和 Agent 操作提供完全相同的接收路径。

```text
signal → receiving → durable-ready → inspecting → accepted
                                        ├→ mismatch
                                        └→ uncertain
receiving → transfer-failed / cancelled
```

`signal` 只表示候选线索，不能构成成功。`durable-ready` 只在受控暂存区已有完整文件、大小与哈希已记录、最小恢复记录已保存后发出。持久化能力在 M5 上线前，实验版本不得承诺服务崩溃恢复。

每个 Candidate 记录 task/attempt/workspace、page/frame/opener 来源、捕获方式、开始与完成时间、媒体类型、字节数、SHA-256、opaque stagingId。URL 保存脱敏来源；运行中需要的签名 query 仅在受限内存中使用，不直接写任务表或普通日志。

多个事件可能指向同一字节。捕获标识去重与字节哈希去重分开：相同文件可以由两个来源产生关联证据，不能因去重丢失 provenance；一个文件也不能仅因为同名而合并。

## 3. 各种交付形态的处理

| 形态 | 首选处理 | 必须避免 |
|---|---|---|
| native download | 在操作前监听；等待 `saveAs`/完成状态，将文件交给统一 spool | 把 download-start 当完成；Context 关闭后才复制 |
| PDF response | 记录 request/response/finished；确认正文完成后有界读取并保存 | 仅凭 Content-Type/扩展名接受；假定所有 body API 都流式 |
| blob / data | 优先触发浏览器原生保存；必要时在所属页面/frame 用固定内部适配器读取 | 外部 HTTP 客户端请求 blob URL；全局拦截改写所有 JS |
| iframe / nested frame | 关联 frame/request 与任务；监听底层响应或下载 | 只监听主页面；保存 iframe 外层 HTML |
| PDF viewer | 识别底层文件来源或执行浏览器可用的下载动作 | 认为看到 PDF 画面就是已拿到文件；抓取 viewer 壳 |
| popup / 新标签页 | Context 级新页监听 + opener/attempt 绑定 | 只等原 page 的事件；晚绑定造成首个下载遗漏 |
| 导航或 POST 返回文件 | 使用该浏览器已产生的结果，保持会话与方法 | 改成 GET 重新请求有副作用/一次性 URL |
| 206 / Range | 优先原生完整下载；不能完整接收则明确保留 incomplete 状态 | 把单个片段当 PDF；在 ETag/总长不一致时拼接 |
| SW / cache response | 在受支持组合中验证真实可见事件与归属 | 因路由看不到就假定没有网络；贸然启用 SW |

Playwright 的下载事件与文件完成是分开的，Context 关闭还会清理其下载文件；这构成 Collector 独立生命周期的直接依据。[W10](10-sources.md#w10)[W11](10-sources.md#w11)

首发必须尝试支持上述形态，但不能为“通用”假装每个浏览器版本的 viewer/opaque blob 都可读取。底层不支持时记录明确能力失败，不退回全站 fetch/fulfill。Range 重组仅在确有必要且能验证对象身份、总长和完整片段时作为独立适配器加入。

## 4. 时序、超时与取消

启动浏览器时安装监听，之后才允许导航或点击。动作返回的是动作结果和当时的页面事实；不要求同一步必须等到所有下载结束。

取消作用域分开：模型调用、单次动作、观察等待、文件传输、单篇任务、整个服务。截图超时不取消 transfer；Agent `finishExploration` 不立即关闭 Context；页面短暂不动不终止候选。

当候选已验收成功，应用可以停止该任务继续探索，同时让其它已经开始的候选在有界 drain 内收敛或明确取消。未登记的文件不能被悄悄清理。完成文件进入 durable spool 后，不再依赖浏览器临时目录，允许独立校验与发布。

单篇活动预算耗尽时停止新的探索；已经开始的transfer使用独立、有上限的drain预算。暂停不意味着所有文件无限保留或传输永不超时；达到传输/保留上限时记录明确终止与清理结果。

如果操作在服务崩溃前已派发但没有结果，标记 outcome-unknown，先从当前数据库、spool 和新页面状态对账。去重提供“重复结果不重复发布”，不提供外部网站点击的 exactly-once。

## 5. 字节门、文章门、版本门

**字节门**确认非空、合理大小、PDF 格式、可打开的页树和至少一页；可选修复/容错解析必须标记，不因文件名 .pdf 就接受，也不把一个简单 EOF 字符串检测当完整判定。解析在独立受限进程中进行，不执行 PDF 脚本、不访问外部 URL，限制时间、内存、文本量和页数。PDF.js 是候选引擎，不是其文字提取质量已被证明满足本项目的结论。[W17](10-sources.md#w17)

**文章门**返回 MATCH / MISMATCH / UNCERTAIN，证据结构区分主标题、主 DOI、作者、封面/前页、正文引用和来源链。目标 DOI 出现在参考文献里不能单独接受；目标 DOI 未提取到而提取到其它引用 DOI，不能单独拒绝。URL/direct 起点提供关联证据，但不是万能的真实性证明。

**版本门**检查 Published / Accepted Manuscript / Preprint / Supplement / Preview 等是否满足策略。属于同一研究但不被用户允许的版本，不作为目标成功。用户接受作者稿也不能绕过具体 Literature 身份和版本关系模型。

对于补充材料，优先使用首页主标题、元数据标题、明确的文档角色和来源组合；正文“见 Supplementary Fig.”只是引用，不构成文档角色。[R08](10-sources.md#r08)

模型可以提供身份辅助意见，但必须返回结构化证据位置和候选结果，Acquisition 最终裁决。UNCERTAIN 保留受控候选并按策略继续核查、延后或跳过；不直接正式入库，也不必然请求人工。

当前测试包含空白页加元数据的合成 PDF；保留有效场景，补充真实排版的合成文本页、引用 DOI 和补充提及，不能只翻译旧测试后声称身份逻辑完整。[R19](10-sources.md#r19)

## 6. Network 负责什么

保留统一 URL/端口/重定向/地址分类、DNS 解析与连接地址绑定、TLS 验证、凭据 exact-origin、取消、资源预算与限速。浏览器页面策略、页面稳定判断、文件身份和任务是否询问用户不属于 Network。

现有 CONNECT 是不终止 TLS 的字节隧道，不等于 `route.fetch()`。可以在 TS 中保留这种连接边界，但必须验证导航、子资源、弹窗、SW、WebSocket、下载及可能的非代理通道都不能绕过网络政策。[R15](10-sources.md#r15)

不终止 TLS 的 CONNECT 看不到 HTTPS 中每个资源的 URL/body，不能宣称它单独实施了精确逐资源大小限制。响应读取设置有界上限；native download 使用受控目录、传输监测与存储配额。监测式取消可能有小幅超收，必须测量、说明。若现有合同要求严格上限，则采用可证明的外层配额/隔离方案，不能用定时轮询冒充严格硬限。

正式浏览器默认拒绝 loopback、私网与云 metadata 等非授权目标；LLM/MinerU 可配置的本地地址使用各自专门能力，不能顺带授予浏览器。内部 fixture 网络只在测试进程中开放确定的测试地址，不能添加进生产白名单。

Service Worker 当前被禁用是覆盖性的选择。先保留可验证的安全基线；只有 POC 证明 SW 参与的请求仍受保护后，才允许在明确配置下启用。Playwright 路由对被 SW 接管请求存在可见性限制。[W13](10-sources.md#w13)

浏览器访问真实网站与 LLM/API 访问分开限速。失败站点统一退避，不能每篇从零撞同一拒绝。明确 429/Retry-After 可驱动冷却；403 不自动等于无权限。持久化未来的 nextEligibleAt 属于运行调度，不是证明账号获得或失去授权。

## 7. 诊断必须同时保存事实与处置

建议 reason 层级：

| 层级 | 示例 |
|---|---|
| 本地限制 | network-policy-denied、runtime-unavailable、budget-exhausted |
| 上游访问 | upstream-denied、rate-limited、challenge-unresolved、entitlement-explicitly-denied |
| 页面操作 | target-not-actionable、observation-stale、navigation-incomplete |
| 传输交付 | transfer-incomplete、download-receiver-failed、candidate-handoff-failed |
| 验收 | invalid-pdf、article-mismatch、identity-uncertain、version-not-allowed |
| 提交 | stale-business-facts、storage-full、publication-failed |

每项另有 `outcome=skipped/deferred/failed/succeeded`，由策略与实际结果形成。相同403可记录访问受阻并跳过，不虚构“IP信誉低”。诊断优先保存状态码、本地拒绝来源、脱敏 host、捕获阶段、时间、尝试次数；Cookie、签名URL和完整页面正文不进普通日志。

## 8. 单变量验证

受控 fixture 全部通过后，才在明确获授权的真实样本上对比：人工正常浏览器；人工接入新工作区；Agent 操作同一配置；旧fetch/fulfill与新native路径。相同出口、等价关闭后的Profile副本、相近时间条件，并记录冷/热状态。任何结果只能支持相应层面的归因，不能从一次换网络成功就断言信誉问题。
