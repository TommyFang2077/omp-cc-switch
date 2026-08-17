import { chmodSync, existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";

const KNOWN_EFFORT_SUFFIXES = new Set([
  "off",
  "min",
  "minimal",
  "low",
  "medium",
  "med",
  "high",
  "xhigh",
  "xhi",
  "max",
]);

export const SOURCE_ID = "omp-cc-switch";

export function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

export function ccSwitchPaths(home = homeDir()) {
  return {
    db: `${home}/.cc-switch/cc-switch.db`,
    settings: `${home}/.cc-switch/settings.json`,
    modelsYml: `${home}/.omp/agent/models.yml`,
    configYml: `${home}/.omp/agent/config.yml`,
    selections: `${home}/.omp/agent/cc-switch-selections.json`,
  };
}

/** Reject CC Switch UI placeholders and other non-wire secrets. */
export function isUsableSecret(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/^[•*·.\u2022\u25CF\u25E6]{4,}$/.test(trimmed)) return false;
  if (/^<redacted>$/i.test(trimmed)) return false;
  return true;
}

export function writeSecureFile(path: string, content: string, mode = 0o600): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode });
    renameSync(tmp, path);
    try {
      chmodSync(path, mode);
    } catch {
      /* best-effort on platforms that ignore mode at write time */
    }
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp never written */
    }
    throw error;
  }
}

/** Split `provider/model:effort` role values without breaking model ids that contain colons. */
export function splitModelRoleValue(value: string): { base: string; suffix: string } {
  const lastColon = value.lastIndexOf(":");
  if (lastColon <= 0) return { base: value, suffix: "" };
  const maybeEffort = value.slice(lastColon + 1).toLowerCase();
  if (!KNOWN_EFFORT_SUFFIXES.has(maybeEffort)) {
    return { base: value, suffix: "" };
  }
  return { base: value.slice(0, lastColon), suffix: value.slice(lastColon) };
}

export function isManagedBridgeProvider(name: string): boolean {
  return name === "cc-claude" || name === "cc-codex" || name.startsWith("ccs-");
}

export function chmodIfExists(path: string, mode: number): void {
  if (existsSync(path)) {
    try {
      chmodSync(path, mode);
    } catch {
      /* non-fatal */
    }
  }
}
