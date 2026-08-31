# ADR 0018：固定用户级普通配置文件

- Status: Accepted
- Date: 2026-08-26
- Supersedes: none
- Superseded by: none
- Amends: none
- Amended by: [ADR 0021](0021-provider-model-registry-and-direct-task-selection.md)
- Related: [ADR 0014](0014-capability-scoped-providers-and-local-credentials.md)、[产品需求](../requirements.md)、[设计文档](../design.md)、[配置与凭据技术文档](../technical/configuration.md)、[配置手册](../../guides/configuration.md)

## 背景

普通配置此前可以来自程序内显式路径、`SCIRETRIEVER_CONFIG` 或当前工作目录已有的
`config.toml`，而交互配置中心在没有现存文件时把新文件写入当前目录。这个选择顺序虽然允许
同一进程运行多个配置，却把实际配置身份交给了启动目录和进程环境：用户从不同目录运行同一
命令可能得到不同数据库、Provider、Model、MinerU 或 Browser 设置；`config status` 与业务命令
也可能检查不同文件。用户必须先理解路径优先级，才能使用本应负责消除这种知识负担的配置中心。

文献 Provider、Model Provider 与远程 MinerU 的 secret 已经固定在
`~/.sciretriever/credentials.toml`；Browser Profile、binary/runtime 状态也由同一个用户级
Configuration 边界管理。普通配置继续跟随当前目录既没有项目级继承语义，也没有 workspace
合同，只形成第二套隐式身份。

## 决策

### 1. 生产只有一个普通配置文件

正常安装、CLI、Entry 和 Bootstrap 只从当前用户主目录下的固定文件读取普通配置：

```text
~/.sciretriever/config.toml
```

`sciretriever.configuration` 是路径规则的唯一 owner。CLI 不提供 `--config`，不读取
`SCIRETRIEVER_CONFIG`，不自动发现当前目录或项目根 `config.toml`，也不在缺失时 fallback 到
其它文件。当前工作目录不参与配置身份；所有正常命令和 `config status/test` 读取同一个文件。

程序内显式 `load_configuration(path)` 可以继续作为解析一个明确 TOML 文档的底层能力，用于
离线验证和内部事务，但它不是生产配置选择规则，Entry/Bootstrap 不得使用它选择第二份配置。
`home` 依赖注入只用于 Configuration 内部边界和隔离测试；它不形成 CLI、环境变量或用户可选择
的文件名。

### 2. CLI 管理和人工编辑操作同一文件

裸 `sciretriever config` 始终显示并管理固定普通配置文件；目标不存在时，首页仍可打开，首次
确认的配置修改在固定位置创建目录和文件。仅仅查看或退出配置中心不产生空文件。

CLI 是推荐管理入口，但不是私有格式：用户可以直接创建或编辑同一个 UTF-8 TOML 文件。普通
配置仍只保存非 secret 设置，并继续严格拒绝未知 section、字段和不一致值；文献 Provider、
Model Provider、远程 MinerU secret 继续只进入独立的 `credentials.toml`。两个文件同目录不改变各自 schema、
所有权或显示边界。

### 3. 用户目录与发布边界

`~/.sciretriever/` 是当前用户的私有运行目录：必须是当前用户拥有、非符号链接的真实目录且
权限为 `0700`。`config.toml` 与 `credentials.toml` 都必须是当前用户拥有、单硬链接、非符号
链接的普通文件且权限为 `0600`。普通配置不因此成为 secret 文件；严格权限用于保证与凭据和
Profile 共处的目录具有单一、可审计的安全合同。

读取继续有界、no-follow 并在同一 descriptor 上复核文件身份；CLI 编辑保留未修改 section 和
注释，通过同目录 staging、完整解析校验、`fsync` 和原子替换发布。目录或文件缺失、不安全、
格式错误或读取期间变化必须形成稳定、无配置值的错误。测试使用系统临时目录中的隔离 home，
不得读取真实用户文件。

### 4. 旧配置由用户显式迁移

旧的当前目录文件和 `SCIRETRIEVER_CONFIG` 目标不会被自动读取、复制、移动或删除，也不建立
过渡 fallback。用户在确认固定目标尚无配置后，显式把需要保留的普通配置复制或合并到
`~/.sciretriever/config.toml`，再把目录和文件权限设为 `0700`/`0600`，随后通过
`sciretriever config status` 检查本地状态。

不自动迁移是为了避免从多个候选来源中猜测哪一份才是用户意图，也避免一次普通命令静默写入
用户主目录。迁移说明属于 README/配置手册；程序不保存“已迁移”状态或旧路径。

## 结果

- 用户从任意目录运行 SciRetriever 都获得同一数据库、Provider、Models、MinerU 和 Browser
  配置，配置中心无需解释路径优先级；
- 普通配置、secret、Browser Profile 与 runtime 都有明确的用户级根目录，但仍按文件和 owner
  分离责任；
- 依赖旧环境变量或项目目录配置的脚本必须显式迁移，这是 pre-v1 的公开行为变化；
- 离线测试通过临时 home 验证生产对象图，不再为测试保留产品兼容入口。

## 不采用

- 同时保留环境变量、当前目录和用户级文件的多层优先级；
- 自动扫描当前目录、仓库根、历史环境变量目标并猜测迁移来源；
- 在每个项目中生成独立配置，或增加 workspace/global 合并语义；
- 把普通配置字段或 secret 合并进同一个 TOML；
- 为测试保留生产 `SCIRETRIEVER_CONFIG`；
- 仅在 Entry 中硬编码路径，让 Configuration 不再拥有文件身份和发布规则。
