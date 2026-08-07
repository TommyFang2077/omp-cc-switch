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
