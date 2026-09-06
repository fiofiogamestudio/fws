# Unity 核查表

只读当前问题相关类别，以真实工程状态为准。

## 数据与资源

- 用内容 ID、配置键、Prefab/Scene 引用和 `.meta` GUID 确认对象，不按显示名推断同一性。
- 追踪默认值、Inspector、ScriptableObject、表格、存档、Mod、运行时覆盖和回退；确认最终生效来源。
- 区分 Resources、Addressables、序列化引用、动态加载和对象池路径。存在文件不代表当前路径使用它。
- 找到生成器及输入，不手改生成输出或凭猜测忽略不可重建资产。

## Prefab 与场景

- 区分原件、Variant、Scene override、嵌套 Prefab 与运行时实例。
- 核对脚本 GUID、丢失引用、组件与对象启用状态，以及 Awake/OnEnable/Start 是否覆盖序列化值。
- 保留既有 GUID 和用户 override，不为局部字段问题重建资产。

## UI 与坐标

- 沿父链检查 anchors、pivot、sizeDelta、scale、布局组件和裁剪；可见边框未必就是裁剪边界。
- 确认 world/screen/Canvas local 空间、Canvas 模式、相机、缩放、安全区及 reparent 时机。
- 文本测量与渲染应使用相同字体/fallback、富文本、字号和换行约束；列表还需核对 viewport、content 与布局更新时间。

## 生命周期与状态

- 按实际顺序核对创建、启用、绑定、事件、异步回调、禁用、销毁和回池。
- 检查重复订阅、过期回调、未取消协程/Tween，以及池对象状态是否完整重置。
- 区分显示、逻辑与持久化状态，确认权威来源、提交时机与合法状态转换。
- 同一内容在实体、预览、Tooltip、结算中不一致时，分别追踪实例 ID、基础数据、动态修改和各自渲染路径。
- 修改 delay 后看起来正常，不足以证明时序根因已解决。

## Editor 与构建

- 比较平台宏、开发/发布构建、资源裁剪、Addressables catalog、脚本后端和初始化差异。
- GM/调试功能区分入口可见、权限判断和真实执行效果。
- 批处理测试需要实际结果文件和有效统计；Editor 或构建通过不能代替 Player、PlayMode 或视觉验收。
