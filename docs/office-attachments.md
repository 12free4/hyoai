# Office 附件实现与验收记录

## 实现

- 使用 `@firecrawl/anydoc-wasm` 0.2.4，在浏览器 Worker 中初始化并转换文档。
- 客户端延迟创建单个 Worker，按请求顺序处理文件，以 transferable ArrayBuffer 传递输入。Worker 故障或超时后拒绝当前请求，并重建 Worker 继续队列。
- 支持 Word、PowerPoint、Excel、OpenDocument 和 RTF。优先使用内容识别，无法识别时按扩展名回退。
- 接入 Composer 和消息编辑器的独立多选入口、普通文本入口、拖放和粘贴。解析期间显示文件计数并禁止提交。
- 结果沿用 `kind: "text"`，只保留 Markdown、原文件名和 MIME 等元数据。API、IndexedDB schema、数据库版本和迁移机制未修改。
- 输入限制 20 MiB，Markdown 输出限制 4 MiB，按 UTF-8 字节计数。拒绝空结果，保留 AnyDoc 错误码和页码信息；中、英、法提示覆盖成功和各类失败。

## 验证

| 项目                           | 结果                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| `npm run test:office`          | 15 项通过                                                   |
| `npm run test:storage`         | 46 项通过                                                   |
| `npm run test:storage:browser` | Chrome 中通过，包括页面刷新后恢复 Office 附件               |
| 默认生产构建                   | 通过；只包含正式页面                                        |
| TypeScript、ESLint             | 通过                                                        |
| `git diff --check`             | 通过                                                        |
| 开发模式 Worker/WASM           | 真实 DOCX 和格式样本通过                                    |
| 静态导出和 BASE_PATH           | 真实浏览器解析通过，WASM 路径包含前缀                       |
| 中、英、法界面                 | 菜单、处理状态、成功及损坏文件提示通过                      |
| 现有附件                       | 浏览器验证图片、音频读取、CSV 文本、PDF 文本和 PDF 图片模式 |
| API 与分块                     | 文本消息映射、语料、估算、章节规划及综合消息构建通过        |
| 持久化                         | 附件恢复、分支修改、移除、导出及再次导入通过                |
| 无视觉能力模型                 | Composer 和编辑器关闭视觉能力时 Office 流程通过             |
| 网络请求                       | Office 界面测试期间未观察到非读取网络请求                   |

浏览器测试页面和样本位于 `tests/office-probe`，正常构建不包含它们。运行和清理方法见该目录的 README。上游样本保留了来源和许可证。

## 验证边界

- DOCM、PPTM、PPSX、PPSM、XLSM 的扩展名映射和同容器改名样本已验证，尚未使用真实变体文件。
- API 和分块验证没有调用真实模型；不等同于模型回答质量验收。
- 浏览器测试模拟文件选择、拖放和粘贴事件，未人工操作系统文件选择对话框。
- 音频验证覆盖读取和 API 格式映射，没有验证音频播放或模型识别效果。
- 原有存储的双标签冲突、强制终止和系统级恢复等人工验收项仍以 `tests/README.md` 为准。

所有改动保留在工作区，未提交或推送。
