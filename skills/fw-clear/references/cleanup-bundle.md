# Windows 一键清理包

盘点后把已审查、可清理的精确路径写入 manifest。扫描器输出只提供占用数据，不能直接把所有大目录导入删除计划。待确认的旧构建/日志、仍被消费的回放与美术输入、源文件、Git 和范围外归档不进入默认包；用户选定后才按其选择生成。

## 输入与生成

manifest 是 UTF-8 JSON，`roots` 固定工程授权范围，`targets` 只含被选择的子路径。每项必须有具体依据；进程条件按实际资源所有者配置。下面是格式示例，路径需换成当前工程，不能原样执行：

```json
{
  "schemaVersion": 1,
  "roots": ["D:/Projects/ExampleGame"],
  "targets": [
    {
      "path": "D:/Projects/ExampleGame/Library/Artifacts",
      "reason": "Unity 导入缓存，可由保留的 Assets 与工程配置重建",
      "processGuards": [
        {"processName": "Unity", "projectRoot": "D:/Projects/ExampleGame"}
      ]
    }
  ]
}
```

使用当前技能的真实路径定位工具；输出目录必须是新的目录，父目录已存在且没有重定向，放在所有清理目标之外：

```powershell
node <skill-directory>/scripts/create-cleanup-bundle.mjs --manifest <absolute-manifest.json> --out <absolute-new-bundle-directory>
```

生成器只封存计划和写执行包，不删除目标；无有效目标或检查失败时报告错误，不回退成宽泛清理。范围、重复/重叠路径、Git 文件与链接必须通过检查。元数据摘要用于检测封存后新增、删除、重命名或修改的文件，不是文件内容备份，也不证明候选没有运行用途。

包包含 `cleanup.bat`、`preview.bat`、`cleanup-plan.json`、`execute-cleanup.ps1` 和 `README.txt`。它可脱离 FWS 使用，运行端需要 Windows PowerShell 和 Git；整个目录保持在一起。目标路径作为 JSON 数据读取，不进入 cmd 命令，中文、空格和命令元字符不需要用户手动转义。BAT 和执行器不请求管理员权限、不关闭用户应用。

## 使用与验证

1. 生成后运行 `preview.bat`，核对实际范围、大小、活跃进程与阻断项；预览只读目标，可写本包内结果日志。检查任务在这里完成，交付清单、BAT 绝对路径与前置条件，不代为点击执行。
2. 用户双击 `cleanup.bat` 即执行计划的永久删除，无再次确认问题。agent 只有已有清理授权时才运行该入口；要求生成 BAT 不等于授权 agent 删除真实工程。
3. 执行器按精确 `LiteralPath` 操作，重新检查目标、授权根、祖先和子树链接、Git 与元数据快照。被对应进程使用、缺失或检查不通过的目标会保留并记录状态；其他仍有效的项可以继续。
4. 检查本包的结果日志、退出状态与目标是否实际消失。分别报告已删除、跳过、失败、逻辑字节与卷空闲变化；外部进程写入可能影响空闲差值。不要把预览、同盘移动或跳过称为已释放空间。

BAT 的窗口可在结束后保留结果供查看；这不是第二次删除许可。自动回归直接调用配套执行器，避免被末尾窗口停留阻塞。重复运行时已不存在的项照实跳过，不能扩到邻近目录。

最近一次结果写到 `cleanup-results.json` 和 `cleanup-results.log`，另按时间与 `preview`/`apply` 模式存档，后续预览不会覆盖历史清理记录。退出码 `0` 表示全部检查通过或删除成功，`2` 表示有跳过/失败项，`1` 表示计划无效或致命错误；是否执行过删除须看结果的 `mode`、逐项状态和 `removedLogicalBytes`，不能只看退出码。

目标变更或运行条件未满足时按日志原因处理。需要重新生成时先检查变化后的文件用途，再生成新的包；不擅自修改摘要、放宽路径或循环重试删除。生成/执行资料放本机报告目录，提交 skill 时只包含工具、说明和隔离测试，不提交任何真实工程删除计划或本机日志。
