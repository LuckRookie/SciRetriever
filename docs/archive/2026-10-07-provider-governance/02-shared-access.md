# 02：按服务政策共享网络准入

Outcome：真实 HTTP 请求按服务额度组执行并发、最小启动间隔与窗口限制，取消和关闭不遗留等待者。

进入条件：01 的服务身份与政策声明稳定。责任边界：Network 只解释中性调度合同；供应商产品识别由生产适配边界提供。

- [x] 2.1 扩展 Budget 的中性间隔/窗口合同，使用注入时钟直接证明窗口边界、跨 host 共享 quota、取消与关闭。
- [x] 2.2 元数据与 PDF 请求选择服务级 scope；CORE 等共享组共同计数，Elsevier Search/Abstract/Article 产品独立。
- [x] 2.3 普通网页直链按实际目的地选择政策，跨站重定向重新准入；429/Retry-After 反馈作用于当前额度组。

集成：不移除既有响应大小、DNS、凭据 origin 和重试上限。未知服务使用标明为项目默认的政策；官方规则取自现有 Notes 的具名依据，不猜账户额度。验证：network-budget、network-http-diagnostics、metadata transport、授权下载及回环重定向测试。退出：实际生产 transport 使用新调度，不能只有独立 limiter 测试。恢复：计数只在进程内，不新增持久状态；失败保留原始错误和已发布材料。

执行记录（2026-10-07）：当前工作树相对 HEAD `dd2df24` 的治理差异；目录/网络最终定向回归 4 文件 42 项通过，之前下载/配置直接组 3 文件 44 项及集成组 8 文件 56 项通过。日志在 `/tmp/sciretriever-provider-governance-20261007/` 的 `review-regression.log`、`targeted-2.log`、`integration.log`。真实 Provider 未调用；全量验收由 03 负责。
