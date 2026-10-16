# 01 正式服务与启动

Outcome：无需初始文献就能启动同源工作台，所有操作读取/调用同一配置绑定的业务服务。

进入条件：现有 Application、QueryApplication、ProcessingTaskService 合同，已授权生产实现。责任边界为 bootstrap/workbench、workbench HTTP/session、CLI 和中性视图合同；不修改业务事实所有权和 catalog schema。

- [x] 1.1 添加无选择的空闲视图，保留已选文章的控制版本和隔离；用直接合同/session 测试证明。
- [x] 1.2 接入 durable tasks 创建、读取、运行、控制以及固定启动库/能力状态；PDF 与 processing 使用原有 owner，保留已有 jobs 接口。
- [x] 1.3 同源复用 query/maintenance 路由及其完整功能，保留只读入口和安全检查；补元数据发现与书目导入薄适配。
- [x] 1.4 正式 CLI Web 入口不绕过配置 readiness/schema gate；生命周期关闭 app/query/HTTP 资源。

验证：任务和 HTTP 定向 Vitest，生产组装合成 home，来源/Host/CSRF 拒绝、缺库不初始化、结果重读和重启身份。退出条件是前端可使用稳定真实 API 并有直接服务测试。失败保留已有文件/库和诊断，不升级真实数据；恢复当前 HTTP 合同后继续 02。

当前实现已汇合到工作树；定向服务/Web 旅程与最终 Full 通过。分页、关闭竞态和跨文章草稿隔离已在 03 完成集成验收。日志索引：`/tmp/sciretriever-web-integration-20261013/`，额外执行者定向日志由各测试运行结果记录。
