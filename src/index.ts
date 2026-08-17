/**
 * omp-cc-switch — bridges CC Switch's provider catalog into omp's model registry.
 *
 * Two provider families are published:
 *
 *  1. Proxy slots — `cc-claude` / `cc-codex` — route through CC Switch's local
 *     proxy (127.0.0.1:15721) to the *currently active* upstream per app slot.
 *     Model ids are role aliases (opus/sonnet/haiku/fable) that the proxy
 *     rewrites to the active upstream's real model. Published only when the
 *     local proxy is enabled (or `publishProxySlots: true` in selections).
 *
 *  2. Direct upstreams — `ccs-<app>-<slug>` — connect straight to each CC Switch
 *     provider's own baseUrl + apiKey, bypassing the proxy so many providers
 *     are reachable at once. The user picks which providers and which models to
 *     enable via `/cc-switch`; the selection persists in cc-switch-selections.json.
 *
 * Commands:
 *   /sync-models           rebuild models.yml from DB + selection, register live
 *   /cc-switch [args]      manage the direct-provider selection (alias /ccs)
 *     (no args)            interactive checkbox list — cached selection shows ✔
 *                          Enter opens model picker (pre-checked from cache)
 *                          `✔ 完成并同步` commits
 *     list                 show catalog + current selection
 *     enable <slug>        enable a provider (all its models)
 *     disable <slug>       disable a provider
 *     enable-all           enable every direct provider
 *     disable-all          disable every direct provider
 *     models <slug> <ids>  restrict a provider to comma-separated model ids
 *     models <slug> all    reset a provider to all models
 *     roles                interactive agent role → model picker (reviewer, scout,
 *                          designer, security-reviewer, librarian, etc.)
 *
 * NOTE: direct providers write their real API key into models.yml (plaintext,
 * same trust boundary as ~/.cc-switch/cc-switch.db and ~/.omp/agent/agent.db).
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderConfig,
  ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";
import { inferBridgedThinking } from "./thinking.ts";
import {
  ccSwitchPaths,
  isManagedBridgeProvider,
  isUsableSecret,
  SOURCE_ID,
  splitModelRoleValue,
  writeSecureFile,
} from "./util.ts";

// ─── shared types ───────────────────────────────────────────────────────────

type ProviderSettings = {
  env?: Record<string, unknown>;
  auth?: { OPENAI_API_KEY?: unknown };
  config?: string;
  modelCatalog?: {
    models?: Array<{ model?: unknown; displayName?: unknown; contextWindow?: unknown }>;
  };
  options?: { baseURL?: unknown; apiKey?: unknown };
  models?: Record<string, unknown> | Array<{ id?: unknown; name?: unknown; context_length?: unknown }>;
  transport?: unknown;
  api_key?: unknown;
  api_mode?: unknown;
  base_url?: unknown;
  default_model?: unknown;
  model?: unknown;
};

/** What we render to YAML and register. */
type RenderedProvider = {
  name: string;
  api: string;
  baseUrl: string;
  apiKey: string;
  authHeader?: boolean;
  disableStrictTools?: boolean;
  models: ProviderModelConfig[];
};

/** A CC Switch provider parsed into a direct omp provider candidate. */
type DirectProvider = {
  slug: string;
  appType: string;
  ccName: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  authHeader: boolean;
  disableStrictTools: boolean;
  models: ProviderModelConfig[];
};

type Selection = { enabled: boolean; models: string[] };
type SelectionFile = { version: 1; providers: Record<string, Selection>; publishProxySlots?: boolean };

/** A direct provider paired with the models its selection enabled. */
export interface SelectedProvider {
  provider: DirectProvider;
  models: ProviderModelConfig[];
}

/** Snapshot built from the DB + selection file, consumed by sync and load. */
export interface BuiltProviders {
  proxy: RenderedProvider[];
  direct: DirectProvider[];
  selected: SelectedProvider[];
}

// ─── constants ───────────────────────────────────────────────────────────────

