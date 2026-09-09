# 02｜目标架构与设计边界

## 1. 架构原则

全量 TS 是应用代码统一，不是所有底层库都必须用 TS 实现。SQLite、Chromium 等仍是原生组件。无需为数据库保留 Python，也不预先建设 Rust 数据服务。只有实测证明某个安全或性能能力无法满足时，才评估范围很小的原生适配。[W03](10-sources.md#w03)[W04](10-sources.md#w04)

保持模块化单体，默认单机、单 operator。UI 与业务不是两套后端；每一项可变事实只有一个 owner。网络放行、浏览器动作、文件完整、文章身份四件事必须分别表达。

## 2. 建议目录

以下是目标路径，不是当前已存在的文件：

```text
apps/
  server/
    src/
      entry/              # CLI、HTTP、WebSocket 的薄适配
      application/        # 用例、任务编排、提交协调
      metadata/
      literature/
      acquisition/        # 目标、路线选择、验收、资产发布意图
      agents/             # 无业务策略的模型协议适配
      browser/            # 会话、观察、动作、投屏、控制权
      network/            # 出口、SSRF、DNS/IP、协议与访问预算
      parsing/
      analysis/
      storage/            # sqlite/、files/、runtime repositories
      configuration/
      logging/
      bootstrap/
    workers/
      browser-host.ts     # 可隔离的 TS/Node 子进程入口
      database.ts         # 连接由专用 Worker 持有
      pdf-inspection.ts   # 有界解析；必要时改为可终止子进程
  web/
    src/
      tasks/
      policies/
      workspace/
      library/
packages/
  contracts/              # 领域表示 + HTTP/WS/IPC 合同；明确分目录
  testkit/                # 纯合成 fixture 与迁移 oracle 数据
scripts/
  harness.mjs
  migration/
```

`contracts` 不成为业务规则的大杂烩；公开 DTO、领域值对象、私有运行事件分开。模块内部通过明确 API 协作，不为每个类创建 npm package。生产构建不依赖 TS 运行时即时编译。

## 3. 进程与数据流

```text
浏览器中的工作台
  │ HTTP/WS，同一个对外端口
  ▼
Node 主服务
  ├─ 应用用例 / 调度 / 策略 / Agent 调用
  ├─ 数据库 Worker ── SQLite Catalog
  ├─ 文件存储适配 ── ArtifactStore
  ├─ PDF 检查 Worker / 子进程
  └─ Browser Host（TS）
       ├─ Chromium persistent context / tabs
       ├─ Observation + typed Action executor
       ├─ Collector：下载/响应候选
       └─ Screencast：只向工作台分发画面
```

Browser Host 是唯一持有 Page/Context/CDP 的组件。Agent、HTTP handler 和前端不直接获得 vendor 对象。帧不进入 LLM 推理通道或数据库；Agent 按需获取一次观察快照。同步 DB 与 CPU 密集解析离开主事件循环，但普通异步网络 I/O 不需要一律搬到 Worker。[W05](10-sources.md#w05)

第一版一个 Profile 对应一个 Browser Host、一个受控工作区；同一工作区只处理一个浏览器文章任务，允许多个标签页。其他文献元数据、模型和解析任务可并发。后续增加工作区数量时必须使用独立 Profile，不让多个浏览器进程同时写同一 Profile。

## 4. 事实所有权

| Owner | 允许形成的事实 | 不允许形成的事实 |
|---|---|---|
| 用户/Configuration | 授权、资源、版本偏好、预算、协助模式 | 网页不能修改配置；AI 不能自行扩大授权 |
| Application Scheduler | 任务选择、领取、预算、重试、暂停、最终处置 | 不能由“任务成功”反向伪造资产存在 |
| Acquisition Agent | 下一步动作、候选路线、建议继续/跳过/协助 | 不发布 PDF，不宣称网络根因已确认 |
| Browser Runtime | 页面/标签页、动作派发事实、观察、控制权 | 不解释某 PDF 是否是目标文章 |
| Network | 实际请求结果、准入拒绝、地址/来源、安全边界 | 不规划出版社页面，不断言用户未订阅 |
| Collector | 候选接收、完整落盘、hash、捕获关联 | 文件落盘不等于验收通过 |
| Acquisition/Literature | 文章/版本验收、资产接纳、身份与内容关系 | 不把临时截图或网页状态写成长期文献事实 |
| Storage | 事务、字节、关系落库、完整性与对账 | 不另行制定文献业务规则 |

保留现有 Catalog 与 ArtifactStore 的统一逻辑数据库定义；新增运行事实不是第二个文献库。[R02](10-sources.md#r02)[R17](10-sources.md#r17)

## 5. 三个生命周期与一个独立控制状态

**Workspace：** 浏览器身份和执行现场，可跨多篇文章存在。  
**Task / Attempt：** 文献目标、策略快照、预算、一次尝试与结果。  
**Candidate：** 下载产物，完整保存后必须独立于浏览器继续存活。  
**Control：** AI / transferring / human / paused；不与 TaskStatus 合并。

任务建议状态为：`queued / running / deferred / awaiting-user / completed / skipped / failed / cancelled`。记录 `outcomeCode` 与证据，避免一个枚举混合阶段、根因和用户策略。

- `completed`：目标所需 current facts 已提交；下载场景为正确 PDF 已正式入库。
- `skipped`：策略决定本次不继续，例如预算用尽或不接受找到的版本；不表示证明永久不可获取。
- `failed`：无法继续的运行或系统失败；不能写成正常自动来源耗尽。
- `awaiting-user`：仅在策略允许阻塞时使用；无人打扰模式绝不进入该状态。
- `deferred`：有明确的未来重试条件/时间与剩余预算，不是无限搁置。

终态可重试时创建新 attempt，保留旧记录；同一任务完成要复核业务事实，不能盲信事件通知。

## 6. 用户策略与 AI 权限

自然语言偏好先变成严格、版本化 Policy。用户首次确认后，任务冻结完整快照，不依赖一个会被原地修改的配置对象。

策略包括资源、候选版本、费用/新账户/上传权限、时间/动作/模型预算、并发、失败处置和协助模式。AI 可以建议更改策略，但不能自己扩大能力。`no-permission → skip`、`purchase → never` 应一次设定，不重复询问。

建议首发默认 `assistance=never`、不购买、不新增账户、不上传用户文件，只使用已配置来源与会话。普通公开页面输入和导航不因是表单而禁止；凭据只能通过 exact-origin credential broker 填充，模型看不到凭据明文。

策略处置和技术事实分开。例如记录 `outcome=skipped`、`reason=access-blocked-unknown`，而不是根据 403 猜测 `not-entitled`。

## 7. 产品范围与不做的事情

保留当前已实现的发现、元数据、资产、引用、解析和领域中立分析。默认不引入多租户云服务、全桌面远控、通用爬虫平台、账号购买、代理轮换或自动扩大授权。非默认 source 只能按明确配置使用，不能在迁移中悄悄启用。[R02](10-sources.md#r02)[R16](10-sources.md#r16)

本地和远程均使用同一个工作台入口。端口转发只改变控制入口的可达性，不改变 Chromium 所在机器的出口和会话。页面投屏不能操作浏览器原生设置界面和全部操作系统对话框；必要事件提供受控 UI，不能承诺远程桌面的全部能力。[W02](10-sources.md#w02)[W06](10-sources.md#w06)

## 8. 依赖决策

| 部分 | 初选 | 必须验证 |
|---|---|---|
| Server | Node 24 LTS、TS strict、Fastify | 选定补丁版本、打包与平台支持 |
| Web | TS + React + Vite | 静态资源随安装包分发；无需用户构建前端 |
| WS | Fastify WS 适配/标准 WebSocket 库 | Origin、认证、背压、二进制消息和断线重连 |
| Validation | Zod strict schema | 不能用默认宽松解析替代 Pydantic strict/extra=forbid |
| Browser | playwright-core + 经验证 CloakBrowser JS | persistent context、native download、screencast、binary 校验 |
| SQLite | better-sqlite3 + 显式 SQL | 预编译包、FTS5/STRICT、v1 manifest、Worker、平台安装 |
| PDF 基础检查 | pdfjs-dist 候选，独立受限执行 | 无文本/损坏/加密/大文件、文本质量、是否引入额外 native 依赖 |
| 测试 | Vitest + Playwright Test | 离线 fixtures、安装后测试、故障注入 |

这些是方案选择，不是已安装依赖。具体版本与最终选型由 M0 的有限 spike 决定，不同时维护多个生产驱动。`node:sqlite` 当前不同 Node 分支的稳定级别不应混同；本计划不以浮动 latest 文档承诺 Node 24 的所有 API。[W01](10-sources.md#w01)[W03](10-sources.md#w03)[W04](10-sources.md#w04)[W07](10-sources.md#w07)[W08](10-sources.md#w08)[W09](10-sources.md#w09)
