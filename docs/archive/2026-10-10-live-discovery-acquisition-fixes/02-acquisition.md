# PDF 路线可执行

Outcome：公开与授权链接语义正确；已启用 API 能消费可信目标证据；Elsevier 请求和 MAIN object、Wiley 受控跳转能够交付文件；失败保留可操作原因。

进入条件：沿用实测的 API 400/302 和零候选证据。责任：Provider 维护服务/URL/适用性与响应语义，Acquisition 执行路线，Network 执行准入/凭据/速率边界，Entry 组织阶段和报告。

- [x] 2.1 标记外部元数据链接的实际访问方式；Direct 不匿名请求已知授权服务，同时保留其供 API 使用的证据；兼容既有错误标记的 observations。
- [x] 2.2 将当前请求中确认过的 DOI landing/服务目标证据交给已启用 API；provider-specific origin/locator 规则放各 Provider，不能凭凭据存在自动启用来源。
- [x] 2.3 Elsevier Article Retrieval 使用资源路径，验证 FULL XML 的 MAIN object 与完整文件交付；不按单页/DOI 文本猜测有效性。
- [x] 2.4 Wiley 仅按官方跳转合同允许目标，剥离跨 origin 凭据，保留限流/取消/错误；不放开共享 Network 的全部跳转。
- [x] 2.5 API 非成功响应、Browser 限流/停止给出准确稳定原因和重试信息；核查 runtime 配置入口，保留显式启用与 bundle 校验。

集成影响：检查旧 AssetHints、新 Provider 定义、Public/API 注册器、Network 调用方与配置展示。优先兼容旧 metadata，不迁移用户库；安全字段与来源合同调整需同步指南。

验证：`acquisition-authorized`、`acquisition-public-sources`、`acquisition-source-failures` 及 production assembly/Entry/browser 相关测试；覆盖跨域 credential stripping、非法跳转拒绝、MAIN 与 supplement、限流不升级、旧 hints 和未知出版社的通用流程。

退出条件：正式 Source/Entry 测试形成 PDF 发布，不只 client 返回字节。恢复时保持失败证据，不改个人凭据和配置；真实源拒绝保留为外部条件。

执行证据：直接回归与真实复验见修复验证记录（本地文件：`sandbox/reports/live-discovery-acquisition-fixes-2026-10-10.md`，不随仓库分发）。其中 runtime 配置是环境前提，仅完善诊断；RSC 限流与 Springer 登录页继续保留，不通过其它路线绕过。
