# 项目规则

## 修改前必读

- 先读取 [项目知识库](project-kb/index.md) 和待修改文件对应的 [代码知识](project-kb/code/index.md)。
- 当前正式研发版本为 `1.3`；`workplace/1.1`、`workplace/1.2` 和归档仅作为历史证据，不作为源码或测试入口。
- 生产前端位于 `app/`，服务端入口为 `server.mjs`，服务模块位于 `server/`，正式测试位于根 `test/`。
- 保留工作树中不属于当前任务的改动；禁止修改真实 `data/`、`logs/` 和外部 Agent 数据库。

## 实现约束

- 使用现有 Next.js、Node.js、WebSocket、node-pty、React 和 SQLite 技术栈；架构变更以已确认的 1.3 技术方案为准。
- 关键业务逻辑和复杂条件必须使用中文注释解释原因；简单赋值和直接调用不需要逐行注释。
- 精准修改，不重构无关代码；新增行为先写能复现缺口的测试，再做最小实现和回归。
- Python 依赖优先使用 `uv`；本仓库的确定性维护脚本可直接使用其既定运行方式。
- 仅允许本地 Git 操作，禁止推送远程仓库。

## 验证命令

- `npm test`：运行根 `test/` 下的正式 Vitest 测试。
- `npm run lint`：检查当前生产源码、配置和根测试，不检查研发文档与历史归档。
- `npm run build`：执行 Next.js 生产构建。
- `npm run verify`：串行执行 test、lint 和 build。

浏览器主流程和性能验证由 Playwright 任务补齐；在对应脚本落地前不得用 build 代替功能验收。
