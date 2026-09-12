# 第一阶段支持矩阵

更新时间：2026-09-10。矩阵只声明已经在本地离线边界验证的运行组合，不把组件存在、单篇 fixture 成功或
真实 Provider 授权扩大为普遍支持。

| 维度 | 已验证 | 未声明 |
| --- | --- | --- |
| OS / architecture | Ubuntu 24.04.3、Linux x86_64 | 其它 OS、ARM、容器内核差异 |
| Node / package | Node 22.19.0、pnpm 10.32.1、锁定 workspace tarball 离线安装 | 其它 Node/pnpm 版本 |
| Browser runtime | operator 安装的 Cloak bundle `chromium-146.0.7680.177.5`；真实 Browser Host、双 viewer、390px UI | 未提供该 bundle 时的目标 runtime；任意发行版 Chromium 的产品等价性 |
| Python bridge | 不属于当前生产运行时；旧 bridge、源码和 Harness 按 [`migration/retirement-report.json`](../../retirement-report.json) 保留为历史材料 | 不提供 Python fallback；历史 Python 工具仅在明确授权下运行 |
| 外部服务 | 127.0.0.1 loopback fixture：文章、MinerU protocol-2、模型响应 | 真实站点、真实 MinerU、真实 LLM、真实 Provider、凭据和用户 Profile |
| 数据 | 合成 Literature、PDF、ZIP、catalog、FileStore，全部位于系统临时目录 | 用户 catalog、文献资产、个人配置和真实语料 |

目标 Cloak binary 由 `SCIRETRIEVER_CLOAK_BUNDLE` 显式指定；未指定时相关测试 skip，不能据此写成通过。安装包
测试验证静态 Web 资产和公开入口，未把 checkout 的 Python/Browser 运行依赖伪装成可独立发布能力。
