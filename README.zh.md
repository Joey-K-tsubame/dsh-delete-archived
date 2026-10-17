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

## 行为说明

- 只允许删除**已归档**的会话；普通会话请先归档。
- 若会话仍加载在内存中（例如归档前正打开着），删除会被拒绝并提示重启应用后再删。
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
