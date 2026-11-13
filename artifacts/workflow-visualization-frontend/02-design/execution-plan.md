---
task_id: 2026-11-11-workflow-visualization-frontend
stage: TASK-02
author: 架构师
date: 2026-11-11
run_mode: auto
---

# 执行计划

以下两项任务使用固定接口约定及固定的 `frontend/README.md` 链接，可独立并行。目录白名单 `frontend/**` 表示独立客户端包的全部文件（含必要测试、锁文件、配置和文档），不允许修改同级后端。实现前先写行为测试并记录红灯证据，优先遵守仓库维护约定。开发协调者可写本阶段汇总并更新自己的状态，子开发者不改工作流状态。

```yaml
task_slug: workflow-visualization-frontend
parallel_tasks:
  - id: PT-01
    title: 独立 Vue 流程操作台与测试先行验证
    files_whitelist:
      - 'D:/github/agent-autoloop/frontend/**'
      - 'D:/github/agent-autoloop/artifacts/workflow-visualization-frontend/03-code/frontend-change-draft.md'
    pseudocode: |
      1. 先读本方案、需求、Vue 与 TypeScript 对应规范，核对现有接口，读取官方包注册信息确定兼容版本；不要并发安装根依赖。
      2. 创建独立包配置及行为测试，测试鉴权分离、错误、旧响应取消、分页合并及事实关联，跑出红灯；测试开头写失败方式。
      3. 实现带取消信号的 service/hub.ts、独立 types.ts、纯数据 model.ts、hooks/useConsole.ts；串行3秒刷新与手动刷新，断线显示陈旧。
      4. 创建 App 与 FlowOverview、ConnectionPanel、RunList、RunDetail、CardInbox、EventComposer，中文暖灰陶橙视觉，流程关系真实、窄屏堆叠且键盘可用。
      5. 对接回答、结案、停止、独立来源发送事件，提交时禁用重复动作，成功写入后独立反馈刷新失败，停止保留后端真实状态，凭据仅内存。
      6. 配置固定后端的开发/预览同源代理和静态部署 nginx 示例；README 写清启动、密钥、构建、自动刷新方式，禁止任意目标代理与 URL 密钥。
      7. 运行前端测试、类型检查、构建与覆盖 Vue/CSS 的格式检查；准备临时真实中台浏览器 fixture，记录命令、结果及限制到 frontend-change-draft.md。
    acceptance:
      - '独立包可安装、启动、构建，不更改根运行时依赖；版本有独立锁文件'
      - '流程总览、筛选与历史轮次详情使用真实 state/why，事项/卡片关系不靠猜测'
      - '回答、结案、停止、来源事件均使用正确端点和凭据，写请求不自动重发'
      - '定时刷新不覆盖新连接/新选择，不打断表单，分页数据不丢；失败有陈旧及恢复反馈'
      - '行为测试有先失败后通过记录，前端测试/类型检查/构建/格式检查均通过'
      - '提供临时真实中台验收入口，未连接页面不展示虚构的成功状态'
      - '桌面双栏和390像素窄屏均可操作，语义化按钮、可见焦点及纯文本资料显示'
  - id: PT-02
    title: 同步独立客户端的仓库边界、使用与安全说明
    files_whitelist:
      - 'D:/github/agent-autoloop/AGENTS.md'
      - 'D:/github/agent-autoloop/docs/protocol.md'
      - 'D:/github/agent-autoloop/docs/architecture.svg'
      - 'D:/github/agent-autoloop/README.md'
      - 'D:/github/agent-autoloop/README.en.md'
      - 'D:/github/agent-autoloop/INSTALL.md'
      - 'D:/github/agent-autoloop/skills/agent-autoloop/SKILL.md'
      - 'D:/github/agent-autoloop/SECURITY.md'
      - 'D:/github/agent-autoloop/.gitignore'
      - 'D:/github/agent-autoloop/.prettierignore'
      - 'D:/github/agent-autoloop/artifacts/workflow-visualization-frontend/03-code/documentation-change-draft.md'
    pseudocode: |
      1. 读取各目标文档，搜索无界面/没有总览/零依赖等边界与约定，尊重用户已确认的独立 frontend 客户端范围。
      2. 明确中台内核无页面或新调度、根包零运行时依赖，独立客户端经既有协议连接；只调整本次冲突约定，不改变旧协议。
      3. README 两种语言、INSTALL 和正式 SKILL 增加 frontend/README.md 入口、独立安装启动构建方式、开发代理固定目标及3秒刷新口径。
      4. SECURITY 说明本人密钥写权限、独立来源密钥、内存凭据、同源固定代理及 HTTPS 部署；事件文字仍仅是资料。
      5. 架构图在内核外的本人客户端位置标注独立流程操作台，不增加内核能力或删除现有插件关系。
      6. .gitignore 忽略 frontend/dist/；.prettierignore 排除 frontend/dist/ 和本地 artifacts/，其余源码继续按现有检查执行。
      7. 检索残留能力限制并核对链接、命令和图示，根格式检查与文档相关测试可由主协调统一运行；草稿写入本阶段目录。
    acceptance:
      - '协议、维护说明、两份README、INSTALL、SKILL、SECURITY和架构图表述一致'
      - '明确独立客户端与内核边界、本人/来源权限、固定同源代理及正式部署方式'
      - '未修改后端业务协议、现有测试预期或根依赖；未加入规则编辑或拖拽编排承诺'
      - '忽略构建产物及本地工作流资料的格式检查，源码仍参与检查，无无关格式变更'
```

## 自检记录

- 任务数 `2`，少于默认上限 `6` 及当前并发限制；白名单互斥：前端包与文档/根忽略文件无重叠。
- 每项伪代码 `7` 行，含可执行验收项。`frontend/**` 是绝对目录所有权，并非允许写其他项目。
- 没有业务 `API` 新增或修改，不需要专门接口文档任务；反向代理保持原有路径和语义。
- 开发任务不写 `04-e2e/`、`05-knowledge/` 正式产物；开发阶段草稿放 `03-code/`。
- 测试先行遵守仓库明确要求，因此本计划包含测试文件，不采用通用模板“测试全部留 TASK-04”的限制。
- 当前 `.git` 不存在；核对白名单采用实际文件路径及基线清单，不能依赖 `git diff`。
