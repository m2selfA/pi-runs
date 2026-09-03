import { createHash } from "node:crypto";

const MAX_DISPLAY_NAME_CHARS = 48;
const GENERIC_LAUNCHERS = new Set([
  "python",
  "python3",
  "py",
  "node",
  "bun",
  "deno",
  "bash",
  "sh",
  "zsh",
  "pwsh",
  "powershell",
]);
const SHELL_COMMAND_OPTIONS = new Set(["-c", "-command", "/c"]);
const ADJECTIVES = [
  "amber", "brisk", "calm", "clear", "cool", "crisp", "dawn", "deep",
  "fair", "fast", "firm", "fresh", "gentle", "gold", "green", "keen",
  "light", "lively", "lucky", "mild", "neat", "quiet", "rapid", "ready",
  "sharp", "silver", "steady", "swift", "tidy", "vivid", "warm", "wise",
];
const NOUNS = [
  "ash", "birch", "cedar", "clover", "coral", "dune", "elm", "fern",
  "fjord", "grove", "harbor", "hazel", "iris", "jade", "lake", "larch",
  "maple", "mesa", "moss", "oak", "opal", "pine", "reef", "ridge",
  "river", "sage", "shore", "spruce", "stone", "vale", "willow", "yew",
];

function hashBytes(value) {
  return createHash("sha256").update(String(value || "run")).digest();
}

function clipCodePoints(value, maxChars = MAX_DISPLAY_NAME_CHARS) {
  return [...String(value || "")].slice(0, maxChars).join("");
}

function normalizeWords(value) {
  const normalized = String(value || "").normalize("NFKC").trim().toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  return clipCodePoints(words.slice(0, 6).join("-"));
}

function looksOpaque(value) {
  const raw = String(value || "").trim();
  if (!raw) return true;
  if (/^[a-f0-9]{12,}$/i.test(raw)) return true;
  if (/^[a-z0-9+/_=-]{20,}$/i.test(raw) && !/[\s-]/.test(raw)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) return true;
  return false;
}

function looksAbsolutePathOrUrl(value) {
  const raw = String(value || "").trim();
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ||
    /^[a-z]:[\\/]/i.test(raw) ||
    /^[/~]/.test(raw) ||
    /^\\\\/.test(raw)
  );
}

function looksPathOrUrl(value) {
  const raw = String(value || "").trim();
  return looksAbsolutePathOrUrl(raw) || raw.includes("\\");
}

export function sanitizeDisplayName(value) {
  const raw = String(value || "").trim();
  if (!raw || looksPathOrUrl(raw) || looksOpaque(raw)) return undefined;
  const normalized = normalizeWords(raw);
  if (!normalized || looksOpaque(normalized)) return undefined;
  return normalized;
}

function shellTokens(command) {
  const tokens = [];
  const input = String(command || "");
  const pattern = /"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s]+)/g;
  for (const match of input.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
    if (tokens.length >= 16) break;
  }
  return tokens.filter(Boolean);
}

function leafToken(value) {
  const pieces = String(value || "").split(/[\\/]/);
  return pieces.at(-1) || "";
}

function stripExtension(value) {
  return value.replace(/\.(?:py|pyw|js|mjs|cjs|ts|tsx|jsx|sh|ps1|bat|cmd|exe)$/i, "");
}

function safeTokenStem(value) {
  if (looksAbsolutePathOrUrl(value)) return undefined;
  const leaf = stripExtension(leafToken(value));
  if (!leaf || looksOpaque(leaf)) return undefined;
  return sanitizeDisplayName(leaf);
}

function safeScriptStem(value) {
  const raw = String(value || "").trim();
  if (looksAbsolutePathOrUrl(raw)) return undefined;
  if (!/\.(?:py|pyw|js|mjs|cjs|ts|tsx|jsx|sh|ps1|bat|cmd)$/i.test(raw)) return undefined;
  return safeTokenStem(raw);
}

function firstNonOption(tokens, start = 1) {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.startsWith("-")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    return { token, index: i };
  }
  return undefined;
}

