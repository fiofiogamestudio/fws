# 保留诊断日志，同时减少磁盘占用

失败现场有保留价值，不意味着必须一直以未压缩状态存放。对已结束任务的普通 `.log`，可单独评估 NTFS 原位压缩：保留路径、文件内容、修改时间和文件身份，应用仍按原路径读取。它不是删除，不改变逻辑容量，物理收益必须单列；不能把压缩前日志大小算成“又清掉了这么多”。

这是可选路径。先查任务已结束的 XML/退出标记和当前消费者，使用少量工程外样本评估收益。优先选择很少读取的历史诊断日志；不要为了这个功能扩大到源码、Git、当前流水线、整个目录或所有文件。读取压缩文件有解压开销。日期只用于排除近期/活跃文件，不是“日志不再需要”的证据。

## 精确清单与执行

[compress-logs.ps1](../scripts/compress-logs.ps1) 仅支持 Windows 本地 NTFS 上的普通 `.log` 文件，需要 Git 做所有权核对。输入为 UTF-8 JSON：

```json
{
  "schemaVersion": 1,
  "root": "D:/Projects/ExampleGame",
  "targets": [{
    "path": "D:/Projects/ExampleGame/output/completed-run/unity.log",
    "reason": "测试已退出，失败日志继续保留，仅减少磁盘分配",
    "evidence": ["同任务 results.xml 已有 end-time", "日志尾部有正常退出标记", "已核对当前任务不用此日志"]
  }]
}
```

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File <skill>/scripts/compress-logs.ps1 -Mode Plan -ManifestPath <manifest.json> -PlanPath <new-plan.json> -ResultPath <new-plan-result.json>
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File <skill>/scripts/compress-logs.ps1 -Mode Apply -PlanPath <plan.json> -ResultPath <new-apply-result.json>
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File <skill>/scripts/compress-logs.ps1 -Mode Restore -PlanPath <plan.json> -ResultPath <new-restore-result.json>
```

`Plan` 只读封存 SHA-256、长度、修改时间、文件身份、原压缩状态和实际分配量；计划和结果使用新文件，避免覆盖旧凭据。默认要求修改时间至少 24 小时以前，`-MinAgeHours` 只在 Plan 时设定并进入封存计划。先汇报具体范围与保存方式，沿用用户对该范围已有的空间优化授权；只有盘点要求时停在 Plan。

`Apply` 逐文件重新核对路径/祖先、Git index/HEAD、内容与身份，并取得独占句柄。正在使用、已变更、已压缩、链接/硬链接、稀疏/加密/离线/只读文件和源码目录中的日志均跳过。普通压缩通过 `FSCTL_SET_COMPRESSION` 完成，不使用 WOF/EXE 模式，不设置目录继承。每次状态改变后关闭写句柄，让 NTFS 结算尾部压缩单元，再重新检查祖先、取得独占句柄并复核哈希、长度、身份、修改时间与最终分配量；重新打开期间出现变化或占用即记录失败。没有实际分配量收益时撤销压缩并同样复核；失败或跳过明确记录，不能自动放宽校验重试。

`Restore` 按原计划验证仍是同一份内容后解除压缩，并检查剩余空间。它会重新占用磁盘；内容已变更时不强行恢复旧计划。永久保留压缩计划和执行记录，不能依赖临时目录作为唯一凭据。

## 计量和验证

报告 `savedAllocatedBytes` 与卷空闲前后值，同时列 `removedLogicalBytes: 0`、`removedFiles: 0`。卷空闲会受并行任务影响；逐文件分配量也不是整卷元数据成本。不能把压缩收益加进按逻辑总量计算的删除比例。

分配量读取同一句柄的 `FILE_STANDARD_INFO.AllocationSize`，标记为 `ntfs-file-standard-info-allocation`，不包含 MFT 或目录开销。`FILE_COMPRESSION_INFO.CompressedFileSize` 和 `GetCompressedFileSize` 在普通未压缩文件上可能返回逻辑长度，不能作为压缩前实际分配量。回归必须包含非簇对齐长度，避免整 MiB 样本掩盖统计错误；旧口径计划须重新封存。

先在工程外真实 NTFS 样本验证 Plan→Apply→Restore，以及 Git/链接/封存变化/活跃句柄保护，再执行已审查日志。真实执行后逐文件复查内容和路径；不要为了证明可逆就立刻把所有真实日志解压，隔离样本已验证恢复路径。

实现依据：[Windows 压缩控制](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_set_compression)、[文件分配信息](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_standard_info)、[未压缩文件的长度语义](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getcompressedfilesizew)。当前脚本仅接收不超过 30 GiB 的单文件。
