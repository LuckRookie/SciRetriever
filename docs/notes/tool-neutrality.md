# 工具中立性声明

- 状态：生效
- 记录日期：2026-07-22
- 最后同步：2026-08-18
- 适用范围：SciRetriever 全部代码、文档和规划材料

本声明规定项目立场，不声明某项能力已经实现。当前公开入口和已组装能力以项目 [README](../../README.md)、Bootstrap 生产对象图、源码和直接测试为准，历史方向材料见[文献库实施归档](../archive/2026-07-literature-library/README.md)。

## 1. 核心立场

**SciRetriever 的目标是在本地完成 metadata 检索、全文获取、通用分析和引用扩展，并形成统一文献库。`MetaLiterature` 和 `Literature` 是当前身份机制。项目不按道德标签判断文献来源，也不替用户决定某个来源是否可使用。**

本声明只规定来源分类立场，不构成某项技术能力的批准、实现承诺或法律意见。用户对自身行为负责；项目仍执行明确的产品边界、工程安全、第三方接口契约和配置要求。

## 2. 工具与使用的分离

技术能力的授权边界由产品需求和 Accepted ADR 确定，当前是否可用以项目 README、Bootstrap 生产对象图、源码和直接测试为准。活动提案和执行计划只能讨论或执行已经授权的范围，不能自行批准或扩展能力。SciRetriever 对据此授权并已实现的技术能力不附加基于来源道德分类的额外条件；归档材料中的能力不因本声明重新获得批准：

- **文献来源接入**：生产 Bootstrap 按配置、实现状态和 readiness 组装 Metadata 与 Acquisition registry；配置接受 Provider 选择键仍不表示每项 capability 都有 concrete adapter。项目不对来源本身添加“合法/灰色/非法”的分类标签。
- **资产获取**：当前 Acquisition 已连接通用公开路径和经过准入的授权 Provider API，Configured Sci-Hub 只接受 operator 明确注入且经过统一安全边界的 locator resolver。是否存在 route、是否已配置、当前目标是否适用和是否实际取得有效 PDF 是不同事实；工具不因来源道德标签另加拒绝条件。
- **网络与访问方式**：受控 Browser foundation、operator-managed profile 配置入口和用户明确发起的可见空白 Browser 会话已经实现；production Browser rule catalog 当前有且仅有 `springerlink-pdf@4`。只有在公开与授权 API 层完成、目标仍缺 PDF、强证据解析到 SpringerLink，且 Browser 开关、安全 profile、Playwright 与 Chromium 全部就绪时，自动 Completion 才会产生该 Publisher 的受控 Browser 流量。该规则从唯一 DOI 构造并打开经审查的 SpringerLink PDF locator，不导航 Metadata Provider 给出的 opaque asset path；已有 PDF capture 优先返回，未捕获时才检查封闭页面状态和 entitlement-gated static click。自动登录、机构选择、MFA/CAPTCHA 处理、任意规则脚本、profile-copy fallback、代理轮换和反检测仍不属于当前能力；是否已 production-ready 继续以 Profile 准入矩阵、生产对象图和直接测试为准。

## 3. 工程约束 vs 使用限制

以下两者有本质区别：

| 类型 | 定义 | 示例 |
|---|---|---|
| **工程约束** | 保证系统安全、稳定和数据完整性的技术底线 | 仅限 HTTPS、禁用 `verify=False`、不执行任意脚本、凭据不入日志 |
| **使用限制** | 只按来源标签替用户判断“该不该用”的规则 | “某类来源一律不可使用”、"灰色来源不接受" |

SciRetriever 只施加工程约束，不施加使用限制。

## 4. 文档规范

- 不对任何文献来源添加"合法/灰色/非法"等道德标签。
- 不将"本项目不接受"作为来源或能力的排除理由。
- 功能是否默认开启、是否需要显式配置，是工程决策，不表达价值判断。
- 当需要描述某来源的法律风险时，使用中性事实陈述（如"该来源在某些司法管辖区可能存在争议"），不做项目立场表态。

## 5. 用户责任

用户对自己使用 SciRetriever 的行为负责，包括但不限于：

- 遵守所在司法管辖区的法律法规
- 遵守其所属机构的文献使用政策
- 遵守其使用的第三方服务的条款

SciRetriever 不提供法律建议，也不作为用户行为的合规保证。