export function semanticDisplayName(command) {
  let tokens = shellTokens(command);
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
  if (!tokens.length) return undefined;

  const executable = stripExtension(leafToken(tokens[0])).toLowerCase();
  if (!executable || looksOpaque(executable)) return undefined;

  if (["cargo"].includes(executable)) {
    const knownActions = new Set([
      "bench", "build", "check", "clean", "clippy", "doc", "fetch", "fmt",
      "install", "publish", "run", "test", "update",
    ]);
    const action = String(tokens[1] || "").toLowerCase();
    return knownActions.has(action) ? `cargo-${action}` : "cargo";
  }

  if (["npm", "pnpm", "yarn"].includes(executable)) {
    const knownActions = new Set([
      "add", "build", "ci", "exec", "install", "lint", "pack", "publish", "start", "test", "update",
    ]);
    const action = String(tokens[1] || "").toLowerCase();
    if (action === "run") {
      const script = tokens[2];
      return script && !script.startsWith("-") ? sanitizeDisplayName(script) || `${executable}-run` : `${executable}-run`;
    }
    return knownActions.has(action) ? `${executable}-${action}` : executable;
  }

  if (["pytest", "py.test"].includes(executable)) {
    const target = tokens[1];
    const stem = target && !target.startsWith("-") ? safeScriptStem(target.split("::")[0]) : undefined;
    return stem ? `test-${stem}` : "pytest";
  }

  if (GENERIC_LAUNCHERS.has(executable)) {
    const first = tokens[1];
    if (!first) return undefined;
    const lower = first.toLowerCase();
    if (SHELL_COMMAND_OPTIONS.has(lower)) return undefined;
    if (lower === "-m" && tokens[2]) {
      const module = tokens[2];
      if (module.startsWith("-") || looksPathOrUrl(module) || looksOpaque(module)) return undefined;
      return sanitizeDisplayName(module.split(".").at(-1));
    }
    if (first.startsWith("-")) return undefined;
    return safeScriptStem(first);
  }

  return safeTokenStem(tokens[0]);
}

export function mnemonicDisplayName(runId, offset = 0) {
  const hash = hashBytes(runId);
  const adjective = ADJECTIVES[hash[offset % hash.length] % ADJECTIVES.length];
  const noun = NOUNS[hash[(offset + 1) % hash.length] % NOUNS.length];
  return `${adjective}-${noun}`;
}

function collisionSuffix(runId) {
  const hash = hashBytes(runId);
  return NOUNS[hash[2] % NOUNS.length];
}

function collisionFallbackSuffix(runId) {
  const hash = hashBytes(runId);
  return `${NOUNS[hash[2] % NOUNS.length]}-${ADJECTIVES[hash[3] % ADJECTIVES.length]}`;
}

function boundedWithSuffix(base, suffix) {
  const maxBase = Math.max(8, MAX_DISPLAY_NAME_CHARS - [...suffix].length - 1);
  const clipped = clipCodePoints(base, maxBase).replace(/-+$/g, "");
  return `${clipped || "run"}-${suffix}`;
}

function normalizedExistingName(run) {
  const value = run?.display_name ?? run?.name;
  return sanitizeDisplayName(value);
}

function isRelevantNameCollisionRun(run) {
  const status = String(run?.status || "").trim().toLowerCase();
  if (!status) return true;
  return !["succeeded", "cancelled"].includes(status);
}

export function resolveRunDisplayName({ requestedName, command, runId, existingRuns = [] }) {
  if (!runId) throw new Error("display-name resolution requires runId");
  const sameRun = (Array.isArray(existingRuns) ? existingRuns : []).find((run) => run?.run_id === runId);
  const persistedSameRunName =
    typeof sameRun?.name === "string" && sameRun.name.trim() ? sameRun.name.trim() : undefined;
  if (persistedSameRunName) {
    return { name: persistedSameRunName, source: "existing", collision: false };
  }

  const requested = sanitizeDisplayName(requestedName);
  const semantic = requested ? undefined : semanticDisplayName(command);
  const base = requested || semantic || mnemonicDisplayName(runId);
  const source = requested ? "requested" : semantic ? "semantic" : "mnemonic";
  const occupied = new Set(
    (Array.isArray(existingRuns) ? existingRuns : [])
      .filter((run) => run?.run_id !== runId && isRelevantNameCollisionRun(run))
      .map(normalizedExistingName)
      .filter(Boolean),
  );

  let name = base;
  let collision = false;
  if (occupied.has(name)) {
    collision = true;
    name = boundedWithSuffix(base, collisionSuffix(runId));
  }
  if (occupied.has(name)) {
    name = boundedWithSuffix(base, collisionFallbackSuffix(runId));
  }

  return { name, source, collision };
}

export function displayNameForRun(run) {
  const runId = String(run?.run_id || "run");
  const persisted = sanitizeDisplayName(run?.display_name ?? run?.name);
  const normalizedRunId = normalizeWords(runId);
  if (persisted && persisted !== normalizedRunId) return persisted;
  return mnemonicDisplayName(runId);
}
