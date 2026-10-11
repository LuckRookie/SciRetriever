# 03 Browser 入口准备

状态：Completed。

## Outcome 与进入条件

有序文章入口在首次模型派发前由程序准备；当前入口明确失败时在同一逻辑任务预算内恢复。初始导航已下载文件则零模型；普通 HTTP 403/404 不成为 Browser 门槛。操作预算宽松但总时间、取消与平台政策有界。

进入条件：01 提供保留单 `start_url` 兼容的可选 `start_urls`；实际浏览器只在原Host/Network边界内导航。现有clock、候选收集、download挂起与平台准入仍为单一owner。

## Tasks 与边界

- [x] 3.1 扩展 delivery/admission 至有限且有序的入口集合，拒绝不合规值；首URL一致、去重含有效query，既有单URL调用兼容。
- [x] 3.2 在生产Host与flow中保留/恢复初始导航失败页面；只在首次模型dispatch前按明确失败切入口，不新建完整delivery/clock。正常挑战与未知HTML交给模型。
- [x] 3.3 在任何恢复前settle已有捕获，下载开始即使用原队列；重定向回已尝试入口有界停止，取消/迟到响应不作用于新页面。
- [x] 3.4 与Scheduler接线：候选导航只允许当前文献预先声明入口和模型前阶段，通过原平台permit/handoff，不因无committed source泛化放行。跨平台及同平台限流有直接测试。
- [x] 3.5 累计时间保持300秒，模型/动作默认100/200，保留5秒节奏；修改相应目标文档。测试较多正常交互、不变页面后恢复、真正重复循环、下载期不消耗页面预算。
- [x] 3.6 本地浏览器/fake模型集成覆盖初始404→DOI→文章、初始PDF零模型、挑战不误拒、同任务budget不重置、在途文件不丢以及首次模型后不自动换入口。

物理页面可能重建；逻辑文献ID、operation/generation、累计clock及失败历史不重建。不给模型任意URL导航能力，不增加专用网站页面规则。下载身份仍unverified。

## 验证、退出与恢复

```bash
pnpm exec vitest run apps/server/test/browser-article-session.test.ts apps/server/test/browser-article-flow.test.ts apps/server/test/browser-host*.test.ts apps/server/test/browser-scheduler*.test.ts --maxWorkers=4
```

退出条件：01入口在生产Host可消费，至少本地真实浏览器导航接线有证据；模拟模型测试只证明调度与数据完整性，不证明线上模型成功率。

失败时停止本篇新增导航，确认已开始下载与网络资源owner，保留可恢复候选和预算，不通过杀共享Browser影响其它文章。专项日志保存到临时目录并在此记录。

## 实施证据

2026-10-11 实现与定向验证完成；整体 Full 已通过，结果见 04 集成验收。

- 新增可选完整入口列表、精确模型前准备目标、可恢复初始导航失败以及实际导航去重；Scheduler 校验主文档 GET、当前内部目标、名单与实际模型调用计数，并继续沿用跨平台 drain/permit/cooldown。
- 默认 300 秒活跃时间、100 次模型调用、200 次动作与 5 秒节奏已接线。快照与工作台初次观察受同一活跃预算及取消约束；迟到句柄通过原 owner 幂等清理。
- 最终审查补齐初始化期间的捕获抢占：下载、验证或候选就绪直接交回同一执行器；未初始化完成禁止模型派发。下载失败后等待原初始化，并消耗剩余预算；同轮下载开始和失败也不会被异步观察漏掉。
- 最新 `browser-article-flow.test.ts` 98 项、`browser-document-admission.test.ts` 17 项，联合 115/115 通过；定向 ESLint、Prettier 与 diff 检查通过。
- 此前 session 11、navigation recovery 15、Host 19 通过；本地主机 Chromium 证明初始连接失败保留现场后可以合法导航备用页面，query 不进入对外观察。Root 联合 Browser/组装六文件 182 项通过时尚未加入最后 7 个初始化捕获用例，最终状态以 Full 为准。
- 授权 API 地址在最终 Browser 候选集合排除；明确目标版本入口优先于无版本的知名平台入口；两者在 application assembly 测试中有反例。
- 测试只有 fake 模型与 loopback Chromium，未访问真实出版社或使用真实机构权限；不由这些结果推断线上成功率。
