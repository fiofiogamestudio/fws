---
name: fw-sync
description: 接入、更新或发布 FWC/FWE/FWA/FWS 的 Git 版本，核对独立仓库与宿主 gitlink。用于明确的框架同步请求，不因仅提到框架名而触发。
---

# 框架版本同步

组件互相独立；只处理用户选中的组件，不因接入 FWC 自动安装编辑器、编排或技能库。

## 操作边界

- 先确认目录、分支、HEAD、origin，以及 staged/unstaged/untracked。独立仓库与 submodule 分开判断，目录名不等于仓库归属。
- 宿主已提交 gitlink、本地 HEAD、远端分支和显式目标是四种状态，不能混为“最新版本”。
- 只问状态或评估时只读；接入/更新授权不包含发布，提交/推送分别需要用户明确要求。
- 保护无关修改，拒绝脏组件、含糊目标和非快进发布；不强推，不覆盖用户工作区。

## 使用脚本

脚本位于本技能目录的 [scripts/fw-sync.ps1](scripts/fw-sync.ps1)，从实际技能位置调用，不假定它安装在固定个人目录。

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File <技能目录>/scripts/fw-sync.ps1 status -ProjectRoot <目录> -Component fwa -Fetch -Json
```

支持 `status / new / pull / push / verify`；变更动作默认只预演，检查计划后传 `-Apply`。
`-Component` 选择 `fwc / fwe / fwa / fws`；旧 `fw` 为 FWC 别名，`all` 只针对实际发现或明确配置的组件。
新空工程必须明确选择，不补齐整套依赖。独立仓库和宿主的具体参数与验收差异见 [同步细则](references/governance.md)，首次操作或拓扑不明时读取。

## 完成闭环

1. 检查版本事实、归类通用与宿主修改，并选择实际目标。存在归属歧义时先停，不把无关文件放进提交。
2. 接入/更新：预演 → 显式执行 → 按受影响工程生成、构建和测试 → 获准后提交宿主引用。
3. 发布：在组件中验证并精确提交 → 推送预演 → 正常 push → 核对远端可获取性。功能分支未合入 main 时明确说明。
4. 有真实依赖时先发布被依赖方；没有依赖不建立人为顺序。最后处理获准范围内的宿主 gitlink，不擅自升级其他工程。

脚本不是跨仓库事务：中途失败可能保留新 clone 或已发布提交，按报告核对已执行操作，不用删除或强推伪造整体回滚。
Git 验证不代替框架/宿主测试；无首提交的宿主不能宣称 gitlink 验收通过。

## 交付

给出组件、分支/提交、远端状态、实际验证及剩余问题。区分“已发布”“当前宿主已采用”“其他工程已升级”。
