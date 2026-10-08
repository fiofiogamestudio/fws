# 截图清单协议 v1

清单使用 UTF-8 JSON，图片路径相对该 JSON 所在目录。下例展示字段格式，图片必须换成实际采集文件；示例本身不是截图证据。

```json
{
  "schemaVersion": 1,
  "title": "My Game · UI 审阅",
  "project": "my-game",
  "run": {
    "id": "review-001",
    "capturedAt": "2026-10-07T08:00:00Z",
    "sourceRevision": "commit-or-build-id + working-tree evidence",
    "evidence": "本轮原生 Player 截图；隔离测试存档；操作记录见 capture.log"
  },
  "screenshots": [
    {
      "id": "cover-empty-1280x720",
      "number": 1,
      "title": "封面 · 无存档",
      "category": "封面",
      "path": "captures/cover-empty.png",
      "width": 1280,
      "height": 720,
      "viewport": {"width": 1280, "height": 720},
      "historical": false,
      "notes": "继续按钮禁用",
      "autoCheck": {"status": "safe", "summary": "已查看整张图：标题、按钮文字与角色素材完整，未见裁剪或遮挡；继续按钮呈禁用样式，未据此验证按钮行为。"},
      "state": {"save": "empty"},
      "evidence": "新建隔离存档 → 启动入口 → 等待封面资源完成"
    }
  ],
  "coverage": [
    {"id": "cover-empty", "title": "封面无存档", "status": "captured", "screenshotIds": ["cover-empty-1280x720"]},
    {"id": "online-lobby", "title": "联机大厅", "status": "blocked", "screenshotIds": [], "reason": "测试服务器不可用，尚未进入大厅"},
    {"id": "retired-shop", "title": "旧商店", "status": "excluded", "screenshotIds": [], "reason": "当前版本已删除此入口"}
  ]
}
```

## 字段与覆盖

- `title`、`project`、`run.id`、`run.capturedAt`、`run.evidence` 为必填非空字符串；`project` 使用稳定项目标识，`run.id` 遵守下述截图ID字符规则，时间使用带时区的ISO 8601格式。证据写清来源，不放凭据或玩家私人存档内容。`sourceRevision` 可选；脏工作区仅写 HEAD 不足以定位画面，可补相关输入摘要／构建标识。
- `screenshots` 可为空；`coverage` 至少一项。不能截图也可生成明确展示未覆盖项的报告。
- 每张图必填 `id`、`number`、`title`、`category`、`path`、`width`、`height`、`autoCheck`。`id` 以英文字母或数字开头，其余仅字母、数字、点、下划线、连字符；编号为唯一正整数，顺序不依赖数组位置。`number` 可跳号，已交付编号不重用。
- PNG必须是真实存在的文件，宽高为其像素尺寸；`viewport` 是可选采集上下文，可记录逻辑分辨率、DPR等。二者不必相同。路径不可绝对定位或穿出清单目录；符号链接也不能绕过范围。
- `historical` 表示已被替换或退役的截图，保留在数据中追溯，但不进入主审阅、待审阅导航或批量问题集合；主界面没有历史筛选开关。它不表示“不是本轮新拍”。仅整理已有截图时，可将该批采用的图片设为false，但必须用标题、run及逐图evidence说明原采集时间、版本或未知时效，不能称为最新构建证据。
- `notes` 为可选字符串；`state` 为可选 JSON 对象，记录有助复现的状态。`evidence` 为可选短字符串，用于逐图补充来源；没有时继承运行级证据。证据文字上限1000字符，详细操作日志单独保存。
- `coverage.id` 唯一；每项必填标题、状态、截图ID数组。captured必须引用当前非历史截图；每张当前图至少关联一项覆盖。blocked／excluded必须说明原因，不计已采集。历史截图可单独保留，不计当前完成率。
- 同一页面不同状态／尺寸可各自建立覆盖项，一个覆盖项也可引用多个补充截图。截图数、已覆盖项数、blocked及excluded分别报告；同一页面复制多张图不会增加完成率。

## AI 检查与人工审阅

`autoCheck` 来自采集过程中 AI 对真实画面的逐图查看，不是图片校验器的返回结果。`status` 仅允许 `safe`、`risk`、`error`，`summary` 必须为非空且不超过 500 字符的具体判断依据：

| 状态 | 显示 | 判断边界与示例 |
| --- | --- | --- |
| `safe` | 绿色／自认为无问题 | 已查看范围内未见问题，例如“标题与六个选项均完整，未见文字裁剪；只核对静态画面”。 |
| `risk` | 黄色／疑似问题 | 证据尚不足以确定，例如“底部返回文字似被暗层覆盖，需在过渡结束后复拍确认”。 |
| `error` | 红色／明确问题 | 画面已能确认，例如“第三张卡片说明越出边框，末行被裁去”。 |

不能仅因 PNG 存在、捕获成功或备注包含“正常／通过”等词就填 `safe`。旧图缺少检查时也要实际查看后补充，不能默认全绿。保留原 `notes` 和采集 `evidence`；自动检查不能覆盖这些原始信息，也不能据一张图推断玩法结算、输入或设备验证成功。

人工记录仍保存在 `review.json` 的 `annotations[id]` 中，状态为 `accepted`（通过）、`skipped`（跳过／待审阅）、`rejected`（不通过），没有记录时按 `skipped`。旧值 `unreviewed` 映射到 `skipped`，`issue` 映射到 `rejected`；旧备注原文保留。AI 状态不自动改变人工结论。

主审阅的三个筛选模块分别是 `category`、`autoCheck.status` 和人工状态。它们只影响浏览；复制当前单张 JSON 只含选中的那张图，批量问题 JSON 必须从**所有当前非历史截图**中计算：

```text
人工状态 != accepted && (autoCheck.status 为 risk/error || 人工状态 == rejected)
```

因此人工通过的红／黄图不再进批量问题；人工不通过的绿图要进入；缺省 `skipped` 的红／黄图也进入。模块或状态筛选不能使批量结果漏图。复制应保留截图身份、原始备注、AI 判断与人工记录，不能把整份清单误当当前单张，也不能把两个判断合成一个。

“跳过”是导航动作，不把当前 `accepted` 或 `rejected` 改回 `skipped`，也不删备注。按固定编号向后找下一个未决 `skipped` 项，到末尾循环；只有当前一个未决项时仍停留在它，全部已决才提示完成。历史图不参与这个循环。

## 输出与更新

协议的确定性校验、离线图库生成和固定 FWE 审阅后端均由 FWV 的 `ui` 工具维护；技能入口仅定位并调用它。FWV 导出将原始PNG字节复制到 `images/<number>-<id>.png`，输出清单记录SHA-256、原始路径及生成元数据。`coverage.json`按清单项统计采集比例；它不证明清单已穷尽源码入口，仍需执行者核对。

每次生成新输出目录，已有目录不覆盖。修订图库时，先从上一份清单复制：保留旧ID、编号及图片，将被替换图设为historical，再追加新图；相应覆盖项改为引用新图。重复使用同一图且来源没变时保留其原信息。若未重拍的图片来自旧构建，标明各自证据；不能据此宣称全库均为最新构建。

服务端备注存入输入清单同目录的 `review.json`，绑定清单 SHA-256，不能直接复制为另一份清单的备注文件。更新清单或迁移审阅环境前导出备注并保留旧集合；离线 HTML 的浏览器本地备注不保证跨浏览器／端口／目录共享。备注不是游戏状态，也不是自动修复指令；用户确认的问题再进入后续修改任务。
