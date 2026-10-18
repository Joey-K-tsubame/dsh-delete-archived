# dsh-delete-archived

删除 DeepSeek Harness 中**已归档对话**的插件。

[English](README.md)

## 功能

- **Host 侧**（`lib/entry.js`）：注册两条 HTTP 路由和一个 Agent 工具
  - `POST /plugin/dsh-delete-archived/delete` `{ "sessionId": "..." }`
  - `GET  /plugin/dsh-delete-archived/list`
  - 工具 `delete_archived_conversation(sessionId)`（供助手在对话中调用）
  - 删除逻辑：删除会话 JSONL 存储目录（`<DSH_HOME>/sessions/<project>/<sessionId>/`，全部格式代际），
    并从 workspace 注册表移除归档标记、置顶标记和每个工作区的会话记账；
    拒绝删除未归档或仍驻留在内存中的会话（防止下一次 flush 复活数据）。
- **Client 侧**（`lib/client.js`）：在侧边栏会话行 "..." 菜单里，**仅为已归档会话**增加
  “删除对话”菜单项（order 500，两步确认，失败内联提示）。

## 与 dsh-archived-chats 的区别

社区目录里已有 `dsh-archived-chats`，它同样能列出并永久删除已归档对话。本插件不重复实现该能力，
增量只有两点：侧边栏会话「...」菜单里**仅对已归档会话**出现的「删除对话」入口，以及供模型调用的
`delete_archived_conversation` 工具。只需要批量清理的话，`dsh-archived-chats` 是更小的依赖。

## 破坏性工具

`delete_archived_conversation` 是**模型可自行调用**的：助手不需要二次确认就能触发，删除会移除会话的
JSONL 目录和工作区登记，且不可恢复。侧边栏入口是需要人工两步确认的路径；请把这个工具当作自动化级能力，
不要放进你不希望它自行删除已归档会话的流程里。

## 行为说明

- 只允许删除**已归档**的会话；普通会话请先归档。
- 删除按会话串行执行；"宿主仍持有该会话"不作为拒绝理由——归档时 agent 已停止，
  宿主门禁 `ArchivedSessionGate` 拒绝继续执行，日志不再写入；响应里的 `heldAtDelete`
  只如实记录当时是否仍被持有。
- 会话搜索索引在本部署为 `:memory:`/`openAt: never`，无需清理；若部署启用了
  内容搜索，SQLite 后端会在下一次搜索时自动清除已消失会话的索引行。
- 内容寻址的图片附件可能被多个会话共享，本插件不做引用计数清理。

## 安装

```sh
# 本地目录（请先完全退出桌面端；--profile 为必填）
dsh plugin --profile <profile> add <本目录的绝对路径>

# GitHub 源码
dsh plugin --profile <profile> add github:<owner>/dsh-delete-archived
```

安装后重启 Harness 以组合新 bundle。本插件**零运行时依赖**、纯 JavaScript 直接发布，
因此从 GitHub 安装**无需** `allowBuilds` 的代码执行授权。

## 许可证

MIT
