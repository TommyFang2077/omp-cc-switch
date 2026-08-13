# omp-cc-switch

[English](./README.md) | 中文

[omp](https://omp.sh) / [oh-my-pi](https://github.com/can1357/oh-my-pi) 插件：把 [CC Switch](https://github.com/farion1231/cc-switch) 的供应商目录桥接到 omp 的模型注册表。

## 功能

两类 provider：

| 类型 | 名称 | 行为 |
| --- | --- | --- |
| 代理槽位 | `cc-claude`、`cc-codex` | 经 CC Switch 本地代理（`127.0.0.1:15721`）路由到**当前激活**的上游。仅在本地代理开启时发布。 |
| 直连上游 | `ccs-<app>-<slug>` | 直连各 CC Switch provider 的 `baseUrl` + API key，绕过代理。用 `/cc-switch` 选择启用哪些。 |

选择状态保存在 `~/.omp/agent/cc-switch-selections.json`。同步时还会写入 `~/.omp/agent/models.yml`，并把 `enabledModels` 限制在桥接的 provider 范围内。

## 依赖

- [omp](https://omp.sh)（基于 Bun）≥ 17
- [CC Switch](https://github.com/farion1231/cc-switch)，本地数据库位于 `~/.cc-switch/cc-switch.db`
- 若使用 `cc-claude` / `cc-codex`：需在 CC Switch 中开启**本地代理**（`enableLocalProxy`）

## 安装

### 从 GitHub 安装（推荐）

```bash
omp plugin install github:TommyFang2077/omp-cc-switch
```

固定版本或提交：

```bash
omp plugin install github:TommyFang2077/omp-cc-switch#v1.0.0
```

### 本地仓库

```bash
git clone https://github.com/TommyFang2077/omp-cc-switch.git
omp plugin link ./omp-cc-switch
```

### npm（发布到 npm 后）

```bash
omp plugin install omp-cc-switch
```

安装后请重启 omp。可用 `/sync-models --dry-run` 或 `omp plugin list` 验证。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/sync-models` | 根据 CC Switch 数据库与选择重建 `models.yml`，并注册到当前会话 |
| `/sync-models --dry-run` | 仅预览，不写入 |
| `/cc-switch` / `/ccs` | 交互勾选界面（从上次保存的选择恢复 ✔） |
| `/cc-switch list` | 显示目录与当前选择 |
| `/cc-switch enable <slug>` | 启用某个直连 provider（全部模型） |
| `/cc-switch disable <slug>` | 禁用某个 provider |
| `/cc-switch enable-all` / `disable-all` | 批量开关 |
| `/cc-switch models <slug> <ids\|all>` | 限制或重置模型列表 |
| `/cc-switch roles` | 交互式 agent 角色 → 模型选择器（14 个角色，按 provider 分组） |

## Agent 角色模型配置

omp 内置的 agent（`reviewer`、`scout`、`designer`、`security-reviewer`、`librarian`）缺少 `model: "@roleName"` frontmatter 绑定，会回退到 `modelRoles.default` 而非各自配置的模型。本插件通过两种方式修复：

1. **`/cc-switch roles`** — 交互式三级选择器：
   - 第一级：选择角色（14 个可配置角色，带中文描述）
   - 第二级：选择 provider
   - 第三级：选择该 provider 下的模型
   - 任意级别按 `Esc` 返回上一级

2. **自动同步** — `/sync-models` 时 `syncAgentModelOverrides()` 把 `modelRoles` 镜像写入 `config.yml` 的 `task.agentModelOverrides`，使 harness 模型解析器按配置路由 subagent，不再回退到 `default`。

### 可配置角色

| 角色 | 说明 |
| --- | --- |
| `default` | 默认模型 — 主会话及未指定角色的兜底 |
| `task` | 通用任务 — 多步骤实施子代理 |
| `smol` | 快速轻量 — 机械更新与数据采集 |
| `reviewer` | 代码审查 — 质量与安全分析 |
| `scout` | 快速探索 — 只读代码搜索与上下文压缩 |
| `designer` | UI/UX — 设计实现与视觉优化 |
| `security-reviewer` | 安全审计 — 漏洞发现与风险评估 |
| `librarian` | 库研究 — 外部库/API 源码考证 |
| `plan` | 规划 — 实施计划与方案设计 |
| `slow` | 深度推理 — 最强模型处理复杂判断 |
| `advisor` | 顾问 — 建议与策略分析 |
| `commit` | 提交 — 生成 commit 消息 |
| `vision` | 图像理解 — 截图与图片分析 |
| `tiny` | 极简 — 最低成本快速任务 |


## 隐私与信任边界

直连 provider 会把真实 API key **明文**写入 `~/.omp/agent/models.yml`，信任域与 `~/.cc-switch/cc-switch.db` 相同。

## 开发

```bash
omp plugin link .
# 编辑 src/index.ts 后重启 omp
omp plugin doctor
```

## 许可

MIT
