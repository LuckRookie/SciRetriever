# 01：供应商和服务的唯一声明

Outcome：配置、能力展示和生产组装从同一个目录读取供应商事实；服务具有明确覆盖范围与凭据要求。

进入条件：用户授权治理，ADR 0014 保持 Metadata/Acquisition 独立接口。责任边界：configuration 静态定义，metadata/acquisition 协议与具体候选生成。

- [x] 1.1 建立供应商及服务定义，保存 endpoint、能力、认证字段、范围、quota group、政策依据；保留配置键与 Auto 顺序。
- [x] 1.2 替换配置解析、CLI、registry、生产 assembly 的重复列表和 URL；移出授权 PDF 的供应商条件分支，按服务声明评估强证据。
- [x] 1.3 覆盖只返回全文线索、真正 PDF 来源和未实现来源的区别；以实际消费者验证一致性。

集成：不改普通配置文件格式、不启用已有 Key 对应的未选服务。验证：目录测试、source-locator-routing、acquisition-public-sources、configuration-boundary、metadata-assembly。退出：生产者/消费者使用相同声明。恢复：保留已有 adapter 和数据格式，不能通过删除旧测试掩盖兼容性错误。

执行记录（2026-10-07）：当前工作树相对 HEAD `dd2df24` 的治理差异；目录/网络最终定向回归 4 文件 42 项通过，之前下载/配置直接组 3 文件 44 项及集成组 8 文件 56 项通过。日志在 `/tmp/sciretriever-provider-governance-20261007/` 的 `review-regression.log`、`targeted-2.log`、`integration.log`。真实 Provider 未调用；全量验收由 03 负责。
