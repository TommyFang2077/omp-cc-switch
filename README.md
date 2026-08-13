# omp-cc-switch

English | [中文](./README.zh-CN.md)

[omp](https://omp.sh) / [oh-my-pi](https://github.com/can1357/oh-my-pi) plugin that bridges [CC Switch](https://github.com/farion1231/cc-switch) providers into omp’s model registry.

## What it does

Two provider families:

| Family | Names | Behavior |
| --- | --- | --- |
| Proxy slots | `cc-claude`, `cc-codex` | Route through CC Switch local proxy (`127.0.0.1:15721`) to the *currently active* upstream. Only published when the local proxy is enabled. |
| Direct upstreams | `ccs-<app>-<slug>` | Connect straight to each CC Switch provider’s `baseUrl` + API key. Pick which ones to enable with `/cc-switch`. |

Selection is persisted in `~/.omp/agent/cc-switch-selections.json`. Sync also writes `~/.omp/agent/models.yml` and keeps `enabledModels` scoped to the bridged providers.

## Requirements

- [omp](https://omp.sh) (Bun-based) ≥ 17
- [CC Switch](https://github.com/farion1231/cc-switch) with a local DB at `~/.cc-switch/cc-switch.db`
- For `cc-claude` / `cc-codex`: enable CC Switch **local proxy** (`enableLocalProxy`)

## Install

### From GitHub (recommended)

```bash
omp plugin install github:TommyFang2077/omp-cc-switch
```

Pin a tag or commit:

```bash
omp plugin install github:TommyFang2077/omp-cc-switch#v1.0.0
```

### From a local checkout

```bash
git clone https://github.com/TommyFang2077/omp-cc-switch.git
omp plugin link ./omp-cc-switch
```

### npm (after publish)

```bash
omp plugin install omp-cc-switch
```

Restart omp after install. Verify with `/sync-models` or `omp plugin list`.

## Commands

| Command | Description |
| --- | --- |
| `/sync-models` | Rebuild `models.yml` from CC Switch DB + selection, register live |
| `/sync-models --dry-run` | Preview without writing |
| `/cc-switch` / `/ccs` | Interactive checkbox UI (seeded from last saved selection) |
| `/cc-switch list` | Show catalog + selection |
| `/cc-switch enable <slug>` | Enable a direct provider (all models) |
| `/cc-switch disable <slug>` | Disable a provider |
| `/cc-switch enable-all` / `disable-all` | Bulk toggle |
| `/cc-switch models <slug> <ids\|all>` | Restrict or reset models |
| `/cc-switch roles` | Interactive agent role → model picker (14 roles, grouped by provider) |

## Agent role configuration

omp's bundled agents (`reviewer`, `scout`, `designer`, `security-reviewer`, `librarian`) lack a `model: "@roleName"` frontmatter binding, so they fall back to `modelRoles.default` instead of their configured role model. This plugin fixes that in two ways:

1. **`/cc-switch roles`** — interactive three-level picker:
   - Level 1: pick a role (14 configurable roles with descriptions)
   - Level 2: pick a provider
   - Level 3: pick a model under that provider
   - Press `Esc` at any level to go back

2. **Automatic sync** — during `/sync-models`, `syncAgentModelOverrides()` mirrors `modelRoles` into `task.agentModelOverrides` in `config.yml`, so the harness model resolver routes subagents to their configured model instead of falling back to `default`.

### Configurable roles

| Role | Description |
| --- | --- |
| `default` | Main session and fallback |
| `task` | General-purpose multi-step subagent |
| `smol` | Fast lightweight — mechanical updates |
| `reviewer` | Code review — quality & security |
| `scout` | Read-only exploration & context compression |
| `designer` | UI/UX implementation |
| `security-reviewer` | Security audit & vulnerability discovery |
| `librarian` | External library/API research |
| `plan` | Implementation planning |
| `slow` | Deepest reasoning — hardest problems |
| `advisor` | Advice & strategy |
| `commit` | Commit message generation |
| `vision` | Screenshot & image analysis |
| `tiny` | Lowest cost — quick tasks |


## Privacy / trust

Direct providers write their real API keys into `~/.omp/agent/models.yml` in plaintext — same trust boundary as `~/.cc-switch/cc-switch.db`.

## Development

```bash
omp plugin link .
# edit src/index.ts, restart omp
omp plugin doctor
```

## License

MIT