const PATHS = ccSwitchPaths();
const DB_PATH = PATHS.db;
const CCS_SETTINGS_PATH = PATHS.settings;
const MODELS_YML = PATHS.modelsYml;
const CONFIG_YML = PATHS.configYml;
const SELECTIONS_PATH = PATHS.selections;
const DEFAULT_PROXY_HOST = "127.0.0.1";
const DEFAULT_PROXY_PORT = 15721;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const CLAUDE_ALIASES = [
  { id: "opus", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL" },
  { id: "sonnet", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL" },
  { id: "haiku", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL" },
  { id: "fable", envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL" },
] as const;

const CLAUDE_MODEL_ENV = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_MODEL",
] as const;

const VALID_SUBS = new Set(["list", "enable", "disable", "enable-all", "disable-all", "models", "roles"]);

/** Control row that commits the interactive checkbox selection. */
const DONE_OPTION = "✔ 完成并同步";

/** Agent roles configurable via /cc-switch roles. */
const CONFIGURABLE_ROLES: ReadonlyArray<{ role: string; label: string; desc: string }> = [
  { role: "default", label: "default", desc: "默认模型 — 主会话及未指定角色的兜底" },
  { role: "task", label: "task", desc: "通用任务 — 多步骤实施子代理" },
  { role: "smol", label: "smol", desc: "快速轻量 — 机械更新与数据采集" },
  { role: "reviewer", label: "reviewer", desc: "代码审查 — 质量与安全分析" },
  { role: "scout", label: "scout", desc: "快速探索 — 只读代码搜索与上下文压缩" },
  { role: "designer", label: "designer", desc: "UI/UX — 设计实现与视觉优化" },
  { role: "security-reviewer", label: "security-reviewer", desc: "安全审计 — 漏洞发现与风险评估" },
  { role: "librarian", label: "librarian", desc: "库研究 — 外部库/API 源码考证" },
  { role: "plan", label: "plan", desc: "规划 — 实施计划与方案设计" },
  { role: "slow", label: "slow", desc: "深度推理 — 最强模型处理复杂判断" },
  { role: "advisor", label: "advisor", desc: "顾问 — 建议与策略分析" },
  { role: "commit", label: "commit", desc: "提交 — 生成 commit 消息" },
  { role: "vision", label: "vision", desc: "图像理解 — 截图与图片分析" },
  { role: "tiny", label: "tiny", desc: "极简 — 最低成本快速任务" },
];

// ─── db helper ───────────────────────────────────────────────────────────────

function openDb(): Database {
  if (!existsSync(DB_PATH)) throw new Error(`找不到 CC Switch 数据库：${DB_PATH}`);
  const db = new Database(DB_PATH, { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

function resolveProxyRoot(db?: Database): string {
  const owned = db ?? openDb();
  const closeAfter = !db;
  try {
    const row = owned
      .query("SELECT listen_address, listen_port FROM proxy_config WHERE app_type = 'claude' LIMIT 1")
      .get() as { listen_address?: string; listen_port?: number } | null;
    const host = row?.listen_address?.trim() || DEFAULT_PROXY_HOST;
    const port = row?.listen_port ?? DEFAULT_PROXY_PORT;
    return `http://${host}:${port}`;
  } finally {
    if (closeAfter) owned.close();
  }
}

function makeModel(
  id: string,
  api: string,
  contextWindow: number,
  options?: { name?: string; maxTokens?: number; disableStrictTools?: boolean },
): ProviderModelConfig {
  const thinking = inferBridgedThinking(id, api);
  return {
    id,
    name: options?.name ?? id,
    reasoning: true,
    ...(thinking ? { thinking } : {}),
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow,
    maxTokens: options?.maxTokens ?? Math.min(contextWindow, 128_000),
    ...(options?.disableStrictTools ? { compat: { disableStrictTools: true } } : {}),
  };
}

// ─── proxy-slot logic (active upstream per app slot) ────────────────────────

function readActiveSettings(db: Database, appType: string): { name: string; settings: ProviderSettings } {
  const row = db
    .query("SELECT name, settings_config FROM providers WHERE app_type = ? AND is_current = 1 LIMIT 1")
    .get(appType) as { name?: string; settings_config?: string } | null;
  if (!row?.settings_config) throw new Error(`CC Switch 槽位 ${appType} 没有激活的 provider`);
  return { name: row.name ?? appType, settings: JSON.parse(row.settings_config) as ProviderSettings };
}

function codexModels(settings: ProviderSettings, api: string): ProviderModelConfig[] {
  return (settings.modelCatalog?.models ?? []).flatMap((entry) => {
    if (typeof entry.model !== "string" || !entry.model) return [];
    const contextWindow =
      typeof entry.contextWindow === "number" && entry.contextWindow > 0
        ? entry.contextWindow
        : /\[1m\]/i.test(entry.model) ? 1_000_000 : 300_000;
    return [makeModel(entry.model, api, contextWindow, {
      name: typeof entry.displayName === "string" ? entry.displayName : entry.model,
    })];
  });
}

function claudeModels(settings: ProviderSettings): ProviderModelConfig[] {
  const env = settings.env ?? {};
  return CLAUDE_ALIASES.flatMap(({ id, envKey }) => {
    const target = env[envKey];
    if (typeof target !== "string" || target.length === 0) return [];
    const contextWindow = /\[1m\]/i.test(target) ? 1_000_000 : 200_000;
    return [makeModel(id, "anthropic-messages", contextWindow, {
      name: `${id} -> ${target}`,
      maxTokens: Math.min(contextWindow, id === "haiku" ? 64_000 : 128_000),
      disableStrictTools: true,
    })];
  });
}

/**
 * Whether CC Switch's local proxy is configured to serve 127.0.0.1:15721.
 * `cc-claude` / `cc-codex` are unusable when this is false — requests fail with
 * "Connection error." because nothing listens on the proxy port.
 */
function isLocalProxyEnabled(): boolean {
  try {
    if (existsSync(CCS_SETTINGS_PATH)) {
      const settings = JSON.parse(readFileSync(CCS_SETTINGS_PATH, "utf8")) as { enableLocalProxy?: unknown };
      if (settings.enableLocalProxy === false) return false;
      if (settings.enableLocalProxy === true) return true;
    }
  } catch {
    /* fall through to DB */
  }
  try {
    const db = openDb();
    try {
      const row = db
        .query(
          "SELECT COUNT(*) AS n FROM proxy_config WHERE app_type IN ('claude', 'codex') AND (proxy_enabled = 1 OR enabled = 1)",
        )
        .get() as { n?: number } | null;
      return (row?.n ?? 0) > 0;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** Publish proxy slots unless explicitly disabled, or auto-skip when proxy is off. */
function shouldPublishProxySlots(selections: SelectionFile): boolean {
  if (selections.publishProxySlots === false) return false;
  if (selections.publishProxySlots === true) return true;
  return isLocalProxyEnabled();
}

/** Proxy slot providers — route to the active upstream via CC Switch local proxy. */
function collectProxySlots(): RenderedProvider[] {
  const db = openDb();
  try {
    const proxyRoot = resolveProxyRoot(db);
    const providers: RenderedProvider[] = [];
    for (const [slot, name] of [["claude", "cc-claude"], ["codex", "cc-codex"]] as const) {
      try {
        const active = readActiveSettings(db, slot);
        const api = slot === "claude" ? "anthropic-messages" : "openai-responses";
        const models = slot === "claude" ? claudeModels(active.settings) : codexModels(active.settings, api);
        if (models.length === 0) continue;
        providers.push({
          name,
          api,
          baseUrl: slot === "claude" ? proxyRoot : `${proxyRoot}/v1`,
          apiKey: "PROXY_MANAGED",
          disableStrictTools: slot === "claude",
          authHeader: slot === "codex",
          models,
        });
      } catch {
        /* skip empty/unconfigured slot */
      }
    }
    if (providers.length === 0) {
      throw new Error("CC Switch 代理槽位目录为空：cc-claude / cc-codex 均无可用模型");
    }
    return providers;
  } finally {
    db.close();
  }
}

// ─── direct-catalog logic (every provider, bypassing the proxy) ─────────────

function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return cleaned.length > 0 ? cleaned : "unnamed";
}

/**
 * Strip CC Switch's context-window suffix from a model id. `[1M]`/`[1m]` is a
 * proxy-only annotation telling CC Switch's local proxy to request the
 * long-context variant; direct upstreams reject the bracketed id (e.g. Zhipu
 * returns HTTP 400 "模型不存在" for `glm-5.2[1M]`). Returns the clean wire id
 * plus the context window the suffix implied.
 */
function stripContextSuffix(rawId: string, fallback = 200_000): { id: string; contextWindow: number } {
  const m = /\[(1m)\]$/i.exec(rawId);
  if (m) return { id: rawId.slice(0, m.index), contextWindow: 1_000_000 };
  return { id: rawId, contextWindow: fallback };
}


/** Parse the first `base_url = "..."` under any `[model_providers.*]` section. */
function parseCodexBaseUrl(configToml: string): string | undefined {
  const m = /\[model_providers\.[^\]]+\][\s\S]*?base_url\s*=\s*["']([^"']+)/.exec(configToml);
  return m?.[1];
}

/** Resolve the wire api declared under the active `[model_providers.*]` section. */
function parseCodexWireApi(configToml: string): "openai-responses" | "openai-completions" {
  const m = /\[model_providers\.[^\]]+\][\s\S]*?wire_api\s*=\s*["']([^"']+)/.exec(configToml);
  return m?.[1] === "chat" ? "openai-completions" : "openai-responses";
}

function distinctStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v === "string" && v.length > 0 && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function extractClaudeDirect(name: string, settings: ProviderSettings, appType = "claude"): DirectProvider | null {
  const env = (settings.env ?? {}) as Record<string, unknown>;
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : "";
  const apiKey =
    (typeof env.ANTHROPIC_AUTH_TOKEN === "string" && env.ANTHROPIC_AUTH_TOKEN) ||
    (typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY) ||
    "";
  const rawIds = distinctStrings(CLAUDE_MODEL_ENV.map((k) => env[k]));
  if (!baseUrl || !isUsableSecret(apiKey) || rawIds.length === 0) return null;
  const api = "anthropic-messages";
  const byCleanId = new Map<string, ProviderModelConfig>();
  for (const raw of rawIds) {
    const { id, contextWindow } = stripContextSuffix(raw);
    const candidate = makeModel(id, api, contextWindow, { disableStrictTools: true });
    const prev = byCleanId.get(id);
    if (prev && prev.contextWindow >= candidate.contextWindow) continue;
    byCleanId.set(id, candidate);
  }
  const models: ProviderModelConfig[] = [...byCleanId.values()];
  if (models.length === 0) return null;
  const slugPrefix = appType === "claude-desktop" ? "ccs-claude-desktop" : "ccs-claude";
  return {
    slug: `${slugPrefix}-${slugify(name)}`,
    appType,
    ccName: name,
    baseUrl,
    apiKey,
    api,
    authHeader: false,
    disableStrictTools: true,
    models,
  };
}

function extractCodexDirect(name: string, settings: ProviderSettings): DirectProvider | null {
  const apiKey = typeof settings.auth?.OPENAI_API_KEY === "string" ? settings.auth.OPENAI_API_KEY : "";
  const configToml = typeof settings.config === "string" ? settings.config : "";
  const baseUrl = parseCodexBaseUrl(configToml);
  if (!isUsableSecret(apiKey) || !baseUrl) return null;
  const api = parseCodexWireApi(configToml);
  const catalogIds = distinctStrings((settings.modelCatalog?.models ?? []).map((m) => m.model));
  const topModel = /\nmodel\s*=\s*["']([^"']+)/.exec(configToml)?.[1];
  const modelIds = catalogIds.length > 0 ? catalogIds : distinctStrings([topModel]);
  if (modelIds.length === 0) return null;
  const ctxById = new Map<string, number>();
  for (const m of settings.modelCatalog?.models ?? []) {
    if (typeof m.model === "string" && typeof m.contextWindow === "number") ctxById.set(m.model, m.contextWindow);
  }
  const byCleanId = new Map<string, ProviderModelConfig>();
  for (const rawId of modelIds) {
    const { id, contextWindow: suffixWindow } = stripContextSuffix(rawId, 300_000);
    const catalogWindow = ctxById.get(rawId);
    const contextWindow =
      typeof catalogWindow === "number" && catalogWindow > 0 ? catalogWindow : suffixWindow;
    const candidate = makeModel(id, api, contextWindow);
    const prev = byCleanId.get(id);
    if (prev && prev.contextWindow >= candidate.contextWindow) continue;
    byCleanId.set(id, candidate);
  }
  const models: ProviderModelConfig[] = [...byCleanId.values()];
  if (models.length === 0) return null;
  return {
    slug: `ccs-codex-${slugify(name)}`,
    appType: "codex",
    ccName: name,
    baseUrl,
    apiKey,
    api,
    authHeader: true,
    disableStrictTools: false,
    models,
  };
}

function mapHermesApi(transport: unknown, apiMode: unknown): { api: string; authHeader: boolean } {
  const mode = typeof apiMode === "string" ? apiMode : typeof transport === "string" ? transport : "";
  if (mode === "anthropic" || mode === "anthropic_messages") {
    return { api: "anthropic-messages", authHeader: false };
  }
  if (mode === "codex_responses" || mode === "responses") {
    return { api: "openai-responses", authHeader: true };
  }
  if (mode === "chat_completions" || mode === "chat") {
    return { api: "openai-completions", authHeader: true };
  }
  return { api: "openai-completions", authHeader: true };
}

function extractHermesDirect(name: string, settings: ProviderSettings): DirectProvider | null {
  const apiKey = typeof settings.api_key === "string" ? settings.api_key : "";
  const baseUrl = typeof settings.base_url === "string" ? settings.base_url : "";
  if (!baseUrl || !isUsableSecret(apiKey)) return null;
  const { api, authHeader } = mapHermesApi(settings.transport, settings.api_mode);
  const catalog = Array.isArray(settings.models) ? settings.models : [];
  const modelIds =
    catalog.length > 0
      ? catalog.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const id = (entry as { id?: unknown }).id;
          return typeof id === "string" && id.length > 0 ? [id] : [];
        })
      : distinctStrings([settings.default_model, settings.model]);
  if (modelIds.length === 0) return null;
  const byCleanId = new Map<string, ProviderModelConfig>();
  for (const rawId of modelIds) {
    const entry = catalog.find((e) => e && typeof e === "object" && (e as { id?: unknown }).id === rawId) as
      | { context_length?: unknown }
      | undefined;
    const fallbackCtx = typeof entry?.context_length === "number" && entry.context_length > 0 ? entry.context_length : 200_000;
    const { id, contextWindow } = stripContextSuffix(rawId, fallbackCtx);
    const candidate = makeModel(id, api, contextWindow, {
      disableStrictTools: api === "anthropic-messages",
    });
    const prev = byCleanId.get(id);
    if (prev && prev.contextWindow >= candidate.contextWindow) continue;
    byCleanId.set(id, candidate);
  }
  const models = [...byCleanId.values()];
  if (models.length === 0) return null;
  return {
    slug: `ccs-hermes-${slugify(name)}`,
    appType: "hermes",
    ccName: name,
    baseUrl,
    apiKey,
    api,
    authHeader,
    disableStrictTools: api === "anthropic-messages",
    models,
  };
}

function extractGeminiDirect(name: string, settings: ProviderSettings): DirectProvider | null {
  const env = settings.env ?? {};
  const apiKey = typeof env.GEMINI_API_KEY === "string" ? env.GEMINI_API_KEY : "";
  const baseUrl = typeof env.GOOGLE_GEMINI_BASE_URL === "string" ? env.GOOGLE_GEMINI_BASE_URL : "";
  if (!baseUrl || !isUsableSecret(apiKey)) return null;
  const api = "google-generative-ai";
  const models = [
    makeModel("gemini-2.5-pro", api, 1_000_000),
    makeModel("gemini-2.5-flash", api, 1_000_000),
  ];
  return {
    slug: `ccs-gemini-${slugify(name)}`,
    appType: "gemini",
    ccName: name,
    baseUrl,
    apiKey,
    api,
    authHeader: false,
    disableStrictTools: false,
    models,
  };
}

function extractOpencodeDirect(name: string, settings: ProviderSettings): DirectProvider | null {
  const baseUrl = typeof settings.options?.baseURL === "string" ? settings.options.baseURL : "";
  const apiKey = typeof settings.options?.apiKey === "string" ? settings.options.apiKey : "";
  const modelIds = Object.keys(settings.models ?? {});
  if (!baseUrl || !isUsableSecret(apiKey) || modelIds.length === 0) return null;
  const api = "openai-completions";
  const byCleanId = new Map<string, ProviderModelConfig>();
  for (const rawId of modelIds) {
    const { id, contextWindow } = stripContextSuffix(rawId, 200_000);
    const candidate = makeModel(id, api, contextWindow, { maxTokens: 128_000 });
    const prev = byCleanId.get(id);
    if (prev && prev.contextWindow >= candidate.contextWindow) continue;
    byCleanId.set(id, candidate);
  }
  const models = [...byCleanId.values()];
  if (models.length === 0) return null;
  return {
    slug: `ccs-opencode-${slugify(name)}`,
    appType: "opencode",
    ccName: name,
    baseUrl,
    apiKey,
    api,
    authHeader: true,
    disableStrictTools: false,
    models,
  };
}

/** Read every CC Switch provider that can be reached directly. */
function collectDirectCatalog(): DirectProvider[] {
  const db = openDb();
  try {
    const rows = db
      .query("SELECT id, name, app_type, settings_config FROM providers ORDER BY app_type, sort_index, name")
      .all() as { id: string; name: string; app_type: string; settings_config: string }[];
    const out: DirectProvider[] = [];
    const usedSlugs = new Set<string>();
    for (const row of rows) {
      let settings: ProviderSettings;
      try {
        settings = JSON.parse(row.settings_config) as ProviderSettings;
      } catch {
        continue;
      }
      let provider: DirectProvider | null = null;
      if (row.app_type === "claude" || row.app_type === "claude-desktop") {
        provider = extractClaudeDirect(row.name, settings, row.app_type);
      } else if (row.app_type === "codex") {
        provider = extractCodexDirect(row.name, settings);
      } else if (row.app_type === "opencode") {
        provider = extractOpencodeDirect(row.name, settings);
      } else if (row.app_type === "gemini") {
        provider = extractGeminiDirect(row.name, settings);
      } else if (row.app_type === "hermes") {
        provider = extractHermesDirect(row.name, settings);
      }
      if (!provider) continue;
      let slug = provider.slug;
      let n = 2;
      while (usedSlugs.has(slug)) {
        slug = `${provider.slug}-${n++}`;
      }
      usedSlugs.add(slug);
      provider.slug = slug;
      out.push(provider);
    }
    return out;
  } finally {
    db.close();
  }
}

// ─── selection persistence ──────────────────────────────────────────────────

function loadSelections(): SelectionFile {
  if (!existsSync(SELECTIONS_PATH)) return { version: 1, providers: {} };
  try {
    const raw = JSON.parse(readFileSync(SELECTIONS_PATH, "utf8")) as Partial<SelectionFile>;
    if (raw && raw.version === 1 && raw.providers && typeof raw.providers === "object") {
      return { version: 1, providers: raw.providers, publishProxySlots: raw.publishProxySlots };
    }
  } catch {
    // fall through to empty
  }
  return { version: 1, providers: {} };
}

function saveSelections(file: SelectionFile): void {
  const tmp = `${SELECTIONS_PATH}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(tmp, SELECTIONS_PATH);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp never written */
    }
    throw error;
  }
}

/** Resolve which models a selection enables; empty `models` means all. */
function enabledModelsFor(provider: DirectProvider, sel: Selection | undefined): ProviderModelConfig[] {
  if (!sel?.enabled) return [];
  if (!sel.models || sel.models.length === 0) return provider.models;
  const wanted = new Set(sel.models);
  return provider.models.filter((m) => wanted.has(m.id));
}

/** Filter the full direct catalog down to the selected, enabled providers. */
function selectedDirectProviders(catalog: DirectProvider[], selections: SelectionFile): SelectedProvider[] {
  const out: SelectedProvider[] = [];
  for (const provider of catalog) {
    const models = enabledModelsFor(provider, selections.providers[provider.slug]);
    if (models.length > 0) out.push({ provider, models });
  }
  return out;
}

// ─── YAML render + write ────────────────────────────────────────────────────

function renderProvider(indent: string, name: string, p: RenderedProvider): string[] {
  const lines: string[] = [`${indent}${name}:`];
  lines.push(`${indent}  baseUrl: ${JSON.stringify(p.baseUrl)}`);
  lines.push(`${indent}  apiKey: ${JSON.stringify(p.apiKey)}`);
  if (p.authHeader) lines.push(`${indent}  authHeader: true`);
  if (p.disableStrictTools) lines.push(`${indent}  disableStrictTools: true`);
  lines.push(`${indent}  api: ${p.api}`);
  lines.push(`${indent}  models:`);
  for (const m of p.models) {
    lines.push(`${indent}    - id: ${JSON.stringify(m.id)}`);
    lines.push(`${indent}      name: ${JSON.stringify(m.name)}`);
    lines.push(`${indent}      reasoning: ${m.reasoning}`);
    if (m.thinking?.efforts) {
      lines.push(`${indent}      thinking:`);
      lines.push(`${indent}        mode: ${JSON.stringify(m.thinking.mode)}`);
      lines.push(`${indent}        efforts: [${m.thinking.efforts.map((e) => JSON.stringify(e)).join(", ")}]`);
    }
    lines.push(`${indent}      input: [${m.input.join(", ")}]`);
    lines.push(`${indent}      contextWindow: ${m.contextWindow}`);
    lines.push(`${indent}      maxTokens: ${m.maxTokens}`);
  }
  return lines;
}

function renderModelsYml(proxy: RenderedProvider[], direct: SelectedProvider[]): string {
  const lines: string[] = [
    "# CC Switch 模型桥。由 omp-cc-switch 生成，请勿手工编辑。",
    "#",
    ...(proxy.length > 0
      ? [
          "# 两类 provider：",
          "#   cc-claude / cc-codex —— 走 CC Switch 本地代理（按槽位路由到当前激活上游）",
          "#   ccs-<app>-<slug>     —— 直连 CC Switch 各 provider 的上游（绕过代理，可同时启用多个）",
        ]
      : [
          "# 仅直连 provider（ccs-<app>-<slug>），不走 CC Switch 本地代理。",
          "# 用 /cc-switch 选择启用哪些 provider 与模型。",
        ]),
    "# 直连 provider 的 API key 以明文写入本文件，信任域与 ~/.cc-switch/cc-switch.db 相同。",
    "providers:",
  ];
  for (const p of proxy) lines.push(...renderProvider("  ", p.name, p));
  for (const { provider, models } of direct) {
    lines.push(...renderProvider("  ", provider.slug, {
      name: provider.slug,
      api: provider.api,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      authHeader: provider.authHeader,
      disableStrictTools: provider.disableStrictTools,
      models,
    }));
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function writeModelsYml(content: string): void {
  writeSecureFile(MODELS_YML, content, 0o600);
}

// ─── registration ───────────────────────────────────────────────────────────

function syncBridgeProviders(
  register: (name: string, config: ProviderConfig) => void,
  unregister: (name: string) => void,
  listProviders: () => Iterable<string>,
  providers: RenderedProvider[],
): string[] {
  const target = new Set(providers.map((p) => p.name));
  const droppedProviders: string[] = [];
  for (const name of new Set(listProviders())) {
    if (!isManagedBridgeProvider(name)) continue;
    if (!target.has(name)) {
      unregister(name);
      droppedProviders.push(name);
    }
  }
  for (const p of providers) {
    register(p.name, toProviderConfig(p));
  }
  return droppedProviders;
}

function toProviderConfig(p: RenderedProvider): ProviderConfig {
  const cfg: ProviderConfig = {
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    api: p.api as ProviderConfig["api"],
    models: p.disableStrictTools
      ? p.models.map((m) => ({ ...m, compat: { ...m.compat, disableStrictTools: true } }))
      : p.models,
  };
  if (p.authHeader) cfg.authHeader = true;
  return cfg;
}

function directToRendered({ provider, models }: SelectedProvider): RenderedProvider {
  return {
    name: provider.slug,
    api: provider.api,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    authHeader: provider.authHeader,
    disableStrictTools: provider.disableStrictTools,
    models,
  };
}

/** Build proxy + selected-direct providers from the DB and selection file. */
function buildAll(): BuiltProviders {
  const selections = loadSelections();
  const proxy = shouldPublishProxySlots(selections) ? collectProxySlots() : [];
  const direct = collectDirectCatalog();
  const selected = selectedDirectProviders(direct, selections);
  return { proxy, direct, selected };
}

// ─── commands ───────────────────────────────────────────────────────────────

function summarize(catalog: DirectProvider[], selections: SelectionFile): string {
  if (catalog.length === 0) return "（CC Switch 没有可直连的 provider）";
  return catalog
    .map((p) => {
      const sel = selections.providers[p.slug];
      const on = sel?.enabled ?? false;
      const modelCount = on ? enabledModelsFor(p, sel).length : p.models.length;
      const modelPart = on ? `${modelCount}/${p.models.length} 模型` : `${p.models.length} 模型`;
      return `  [${on ? "x" : " "}] ${p.slug.padEnd(30)} ${p.appType.padEnd(8)} ${p.ccName}  (${modelPart})`;
    })
    .join("\n");
}

/** Trailing action in the per-provider model checkbox list. */
const MODELS_DONE = "✔ 确认模型";
const MODELS_DISABLE = "✘ 禁用此 provider";

/**
 * Checkbox model picker seeded from the cached selection.
 * - empty `models` in the cache means "all models"
 * - returns `null` on cancel (Esc)
 * - returns `{ enabled: false }` when the user picks disable
 * - returns `{ enabled: true, models }` on confirm (`models=[]` means all)
 */
async function pickModels(
  ctx: ExtensionCommandContext,
  provider: DirectProvider,
  initial: Selection | undefined,
): Promise<Selection | null> {
  if (provider.models.length === 0) return { enabled: true, models: [] };
  if (provider.models.length === 1) return { enabled: true, models: [] };

  // Seed checked set from cache: empty list = all models previously enabled.
  const checked = new Set<string>();
  if (initial?.enabled) {
    const prev = initial.models ?? [];
    if (prev.length === 0) {
      for (const m of provider.models) checked.add(m.id);
    } else {
      for (const id of prev) {
        if (provider.models.some((m) => m.id === id)) checked.add(id);
      }
    }
  }

  let cursor = 0;
  for (;;) {
    const checkedIndices: number[] = [];
    const options = provider.models.map((m, i) => {
      if (checked.has(m.id)) checkedIndices.push(i);
      const mark = checked.has(m.id) ? "✔" : " ";
      return {
        label: m.id,
        description: `${mark} ${m.contextWindow.toLocaleString()} ctx`,
      };
    });
    options.push({ label: MODELS_DONE, description: "保存该 provider 的模型勾选" });
    if (initial?.enabled) {
      options.push({ label: MODELS_DISABLE, description: "从启用列表中移除" });
    }

    const choice = await ctx.ui.select(
      `${provider.slug}（已缓存 ${checked.size}/${provider.models.length} 个模型）`,
      options,
      {
        selectionMarker: "checkbox",
        checkedIndices,
        markableCount: provider.models.length,
        initialIndex: Math.min(cursor, options.length - 1),
        helpText: "up/down 移动  enter 切换/确认  esc 取消",
        timeout: 300_000,
      },
    );
    if (choice === undefined) return null;
    const idx = options.findIndex((o) => o.label === choice);
    if (idx >= 0) cursor = idx;
    if (choice === MODELS_DONE) {
      if (checked.size === 0) {
        ctx.ui.notify("至少勾选一个模型，或选择禁用。", "warning");
        continue;
      }
      const models =
        checked.size === provider.models.length
          ? []
          : provider.models.filter((m) => checked.has(m.id)).map((m) => m.id);
      return { enabled: true, models };
    }
    if (choice === MODELS_DISABLE) return { enabled: false, models: [] };
    if (checked.has(choice)) checked.delete(choice);
    else checked.add(choice);
  }
}

/** True if the selection file was mutated and should be saved + synced. */
async function interactiveSelect(
  ctx: ExtensionCommandContext,
  catalog: DirectProvider[],
  selections: SelectionFile,
): Promise<boolean> {
  if (catalog.length === 0) {
    ctx.ui.notify("CC Switch 没有可直连的 provider。", "warning");
    return false;
  }

  // Working copy seeded from ~/.omp/agent/cc-switch-selections.json so reopening
  // /cc-switch shows ✔ / checked boxes for already-enabled providers + models.
  const working = new Map<string, Selection>();
  for (const p of catalog) {
    const prev = selections.providers[p.slug];
    if (prev?.enabled) working.set(p.slug, { enabled: true, models: prev.models ?? [] });
  }

  let cursor = 0;
  for (;;) {
    const enabledIndices: number[] = [];
    const options = catalog.map((p, i) => {
      const sel = working.get(p.slug);
      const on = sel?.enabled ?? false;
      if (on) enabledIndices.push(i);
      const enabled = on ? enabledModelsFor(p, sel) : [];
      const modelPart = on
        ? `✔ ${enabled.length}/${p.models.length} 模型${enabled.length > 0 && enabled.length <= 3 ? `（${enabled.map((m) => m.id).join(", ")}）` : ""}`
        : `${p.models.length} 模型`;
      return {
        label: p.slug,
        description: `${on ? "✔" : "·"} ${p.appType} · ${p.ccName} · ${modelPart}`,
      };
    });
    options.push({ label: DONE_OPTION, description: "保存勾选并重新同步模型" });

    const choice = await ctx.ui.select("CC Switch 直连 provider（✔=已启用，回车编辑模型）", options, {
      selectionMarker: "checkbox",
      checkedIndices: enabledIndices,
      markableCount: catalog.length,
      initialIndex: Math.min(cursor, options.length - 1),
      helpText: "up/down 移动  enter 编辑模型/完成  esc 取消",
      timeout: 300_000,
    });
    if (choice === undefined) {
      ctx.ui.notify("已取消。", "info");
      return false;
    }
    const idx = options.findIndex((o) => o.label === choice);
    if (idx >= 0) cursor = idx;
    if (choice === DONE_OPTION) break;

    const provider = catalog.find((p) => p.slug === choice);
    if (!provider) continue;

    const prev = working.get(provider.slug);
    const picked = await pickModels(ctx, provider, prev ?? { enabled: false, models: [] });
    if (picked === null) continue; // Esc from model picker — keep working state
    if (!picked.enabled) {
      working.delete(provider.slug);
      continue;
    }
    working.set(provider.slug, picked);
  }

  const next: Record<string, Selection> = {};
  for (const [slug, sel] of working) next[slug] = sel;
  selections.providers = next;
  return true;
}

// ─── agent role configuration (/cc-switch roles) ───────────────────────────

/** Parse modelRoles from config.yml into a plain object. */
function readModelRoles(): Record<string, string> {
  if (!existsSync(CONFIG_YML)) return {};
  const lines = readFileSync(CONFIG_YML, "utf8").split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^modelRoles\s*:/.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) return {};
  const out: Record<string, string> = {};
  for (let i = start; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    const m = /^\s+(\S+?)\s*:\s*(.+)/.exec(lines[i]);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Write or update a single role in modelRoles in config.yml. */
function writeModelRole(role: string, value: string): boolean {
  if (!existsSync(CONFIG_YML)) return false;
  const lines = readFileSync(CONFIG_YML, "utf8").split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^modelRoles\s*:/.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) {
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push("modelRoles:", `  ${role}: ${value}`);
  } else {
    let found = false;
    let end = start;
    for (end = start; end < lines.length; end++) {
      if (/^\S/.test(lines[end])) break;
      const m = /^\s+(\S+?)\s*:/.exec(lines[end]);
      if (m && m[1] === role) {
        lines[end] = `  ${role}: ${value}`;
        found = true;
        break;
      }
    }
    if (!found) lines.splice(end, 0, `  ${role}: ${value}`);
  }
  const tmp = `${CONFIG_YML}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, lines.join("\n"), "utf8");
    renameSync(tmp, CONFIG_YML);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* temp never written */ }
    throw error;
  }
  return true;
}

/** Interactive agent role → model configuration via /cc-switch roles. */
async function roleConfig(ctx: ExtensionCommandContext): Promise<boolean> {
  const roles = readModelRoles();
  const rawModels = ctx.models.list().map((m) => `${m.provider}/${m.id}`);
  const uniqueModels = [...new Set(rawModels)].sort();
  if (uniqueModels.length === 0) {
    ctx.ui.notify("没有可用模型。请先 /sync-models 同步 provider。", "warning");
    return false;
  }
  let changed = false;
  let cursor = 0;
  for (;;) {
    const options = CONFIGURABLE_ROLES.map(({ role, desc }) => ({
      label: `${role}  —  ${desc}`,
      description: roles[role] ?? "(未设置)",
      value: role,
    }));
    options.push({ label: DONE_OPTION, description: "保存并退出", value: "__done__" });
    const choice = await ctx.ui.select(
      "Agent 角色模型配置（选择角色 → 选模型）",
      options,
      {
        initialIndex: Math.min(cursor, options.length - 1),
        helpText: "up/down 移动  enter 选择  esc 取消",
        timeout: 300_000,
      },
    );
    if (choice === undefined || choice === DONE_OPTION) break;
    const selected = options.find((o) => o.label === choice);
    const roleKey = selected?.value ?? choice;
    cursor = options.findIndex((o) => o.label === choice);
    // Group models by provider for easier navigation
    const byProvider = new Map<string, string[]>();
    for (const m of uniqueModels) {
      const slashIdx = m.indexOf("/");
      const provider = slashIdx > 0 ? m.slice(0, slashIdx) : m;
      if (!byProvider.has(provider)) byProvider.set(provider, []);
      byProvider.get(provider)!.push(m);
    }
    const providers = [...byProvider.keys()].sort();

    // Level 2: pick provider
    const providerOptions = providers.map((p) => ({
      label: p,
      description: `${byProvider.get(p)!.length} 个模型`,
    }));
    providerOptions.push({ label: "↩ 返回角色列表", description: "" });
    const pickedProvider = await ctx.ui.select(
      `${roleKey} — 选择 provider（当前：${roles[roleKey] ?? "未设置"}）`,
      providerOptions,
      {
        initialIndex: 0,
        helpText: "up/down 移动  enter 选择  esc 返回角色列表",
        timeout: 300_000,
      },
    );
    if (pickedProvider === undefined || pickedProvider === "↩ 返回角色列表") continue;

    // Level 3: pick model under selected provider
    const providerModels = byProvider.get(pickedProvider)!;
    const modelOptions = providerModels.map((m) => ({
      label: m.slice(pickedProvider.length + 1),
      description: roles[roleKey] === m ? "✔ 当前" : "",
    }));
    const pickedModel = await ctx.ui.select(
      `${roleKey} → ${pickedProvider} — 选择模型`,
      modelOptions,
      {
        initialIndex: 0,
        helpText: "up/down 移动  enter 确认  esc 返回 provider 列表",
        timeout: 300_000,
      },
    );
    if (pickedModel === undefined) continue;
    const fullModelId = `${pickedProvider}/${pickedModel}`;
    const prevSuffix = splitModelRoleValue(roles[roleKey] ?? "").suffix;
    const nextValue = prevSuffix ? `${fullModelId}${prevSuffix}` : fullModelId;
    writeModelRole(roleKey, nextValue);
    roles[roleKey] = nextValue;
    changed = true;
    ctx.ui.notify(`${roleKey} → ${nextValue}`, "info");
  }
  if (changed) {
    try { syncAgentModelOverrides(); } catch { /* non-fatal */ }
  }
  return changed;
}
const PROXY_MODEL_GLOBS = ["cc-claude/*", "cc-codex/*"] as const;
const DIRECT_MODEL_GLOBS = ["ccs-*/*"] as const;

/** Globs that keep /model scoped to providers this sync actually publishes. */
function enabledModelGlobs(includeProxy: boolean): string[] {
  return includeProxy ? [...PROXY_MODEL_GLOBS, ...DIRECT_MODEL_GLOBS] : [...DIRECT_MODEL_GLOBS];
}

/**
 * Ensure config.yml's enabledModels whitelists the CC Switch bridge providers.
 * Without this allow-list, omp shows the entire built-in catalog (~thousands of
 * models) whenever any credential is present. When the local proxy is off,
 * also drop `cc-claude/*` / `cc-codex/*` so dead proxy slots don't appear.
 */
function ensureEnabledModelsNamespace(includeProxy: boolean): boolean {
  const wanted = enabledModelGlobs(includeProxy);
  const dropProxyGlobs = !includeProxy;

  if (!existsSync(CONFIG_YML)) {
    writeFileSync(CONFIG_YML, `enabledModels:\n${wanted.map((g) => `  - ${g}`).join("\n")}\n`, "utf8");
    return true;
  }
  const lines = readFileSync(CONFIG_YML, "utf8").split("\n");
  const keyIdx = lines.findIndex((line) => /^enabledModels\s*:/.test(line));
  let changed = false;
  if (keyIdx === -1) {
    let insertAt = lines.length;
    while (insertAt > 0 && lines[insertAt - 1] === "") insertAt--;
    lines.splice(insertAt, 0, "enabledModels:", ...wanted.map((g) => `  - ${g}`));
    changed = true;
  } else {
    let end = keyIdx + 1;
    while (end < lines.length && /^\s+-\s/.test(lines[end])) end++;
    const block = lines.slice(keyIdx + 1, end);
    const indent = block[0] ? (/^(\s*)/.exec(block[0])?.[1] ?? "  ") : "  ";
    const kept = dropProxyGlobs
      ? block.filter((line) => !PROXY_MODEL_GLOBS.some((g) => line.includes(g)))
      : block;
    if (kept.length !== block.length) {
      lines.splice(keyIdx + 1, end - (keyIdx + 1), ...kept);
      end = keyIdx + 1 + kept.length;
      changed = true;
    }
    const current = lines.slice(keyIdx + 1, end);
    const missing = wanted.filter((glob) => !current.some((line) => line.includes(glob)));
    if (missing.length > 0) {
      lines.splice(end, 0, ...missing.map((g) => `${indent}- ${g}`));
      changed = true;
    }
  }
  if (!changed) return false;
  const tmp = `${CONFIG_YML}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, lines.join("\n"), "utf8");
    renameSync(tmp, CONFIG_YML);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp never written */
    }
    throw error;
  }
  return true;
}

/**
 * Strip CC Switch's `[1M]`/`[1m]` context suffix from config.yml modelRoles
 * values. Direct providers registered above no longer carry the suffix, so any
 * role still pointing at a `<provider>/<model>[1M]` would dangle. Idempotent:
 * no-op when no role value contains the suffix. Scoped to the modelRoles block;
 * never touches other keys.
 */
function migrateConfigYmlRoles(): boolean {
  if (!existsSync(CONFIG_YML)) return false;
  const lines = readFileSync(CONFIG_YML, "utf8").split("\n");
  let i = 0;
  while (i < lines.length && !/^modelRoles\s*:/.test(lines[i])) i++;
  if (i >= lines.length) return false;
  let changed = false;
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j];
    if (/^\S/.test(line)) break; // next top-level key ends the block
    if (!/\[1m\]/i.test(line)) continue;
    const cleaned = line.replace(/\[1m\]/gi, "");
    if (cleaned !== line) {
      lines[j] = cleaned;
      changed = true;
    }
  }
  if (!changed) return false;
  const tmp = `${CONFIG_YML}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, lines.join("\n"), "utf8");
    renameSync(tmp, CONFIG_YML);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp never written */
    }
    throw error;
  }
  return true;
}

/**
 * omp's bundled reviewer/scout/designer/security-reviewer/librarian agents lack
 * a `model: "@roleName"` frontmatter binding, so they fall back to
 * `modelRoles.default` instead of their configured role model. This mirrors
 * those roles into `task.agentModelOverrides` so the harness model resolver
 * (IWn priority 2 — settingsOverride) routes them correctly. Idempotent.
 */
const UNBOUND_AGENTS = [
  "reviewer",
  "scout",
  "designer",
  "security-reviewer",
  "librarian",
] as const;

function syncAgentModelOverrides(): boolean {
  if (!existsSync(CONFIG_YML)) return false;
  const lines = readFileSync(CONFIG_YML, "utf8").split("\n");

  // Parse modelRoles values
  let rolesStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^modelRoles\s*:/.test(lines[i])) {
      rolesStart = i + 1;
      break;
    }
  }
  if (rolesStart === -1) return false;

  const roleValues: Record<string, string> = {};
  for (let i = rolesStart; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    const m = /^\s+(\S+?)\s*:\s*(.+)/.exec(lines[i]);
    if (m) roleValues[m[1]] = m[2].trim();
  }

  // Build desired entries for agents that lack model frontmatter
  const desired: Record<string, string> = {};
  for (const agent of UNBOUND_AGENTS) {
    const v = roleValues[agent];
    if (v) desired[agent] = v;
  }
  if (Object.keys(desired).length === 0) return false;

  // Locate existing task: -> agentModelOverrides: block
  let taskIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^task\s*:/.test(lines[i])) {
      taskIdx = i;
      break;
    }
  }

  let amoIdx = -1;
  let amoChildIndent = "    ";
  const existing: Record<string, string> = {};
  if (taskIdx !== -1) {
    for (let i = taskIdx + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break;
      const amoMatch = /^(\s+)agentModelOverrides\s*:/.exec(lines[i]);
      if (amoMatch) {
        amoIdx = i;
        amoChildIndent = amoMatch[1] + "  ";
        const childRe = new RegExp(
          `^${amoChildIndent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\S+?)\\s*:\\s*(.+)`,
        );
        for (let j = i + 1; j < lines.length; j++) {
          const cm = childRe.exec(lines[j]);
          if (cm) existing[cm[1]] = cm[2].trim();
          else break;
        }
        break;
      }
    }
  }

  // Check if update needed
  let changed = false;
  for (const agent of UNBOUND_AGENTS) {
    if (desired[agent] !== existing[agent]) { changed = true; break; }
  }
  for (const key of Object.keys(existing)) {
    if (!desired[key]) { changed = true; break; }
  }
  if (!changed) return false;

  // Build replacement entries
  const newEntries = Object.entries(desired).map(
    ([agent, model]) => `${amoChildIndent}${agent}: ${model}`,
  );

  if (amoIdx !== -1) {
    // Replace existing agentModelOverrides children
    let blockEnd = amoIdx + 1;
    const childPrefix = amoChildIndent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    while (blockEnd < lines.length && new RegExp(`^${childPrefix}\\S`).test(lines[blockEnd])) blockEnd++;
    lines.splice(amoIdx + 1, blockEnd - (amoIdx + 1), ...newEntries);
  } else if (taskIdx !== -1) {
    // task: exists, insert agentModelOverrides: under it
    let insertAt = taskIdx + 1;
    while (insertAt < lines.length && /^\s/.test(lines[insertAt])) insertAt++;
    lines.splice(insertAt, 0, "  agentModelOverrides:", ...newEntries);
  } else {
    // No task: key — append new block at end
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push("", "task:", "  agentModelOverrides:", ...newEntries);
  }

  // Atomic write
  const tmp = `${CONFIG_YML}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, lines.join("\n"), "utf8");
    renameSync(tmp, CONFIG_YML);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* temp never written */ }
    throw error;
  }
  return true;
}

/** Rebuild + write models.yml + register into the live registry. */
async function runSync(ctx: ExtensionCommandContext): Promise<void> {
  let built: BuiltProviders;
  try {
    built = buildAll();
  } catch (error) {
    ctx.ui.notify(`同步失败：${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }

  const all = [...built.proxy, ...built.selected.map(directToRendered)];
  const beforeModels = ctx.models
    .list()
    .filter((m) => isManagedBridgeProvider(m.provider))
    .map((m) => `${m.provider}/${m.id}`);

  const droppedProviders = syncBridgeProviders(
    (name, config) => ctx.modelRegistry.registerProvider(name, config, SOURCE_ID),
    (name) => ctx.modelRegistry.unregisterProvider(name),
    () => ctx.models.list().map((m) => m.provider),
    all,
  );

  const after = new Set(all.flatMap((p) => p.models.map((m) => `${p.name}/${m.id}`)));
  const droppedModels = beforeModels.filter((s) => !after.has(s));

  const notes: string[] = [];
  try {
    writeModelsYml(renderModelsYml(built.proxy, built.selected));
  } catch (error) {
    notes.push(`models.yml 写入失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (droppedModels.length > 0) {
    notes.push(`已下线模型：${droppedModels.join(", ")} —— 检查 config.yml 的 modelRoles。`);
  }
  if (droppedProviders.length > 0) {
    notes.push(`已卸载 provider：${droppedProviders.join(", ")}`);
  }

  if (built.proxy.length === 0 && loadSelections().publishProxySlots !== false && !isLocalProxyEnabled()) {
    notes.push(
      `已跳过 cc-claude/cc-codex：CC Switch 本地代理未开启（enableLocalProxy=false，${resolveProxyRoot()} 无监听）。请用 ccs-* 直连，或在 CC Switch 开启本地代理后再 /sync-models。`,
    );
  }
  try {
    if (ensureEnabledModelsNamespace(built.proxy.length > 0)) {
      notes.push(
        `已更新 config.yml 的 enabledModels（${enabledModelGlobs(built.proxy.length > 0).join(", ")}）—— 需重启 omp 才生效。`,
      );
    }
  } catch (error) {
    notes.push(`config.yml 更新失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (migrateConfigYmlRoles()) {
      notes.push("已清理 config.yml 中残留的 [1M] 模型引用 —— 需重启 omp 才生效。");
    }
  } catch (error) {
    notes.push(`config.yml 角色迁移失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (syncAgentModelOverrides()) {
      notes.push("已同步 task.agentModelOverrides（reviewer/scout/designer/security-reviewer/librarian 模型路由）—— 需重启 omp 才生效。");
    }
  } catch (error) {
    notes.push(`config.yml agentModelOverrides 同步失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const proxySummary = built.proxy.map((p) => `  ${p.name}: ${p.models.map((m) => m.id).join(", ")}`).join("\n");
  const directSummary = built.selected.length
    ? built.selected.map(({ provider, models }) => `  ${provider.slug}: ${models.map((m) => m.id).join(", ")}`).join("\n")
    : "  （未启用直连 provider，用 /cc-switch 选择）";
  ctx.ui.notify(
    `已发现 ${built.direct.length} 个直连候选；已同步 ${built.proxy.length} 个代理槽位 + ${built.selected.length} 个已启用直连 provider：\n${proxySummary}\n${directSummary}${notes.length ? `\n${notes.join("\n")}` : ""}`,
    "info",
  );
}

function handleSubcommand(args: string, ctx: ExtensionCommandContext, selections: SelectionFile): Promise<boolean> | boolean {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const rawSub = parts[0];

  let catalog: DirectProvider[];
  try {
    catalog = collectDirectCatalog();
  } catch (error) {
    ctx.ui.notify(`读取 CC Switch 失败：${error instanceof Error ? error.message : String(error)}`, "error");
    return false;
  }
  const knownSlugs = new Set(catalog.map((p) => p.slug));

  // No subcommand: interactive checkbox UI (seeded from selections cache).
  if (rawSub === undefined) {
    if (typeof ctx.ui.select !== "function") {
      ctx.ui.notify(`CC Switch 直连目录（${catalog.length}）：\n${summarize(catalog, selections)}`, "info");
      return false;
    }
    return interactiveSelect(ctx, catalog, selections);
  }
  if (!VALID_SUBS.has(rawSub)) {
    ctx.ui.notify(`未知子命令：${rawSub}。可用：${[...VALID_SUBS].join(", ")}`, "error");
    return false;
  }

  if (rawSub === "list") {
    ctx.ui.notify(`CC Switch 直连目录（${catalog.length}）：\n${summarize(catalog, selections)}`, "info");
    return false;
  }
  if (rawSub === "enable-all") {
    for (const p of catalog) selections.providers[p.slug] = { enabled: true, models: [] };
    return true;
  }
  if (rawSub === "disable-all") {
    selections.providers = {};
    return true;
  }
  if (rawSub === "enable" || rawSub === "disable") {
    const slug = parts[1];
    if (!slug || !knownSlugs.has(slug)) {
      ctx.ui.notify(`未知 provider：${slug ?? "(空)"}。可用：${catalog.map((p) => p.slug).join(", ")}`, "error");
      return false;
    }
    if (rawSub === "enable") selections.providers[slug] = { enabled: true, models: [] };
    else delete selections.providers[slug];
    return true;
  }
  if (rawSub === "roles") {
    if (typeof ctx.ui.select !== "function") {
      const roles = readModelRoles();
      ctx.ui.notify(
        `Agent 角色配置（只读，当前环境不支持交互选择）：\n${CONFIGURABLE_ROLES.map(({ role, desc }) => `  ${role}  ${desc}\n    → ${roles[role] ?? "(未设置)"}`).join("\n")}`,
        "info",
      );
      return false;
    }
    return roleConfig(ctx);
  }
  // rawSub === "models"
  const slug = parts[1];
  const spec = parts.slice(2).join(" ");
  if (!slug || !knownSlugs.has(slug)) {
    ctx.ui.notify(`未知 provider：${slug ?? "(空)"}`, "error");
    return false;
  }
  const existing = selections.providers[slug];
  if (!existing?.enabled) {
    ctx.ui.notify(`请先启用 ${slug}（/cc-switch enable ${slug}）`, "warning");
    return false;
  }
  existing.models = spec === "all" || !spec ? [] : spec.split(",").map((s) => s.trim()).filter(Boolean);
  return true;
}

function registerCcSwitchCommand(pi: ExtensionAPI): void {
  const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const selections = loadSelections();
    const result = await handleSubcommand(args, ctx, selections);
    if (!result) return;
    try {
      saveSelections(selections);
    } catch (error) {
      ctx.ui.notify(`保存选择失败：${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    await runSync(ctx);
  };
  const desc = "管理 CC Switch 直连 provider 选择（list/enable/disable/models/roles，无参数进入交互）";
  pi.registerCommand("cc-switch", { description: desc, handler });
  pi.registerCommand("ccs", { description: desc, handler });
}

// ─── entry point ─────────────────────────────────────────────────────────────

export default function syncCcSwitchModels(pi: ExtensionAPI): void {
  try {
    const built = buildAll();
    const { proxy, selected } = built;
    const all = [...proxy, ...selected.map(directToRendered)];
    if (proxy.length === 0 && !isLocalProxyEnabled()) {
      pi.logger.warn?.(
        `cc-switch: 本地代理未开启，跳过 cc-claude/cc-codex（${resolveProxyRoot()}）。使用已启用的 ccs-* 直连 provider。`,
      );
    }
    try {
      writeModelsYml(renderModelsYml(proxy, selected));
    } catch (error) {
      pi.logger.error(`cc-switch models.yml 写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
    for (const p of all) {
      pi.registerProvider(p.name, toProviderConfig(p));
    }
  } catch (error) {
    pi.logger.error(`cc-switch 初始注册失败：${error instanceof Error ? error.message : String(error)}`);
  }

  pi.registerCommand("sync-models", {
    description: "从 CC Switch 数据库重新同步模型配置（加 --dry-run 只预览）",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (args.trim() === "--dry-run") {
        try {
          const { proxy, direct, selected } = buildAll();
          const summary =
            proxy.map((p) => `  ${p.name}: ${p.models.map((m) => m.id).join(", ")}`).join("\n") +
            "\n" +
            (selected.length
              ? selected.map(({ provider, models }) => `  ${provider.slug}: ${models.map((m) => m.id).join(", ")}`).join("\n")
              : "  （未启用直连 provider）");
          ctx.ui.notify(`[dry-run] 当前目录（${direct.length} 可直连，${selected.length} 已启用）：\n${summary}`, "info");
        } catch (error) {
          ctx.ui.notify(`同步失败：${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      await runSync(ctx);
    },
  });

  registerCcSwitchCommand(pi);
}
