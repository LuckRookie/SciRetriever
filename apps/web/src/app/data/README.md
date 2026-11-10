# React 应用的数据协作

这里保存应用视图使用的 HTTP 适配、查询编排与本机偏好，不持有文献事实，也不直接访问 catalog 或原始资产文件。

`citations.ts` 通过传入的 `query` 客户端分页读取既有 `references` 合同，返回固定范围内的引用或种子文献的一跳入/出邻居。节点和边只来自本地 catalog 的已确认关系。`in_scope: false` 表示不在当前选中范围，不能显示为“库外文献”。HTTP、CLI、MCP 合同不变。

默认 40 页、160 节点、400 边是可配置的界面读取/显示界限。结果同时携带种子覆盖、每个方向的总数/游标、范围过滤数和截断原因；它不代表全库引用统计或完整关系快照。分页采用轮转，取消和失败不修改调用方范围。用户可以选中邻居后再次调用以继续展开，不自动递归遍历全库。

[上级目录](../README.md) · [Web 源码](../../README.md)

`api.ts` / `query.tsx` 管理既有 HTTP 适配和共享查询生命周期，`url.ts` 解析及同步可后退的视图状态，`preferences.ts` 访问可恢复的本机偏好，`library.ts` 提供受合同校验的文献读取。`sources.ts` 重新导出框架无关的固定来源解析。`processor-results.ts` 使用有界分页完整读取已发布处理结果，验证范围、连续性、字节数与内容 hash；它不接纳或改写结果，不将 result ID 当作知识 artifact ID。

Browser 的轮询读取不会覆盖请求期间已经接纳的推送或操作回执。登录过期、工作台 grant 被另一标签重登录撤销、启动 Cookie 失效时，工作台保留原 URL 进入既有认证恢复；有效登录 Cookie 可自动返回并申请新的 grant。

`wire.ts` 保存通用 JSON 读取边界，`tasks.ts` 保存任务详情投影与状态/范围标签，`candidate-status.ts` 依据真实 publication/operation terminal 形成候选状态文字；这些都不创建 DOM 或改变业务事实。

`intake.ts` 读取发现与书目导入的实际回执，将接纳/匹配/逐项处置计数和完成/部分/失败状态投影给界面；HTTP 成功不等同于业务成功，原回执保留供技术详情查看。

`devices.ts` 与 `imports.ts` 读取设备连接与导入会话的版本化接口结果，给出用途、状态与会话来源的界面名称；`api.call` / `api.send` 是这类 `{protocol_version, request}` 接口的 JSON 与原始字节调用。

偏好只读写当前 React 命名空间，包含主题、两侧栏宽、默认阅读字号/行宽、动效及按库保存的筛选。按 Owner 的单一界面决定，旧键读取回退和一次迁移已经删除，不扫描、搬迁或删除旧前端存储，更不复制其它应用数据或凭据。

`library.ts` 提供快速筛选计数；`folders.ts` 管理目录树、成员与显式最近阅读记录（读取查询不隐式写历史）；`snapshots.ts` 解析快照名称及改名回执；`actors.ts` 提供操作者显示投影；`agent-conversation.ts` 按数据库游标读取原始会话事件；`reading-status.ts` 解析块来源和人工修改；`processor-spec.ts` 与 `processor-checks.ts` 提供处理规范、六种核对状态及按篇计数的共享合同。它们只做协议适配，组件展示由调用方负责。
