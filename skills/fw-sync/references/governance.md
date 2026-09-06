# 同步接口与验收边界

先识别用户指定的组件与仓库拓扑，再选择动作。目录名称和远端仓库名可以不同。

## 组件与参数

| 组件 | 默认远端 | 路径/目标覆盖 |
|---|---|---|
| `fwc`（旧别名 `fw`） | `https://github.com/fiofiogamestudio/fwc.git` | `-FwcPath / -FwcUrl / -FwcTarget` |
| `fwe` | `https://github.com/fiofiogamestudio/fwe.git` | `-FwePath / -FweUrl / -FweTarget` |
| `fwa` | `https://github.com/fiofiogamestudio/fwa.git` | `-FwaPath / -FwaUrl / -FwaTarget` |
| `fws` | `https://github.com/fiofiogamestudio/fws.git` | `-FwsPath / -FwsUrl / -FwsTarget` |

旧 `-FwPath / -FwUrl / -FwTarget` 是 FWC 参数别名。默认目标分支是 `main`；FWC 新接入的宿主目录仍默认为 `fw`，不会因仓库改名强制修改现有工程路径。

仓库目录名不证明远端已发布或本地提交已可获取；每次仍应核对真实 origin、目标引用与发布结果。已有工程保留旧路径时，按实际登记识别，不因仓库名称变化而重复接入。

- `-ProjectRoot`：独立组件仓库、含组件的目录，或宿主工程根。
- `-Component`：单个组件或 `all`；all 只处理已发现或用路径/URL/目标显式配置的组件，不等于安装全部产品。
- `-Fetch`：让 status 更新远端跟踪引用，不切换工作区；pull/push/verify 会自行 fetch。
- `-Json`：输出版本事实、操作与阻塞项。
- `-Apply`：执行已经审阅且获准的变更；无该参数时 new/pull/push 仅预演。

空工程使用 `new` 时必须明确组件。例如仅接入 FWC，选择 `-Component fwc`；不要求同时加入 FWE、FWA 或 FWS。

## 三种拓扑

- **独立仓库**：组件目录自身必须是 Git 根，不能把普通子目录误认成父仓库。检查当前分支、工作区和远端可获取性，无宿主 gitlink 要求。
- **容器中的独立仓库**：例如同目录下的 fwa/fws，各自发布与验证；外层目录有无 Git 不改变它们的独立性。
- **已登记 submodule**：检查 `.gitmodules`、宿主 HEAD/index 的 gitlink、组件 HEAD 和远端。宿主尚无首提交或新 gitlink 未提交时，verify 应报告未通过，而不是豁免。

输出 `repositoryMode` 与 `verificationScope` 标识实际验收对象；远端分支只是候选版本，不是宿主已经采用的版本。

## 动作

| 动作 | 约束 |
|---|---|
| status | 只读事实；Fetch 仅更新远端跟踪引用 |
| new | 预检路径、目标和远端后初始化所选组件；不覆盖已有无关目录；不提交宿主 |
| pull | 所选组件全部通过预检才推进；submodule 固定到精确目标，独立分支仅允许 fast-forward |
| push | 仅发布干净、非游离且已验证提交；正常快进到 origin 同名分支，不强推或顺带推其他标签 |
| verify | 独立仓库检查远端可获取性；submodule 还要求已提交宿主 gitlink 一致 |

不能在预检一个 fetch URL 后悄悄推到另一地址；存在不同 push URL、多推送目标或 mirror 配置时先报告并请求明确方案。

## 失败与交付

预检失败不移动工作树或发布，但 fetch 会更新跟踪引用，new 的提交目标探测也可能使用隔离临时 bare 仓库；预演不是磁盘零写入。目标和路径全部通过前，new 不创建宿主或初始化 Git。

运行期失败须报告已执行项；pull 尝试恢复本轮已移动的 HEAD/分支，成功恢复时仍报告操作失败且 partial=false。new/push 不承诺跨仓库事务；部分完成时输出 partial 与 recovery，不擅自删除新 clone 或强推撤销已发布提交。

Git 层通过后，再运行组件/宿主实际需要的生成、构建、测试及 smoke。新版本可能含 API 或数据合同迁移，不能只更新 gitlink 就称宿主升级完成。

最终分别报告：框架已发布、当前宿主已采用、其他工程已升级。没有逐个验证的工程，不声称已同步。
