# FWS — FW Skills

独立维护、验证和分发开发技能。不运行游戏，不编排 agent，也不自动安装整个 FW 产品家族。

| 仓库 | 职责 |
|---|---|
| FWC | Godot＋C# 框架代码及权威规范 |
| FWE | 可选编辑器 |
| FWA | 开发任务编排 |
| FWS | 可独立使用的技能及必要辅助脚本 |

FWC 仓库改名不代表宿主 `fw/` 路径、`fw.toml`、`fw` CLI、`Fw.*` 类型或数据协议改名。

独立仓库：[FWC](https://github.com/fiofiogamestudio/fwc)、[FWE](https://github.com/fiofiogamestudio/fwe)、[FWA](https://github.com/fiofiogamestudio/fwa)、[FWS](https://github.com/fiofiogamestudio/fws)。仅选用需要的组件。

## 技能

| 名称 | 用途 | 旧名称 |
|---|---|---|
| `fw-sync` | 显式选择组件，接入/更新/发布并核实 Git 版本 | 不变 |
| `fw-commit` | 按真实意图精确分批提交 | `git-atomic-commits` |
| `fw-refine` | 评估与高收益打磨，回归复评并及时停止 | `refine-existing-work` |
| `fw-debug` | 查实具体问题，获准后最小修复 | `verify-bug-before-fixing` |
| `fw-code` | 按 FWC/宿主规范维护代码及生成合同 | 项目技能 `fw` |

技能唯一源在 `skills/`。`fw-code` 读取所选工程的规范，不在 FWS 复制代码规范；FWC 不需要 FWS 才能生成、构建或运行。
几个技能可以按实际任务组合，但不要求先加载一个公共“总控技能”。

## 本地安装

需要 Node.js 20.10.0 以上，无第三方 npm 依赖。FW 同步脚本另需 Git 与 PowerShell；FWS 其他技能不因而依赖它们。

先 clone 本库到固定位置，再指定**当前客户端实际使用**的技能目录。此工作站沿用 `C:\Users\kaiji\.codex\skills`；其他环境可选择其已配置的用户或项目发现目录，避免在两处重复安装。

```powershell
node tools/install.mjs --target C:/Users/kaiji/.codex/skills
node tools/install.mjs --target C:/Users/kaiji/.codex/skills --apply --migrate-legacy
```

- 默认仅预演；`--apply` 才写入，`--migrate-legacy` 明确允许备份并迁移已识别的同名/旧名技能。
- 安装采用目录链接：Windows junction、其他系统 symlink，更新本库即更新唯一源。
- 用 `--skill fw-debug` 只安装一个；可重复该参数。默认选择全部 catalog。
- 旧目录先备份到发现根之外的同级目录；工具输出准确路径。不删除原稿、不改官方内置/插件技能。
- 全部目标先预检；冲突、异常路径或正在进行的协作安装会阻止写入。中途失败尝试回滚并保留可检查证据。
- 不能移动或删除本库后还期待链接有效。迁移本库时，先核对旧链接，再重新安装。

安装后运行 check，并在新会话或客户端技能列表核对名称。文件和链接存在不等于当前已开始的会话即时刷新；若未出现，重启客户端再检查。

### 恢复

备份不会自动清理。恢复时先确认输出报告中的目标与备份，移除**本次安装的链接本身**，再将对应备份目录移回原名；不要递归删除链接目标或用整目录覆盖恢复。安装中断留下的锁，应在确认没有安装进程后再处理。

## 验证

```powershell
npm.cmd run verify
npm.cmd run test:sync
```

`check` 验证 catalog、入口元数据、UI 名称与引用；Node 测试验证安装预演、冲突、备份、幂等与失败恢复；同步测试使用 OS 临时目录中的模拟 Git 远端，不接触生产仓库。

结构检查和脚本回归不证明自然语言决策正确。[行为用例](evals/README.md) 单独覆盖触发、授权、任务比例和停止判断，语义验收不能用关键词正则冒充。

## 维护与发布

- 仅维护用户自己的技能，不重命名系统或插件技能。
- 优先保留短入口与关键边界；只有条件分支确实需要时才增加 references 或 scripts。
- 同时更新目录名、frontmatter、UI prompt、catalog 和用例，不留两个常驻入口同时匹配同一职责。
- 修改后跑相关验证；同步脚本或安装器变动必须有真实隔离回归。
- 提交/push 需用户授权，推送前核对打包文件集合，`reports/`、缓存和本机日志不得混入。公开 Git 仓库不等于 npm 发布或变更许可证。

本库保持 `private: true`（禁止意外 npm publish）及 `UNLICENSED`；Git 仓库可见性独立管理。
