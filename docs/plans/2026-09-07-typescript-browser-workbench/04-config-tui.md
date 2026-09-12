# 配置、凭据与 TUI/CLI 全量迁移

## 结果

本文件落实原始计划的 T012、T018、T044 和 T061 中与配置有关的部分。TypeScript 已接管 TOML projection、Credential、readiness、probe、非 TTY 命令和 Application 装配；Python 配置中心只保留为历史行为 oracle，不能作为发布包运行依赖。

## 当前可复用证据

固定配置 home、严格字段、原子发布、credential keep/set/remove、provider/origin 绑定、脱敏 readiness、取消和冲突恢复已由 TS owner 直接验证；证据见[配置边界](../../../migration/evidence/runtime/configuration-boundary.md)、[配置发布](../../../migration/evidence/runtime/configuration-publication.md)和[TS owner](../../../migration/evidence/runtime/configuration-typescript-owner.md)。80×24 TUI 的 Python 过程材料仅用于历史对照，最终命令由 TS CLI 提供。

## 必做任务

| 任务 | TypeScript 交付物 | 验收 | 当前状态 |
| --- | --- | --- | --- |
| T012-A 配置解析与投影 | `apps/server/src/configuration` 读取当前受支持 TOML schema、默认值、alias 和固定 home | 现有有效配置逐项等价；未知 section/key/type、非法引用和越界值在联网前拒绝；不读个人真实配置测试 | 完成：TS parser/owner、strict projection、原子发布和冲突恢复通过 |
| T012-B Credential Broker | 独立 credential 文件、set/keep/remove、exact-origin grant、原子发布 | secret 不进入日志、DTO、事件、前端和错误；路径、权限、并发和 endpoint 变更负例通过 | 完成：TS credentials owner、origin grant 和脱敏 readiness 通过 |
| T012-C readiness 与 probe | 纯本地 status projection；显式 provider/model/search/download/parse/analyze/browser probe | status 不联网；probe 有稳定 code、取消、预算与脱敏边界；真实访问只在明确授权下运行 | 完成：TS configuration probes 和 CLI tests 通过 |
| T044-A config TUI/非 TTY | TypeScript `sciretriever config`、`config status`、`config test` 入口 | 非 TTY、stdout/stderr 和退出码语义；Web/CLI 复用同一 command service | 完成：TS CLI/config center 提供非 TTY 命令；旧 80×24 过程保留为历史 oracle |
| T018/T044-B Application 接管 | 唯一 TS Configuration/Credential owner 注入 Network、Agents、Browser、MinerU 和 Analysis | 启动时无 Python 子进程；一个配置 writer；readiness 和运行对象使用同一快照 | 完成：createApplication 直接组装 TS owner |
| T061 配置 bridge 退役 | 删除 `entry/configuration_bridge.py` 及对应生产依赖，更新包和文档 | 安装包无 Python fallback；TS direct tests 和安装后旅程替代全部有效 bridge 测试语义 | 生产路径已退役；历史源码清理按 T061 处置记录执行 |

## 页面和命令范围

最终 TUI 保留当前产品已接受的一级入口：Models、Search、Download、Parse、Analyze、Browser、Status、Theme、Quit。Models 只保存 Provider 和 `provider/model`；Analyze 与 Browser 引用 Model；Search 与 Download 使用独立 Source 集合；Status 纯本地；只有显式 Test 可以访问外部服务。Web 若展示配置，只消费同一脱敏 command/result，不直接读文件或数据库。

## 实施顺序

1. 从 Python parser、配置模型、CLI 规格和合成 fixture 冻结有效/无效输入及发布结果。
2. 在 TypeScript 实现 parser、credential 和 command service，先完成离线差分。
3. 把 TUI、非 TTY CLI、Web projection 和 Application 全部切到同一 TS owner。
4. 运行相关 Vitest、`pnpm quick`、`pnpm full` 和无 Python 的安装后配置旅程。
5. Python oracle 按 T061 报告保留为历史材料，仅在明确授权下运行；生产运行路径始终只使用 TS owner，不允许两个 owner 同时写同一真实配置。

## 不增加的内容

不新增远程配置服务、多账户、配置历史数据库、第二份配置 schema 或自动读取历次已撤销配置。迁移命令只处理原始计划冻结的受支持基线，并提供预览、备份、原子发布和可恢复失败。
