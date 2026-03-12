import { complete, getModel } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

type JsonObject = Record<string, unknown>;

type ModelRef = {
  provider: string;
  id: string;
};

type SelfLearningConfig = {
  enabled: boolean;
  autoAfterTask: boolean;
  autoAfterTurn?: boolean; // deprecated; kept for backward compatibility
  injectLastN: number;
  maxMessagesForReflection: number;
  maxLearnings: number;
  maxCoreItems: number;
  storage: {
    mode: "project" | "global";
    projectPath: string;
    globalPath: string;
  };
  git: {
    enabled: boolean;
    autoCommit: boolean;
  };
  context: {
    enabled: boolean;
    includeCore: boolean;
    includeLatestMonthly: boolean;
    includeLastNDaily: number;
    maxChars: number;
    instructionMode: "off" | "advisory" | "strict";
  };
  model?:
    | {
        provider?: string;
        id?: string;
      }
    | string;
};

type LearningReflection = {
  mistakes: string[];
  fixes: string[];
};

type ReflectionSkipReason =
  | "disabled"
  | "no_messages"
  | "empty_conversation"
  | "no_model"
  | "empty_model_output"
  | "invalid_model_output";

type ReflectNowResult = {
  file?: string;
  reason?: ReflectionSkipReason;
  rawModelOutput?: string;
  repairModelOutput?: string;
  diagnostics?: string[];
};

type SessionEntry = {
  type: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
};

const DEFAULT_CONFIG: SelfLearningConfig = {
  enabled: true,
  autoAfterTask: true,
  injectLastN: 5,
  maxMessagesForReflection: 8,
  maxLearnings: 8,
  maxCoreItems: 20,
  storage: {
    mode: "project",
    projectPath: ".pi/self-learning-memory",
    globalPath: "~/.pi/agent/self-learning-memory",
  },
  git: {
    enabled: true,
    autoCommit: true,
  },
  context: {
    enabled: true,
    includeCore: true,
    includeLatestMonthly: false,
    includeLastNDaily: 0,
    maxChars: 12000,
    instructionMode: "strict",
  },
};

const TOGGLE_ENTRY = "self-learning:toggle";
const MODEL_ENTRY = "self-learning:model";
const RUNTIME_NOTES: string[] = [];
const REDISTILL_CHUNK_SIZE = 8;
const REDISTILL_MODEL_TIMEOUT_MS = 45_000;
const REDISTILL_REPAIR_TIMEOUT_MS = 30_000;
const REDISTILL_MODEL_MAX_TOKENS = 3200;
const REDISTILL_REPAIR_MAX_TOKENS = 2400;
const REFLECTION_MODEL_TIMEOUT_MS = 90_000;
const REFLECTION_REPAIR_TIMEOUT_MS = 60_000;
const MONTH_SUMMARY_MODEL_TIMEOUT_MS = 120_000;
const GIT_FAST_TIMEOUT_MS = 15_000;
const GIT_COMMIT_TIMEOUT_MS = 30_000;
const REDISTILL_SKIP_AUTO_REFLECTION_MS = 5 * 60_000;
const INTERRUPTION_SIGNAL_MAX = 8;
const BLOCKED_COMMAND_PATTERN =
  /\b(blocked|not allowed|forbidden|denied by|disallowed|policy|blocked by user|blocked by an extension|user denied|dangerous command|refused)\b/i;
const PERMISSION_DENIED_PATTERN =
  /\b(permission denied|operation not permitted|eacces|eperm|unauthorized|access denied|permission\s+negated)\b/i;
const USER_CANCEL_PATTERN = /\b(cancelled by user|canceled by user|aborted by user|user cancelled|user canceled)\b/i;
let skipAutoReflectionUntil = 0;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: JsonObject, overrides: JsonObject): JsonObject {
  const result: JsonObject = { ...base };

  for (const [key, overrideValue] of Object.entries(overrides)) {
    if (overrideValue === undefined) continue;
    const baseValue = base[key];

    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }

  return result;
}

function loadJsonFile(path: string): JsonObject {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function globalSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

function findAncestorDir(start: string, matches: (dir: string) => boolean): string | undefined {
  let current = start;

  while (true) {
    if (matches(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function resolveProjectBaseDir(cwd: string): string {
  return (
    findAncestorDir(cwd, (dir) => existsSync(join(dir, ".pi", "settings.json"))) ||
    findAncestorDir(cwd, (dir) => existsSync(join(dir, ".git"))) ||
    cwd
  );
}

function projectSettingsPath(cwd: string): string {
  return join(resolveProjectBaseDir(cwd), ".pi", "settings.json");
}

function loadMergedSettings(cwd: string): JsonObject {
  const globalSettings = loadJsonFile(globalSettingsPath());
  const projectSettings = loadJsonFile(projectSettingsPath(cwd));
  return deepMerge(globalSettings, projectSettings);
}

function upsertModelInSettings(path: string, model: ModelRef | undefined): void {
  const root = loadJsonFile(path);

  if (!isPlainObject(root.selfLearning)) root.selfLearning = {};
  const selfLearning = root.selfLearning as JsonObject;

  if (!model) {
    delete selfLearning.model;
  } else {
    selfLearning.model = { provider: model.provider, id: model.id };
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, "utf-8");
}

function getSetting<T>(settings: JsonObject, path: string, fallback: T): T {
  const parts = path.split(".").filter(Boolean);
  let current: unknown = settings;

  for (const part of parts) {
    if (!isPlainObject(current)) return fallback;
    current = current[part];
  }

  return (current as T) ?? fallback;
}

function toDateKeyUTC(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toMonthKeyUTC(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function toTimeUTC(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

function expandHome(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return path;
}

function resolveStorageRoot(config: SelfLearningConfig, cwd: string): string {
  if (config.storage.mode === "global") {
    return expandHome(config.storage.globalPath);
  }
  const projectPath = config.storage.projectPath;
  return isAbsolute(projectPath) ? projectPath : join(resolveProjectBaseDir(cwd), projectPath);
}

function dailyDir(root: string): string {
  return join(root, "daily");
}

function monthlyDir(root: string): string {
  return join(root, "monthly");
}

function coreDir(root: string): string {
  return join(root, "core");
}

function coreFile(root: string): string {
  return join(coreDir(root), "CORE.md");
}

function longTermMemoryFile(root: string): string {
  return join(root, "long-term-memory.md");
}

function pathForPrompt(path: string, cwd: string): string {
  const relativePath = relative(cwd, path);
  if (!relativePath) return ".";
  if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) return relativePath;
  return path;
}

function appendDailyEntry(root: string, when: Date, content: string): string {
  const dir = dailyDir(root);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${toDateKeyUTC(when)}.md`);
  appendFileSync(file, content, "utf-8");
  return file;
}

function writeMonthlySummary(root: string, month: string, content: string): string {
  const dir = monthlyDir(root);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${month}.md`);
  writeFileSync(file, content, "utf-8");
  return file;
}

function ensureCoreFile(root: string): string {
  const file = coreFile(root);
  mkdirSync(coreDir(root), { recursive: true });
  if (!existsSync(file)) {
    writeFileSync(
      file,
      "# Core Learnings\n\nMost important durable learnings collected over time.\n\n## Learnings\n- (none yet)\n",
      "utf-8",
    );
  }
  return file;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;

  const firstNewLine = trimmed.indexOf("\n");
  if (firstNewLine === -1) return trimmed;
  const lastFence = trimmed.lastIndexOf("```");
  if (lastFence <= firstNewLine) return trimmed;
  return trimmed.slice(firstNewLine + 1, lastFence).trim();
}

function parseReflection(raw: string): LearningReflection | undefined {
  const candidate = stripCodeFence(raw);
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!isPlainObject(parsed)) return undefined;

    const list = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean)
        : [];

    const mistakes = list(parsed.mistakes);
    const fixes = list(parsed.fixes);

    // Backward compatibility for older outputs
    const fallbackMistakes = list(parsed.antiPatterns);
    const fallbackFixes = list(parsed.learnings);

    const normalizedMistakes = mistakes.length > 0 ? mistakes : fallbackMistakes;
    const normalizedFixes = fixes.length > 0 ? fixes : fallbackFixes;

    if (normalizedMistakes.length === 0 && normalizedFixes.length === 0) return undefined;

    return {
      mistakes: normalizedMistakes,
      fixes: normalizedFixes,
    };
  } catch {
    return undefined;
  }
}

function extractFirstJsonObject(text: string): string | undefined {
  const input = stripCodeFence(text);
  const start = input.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, i + 1).trim();
      }
    }
  }

  return undefined;
}

function parseReflectionWithFallback(raw: string): LearningReflection | undefined {
  const direct = parseReflection(raw);
  if (direct) return direct;

  const extracted = extractFirstJsonObject(raw);
  if (!extracted) return undefined;

  return parseReflection(extracted);
}

function buildReflectionRepairPrompt(rawModelOutput: string): string {
  return [
    "Convert the following model output into STRICT JSON only.",
    "Return exactly one JSON object with this schema:",
    '{"mistakes":["..."],"fixes":["..."]}',
    "Do not add markdown fences. Do not add commentary.",
    "If information is missing, use empty arrays.",
    "",
    "<raw_output>",
    compactText(rawModelOutput, 6000),
    "</raw_output>",
  ].join("\n");
}

function extractTextFromResponseContent(content: unknown): string {
  if (!Array.isArray(content)) return "";

  return content
    .filter((c): c is { type: string; text?: unknown } => isPlainObject(c) && typeof c.type === "string")
    .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .join("\n")
    .trim();
}

function previewResponseContent(content: unknown, maxChars = 1200): string {
  if (!Array.isArray(content) || content.length === 0) return "(empty response content)";

  const rendered = content
    .map((item) => {
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .join("\n");

  return compactText(rendered, maxChars);
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .filter((item): item is { type: string; text?: unknown } => isPlainObject(item) && typeof item.type === "string")
    .map((item) => (item.type === "text" && typeof item.text === "string" ? item.text : ""))
    .join("\n")
    .trim();
}

function collectInterruptionSignals(ctx: ExtensionContext, maxEntriesToScan: number): string[] {
  const branch = ctx.sessionManager.getBranch() as SessionEntry[];
  if (branch.length === 0) return [];

  const entries = branch.slice(-Math.max(1, maxEntriesToScan));
  const signals: string[] = [];
  const seen = new Set<string>();

  const push = (line: string) => {
    const normalized = line.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    signals.push(line);
  };

  for (const entry of entries) {
    if (entry.type !== "message" || !isPlainObject(entry.message)) continue;

    const message = entry.message as JsonObject;
    const role = typeof message.role === "string" ? message.role : "";

    if (role === "assistant") {
      const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
      if (stopReason === "aborted") {
        push("Assistant response was aborted/interrupted by the user (often Esc/abort). Treat this as an intent-change signal.");
      }
      continue;
    }

    if (role !== "toolResult") continue;

    const toolName = typeof message.toolName === "string" ? message.toolName : "(unknown tool)";
    const text = extractMessageText(message.content);
    const textPreview = compactText(text || "(no text)", 180).replace(/\s+/g, " ").trim();
    const isError = message.isError === true;

    if (/skipped due to queued user message/i.test(text)) {
      push(`Tool ${toolName} was skipped because the user interrupted and queued a new direction.`);
      continue;
    }

    if (!isError) continue;

    if (PERMISSION_DENIED_PATTERN.test(text)) {
      push(`Tool ${toolName} failed with a permission denial: ${textPreview}`);
      continue;
    }

    if (BLOCKED_COMMAND_PATTERN.test(text)) {
      push(`Tool ${toolName} was blocked/denied by constraints: ${textPreview}`);
      continue;
    }

    if (USER_CANCEL_PATTERN.test(text)) {
      push(`Tool ${toolName} was user-cancelled: ${textPreview}`);
    }
  }

  return signals.slice(0, INTERRUPTION_SIGNAL_MAX);
}

function buildReflectionPrompt(
  conversationText: string,
  maxLearnings: number,
  storageMode: SelfLearningConfig["storage"]["mode"],
  interruptionSignals: string[] = [],
): string {
  const scopeRules =
    storageMode === "global"
      ? [
          "- Distill each item into a cross-project rule that is reusable in any repository.",
          "- Remove project-specific details (file names, module names, internal identifiers, phase labels, ticket references).",
          "- Rewrite specifics into generic actions while preserving the underlying lesson.",
          "- Prefer imperative wording (e.g., 'Validate X before Y').",
        ]
      : ["- Keep concrete details that are useful for this specific project/repository."];

  const interruptionRules =
    interruptionSignals.length > 0
      ? [
          "- Treat interruption/blocked/permission signals as intentional user-boundary evidence.",
          "- Infer why the user stopped the flow and include at least one prevention-oriented mistake and one concrete fix for it.",
          "- Do not frame user interruption as random failure.",
        ]
      : [];

  const interruptionSection =
    interruptionSignals.length > 0
      ? ["", "<interruption_signals>", ...interruptionSignals.map((line) => `- ${line}`), "</interruption_signals>"]
      : [];

  return [
    "You are a coding session mistake-prevention reflection engine.",
    "Focus on what went wrong and how it was fixed.",
    "Do NOT summarize accomplishments or completed tasks.",
    "Return STRICT JSON only with this schema:",
    '{"mistakes":["..."],"fixes":["..."]}',
    "Rules:",
    `- Keep each array short (max ${maxLearnings}).`,
    "- Prefer specific, actionable, prevention-oriented points.",
    "- Avoid generic statements and progress summaries.",
    ...scopeRules,
    ...interruptionRules,
    "",
    "<conversation>",
    conversationText,
    "</conversation>",
    ...interruptionSection,
  ].join("\n");
}

function buildRedistillPrompt(items: Array<{ id: number; kind: "learning" | "antiPattern"; text: string }>): string {
  return [
    "Rewrite the memory entries into concise, cross-project action rules.",
    "Return STRICT JSON only.",
    "Schema:",
    '{"items":[{"id":1,"text":"..."}]}',
    "Rules:",
    "- Return exactly one output item for each input id.",
    "- Preserve each item's original meaning and prevention intent.",
    "- Remove project/repo-specific identifiers (file names, paths, class/function names, symbol names, phase labels, ticket IDs).",
    "- Rewrite into generic actions that are reusable across repositories.",
    "- Keep each output as one concise sentence in imperative style.",
    "- For antiPattern items, output MUST start with 'Avoid:'.",
    "- For learning items, output MUST NOT start with 'Avoid:'.",
    "",
    "<items>",
    JSON.stringify(items),
    "</items>",
  ].join("\n");
}

function parseRedistillOutput(raw: string): Map<number, string> | undefined {
  const parse = (input: string): Map<number, string> | undefined => {
    try {
      const parsed = JSON.parse(stripCodeFence(input)) as unknown;
      if (!isPlainObject(parsed) || !Array.isArray(parsed.items)) return undefined;

      const out = new Map<number, string>();
      for (const item of parsed.items) {
        if (!isPlainObject(item)) continue;
        const id = Number(item.id);
        const text = typeof item.text === "string" ? item.text.trim() : "";
        if (!Number.isFinite(id) || !text) continue;
        out.set(id, text);
      }

      return out.size > 0 ? out : undefined;
    } catch {
      return undefined;
    }
  };

  const direct = parse(raw);
  if (direct) return direct;

  const extracted = extractFirstJsonObject(raw);
  if (!extracted) return undefined;
  return parse(extracted);
}

function buildRedistillRepairPrompt(
  rawModelOutput: string,
  items: Array<{ id: number; kind: "learning" | "antiPattern"; text: string }>,
): string {
  return [
    "Convert the following model output into STRICT JSON only.",
    "Return exactly one JSON object with this schema:",
    '{"items":[{"id":1,"text":"..."}]}',
    "Requirements:",
    "- Keep exactly one output item per input id.",
    "- For antiPattern items, text MUST start with 'Avoid:'.",
    "- For learning items, text MUST NOT start with 'Avoid:'.",
    "- No markdown fences. No commentary.",
    "",
    "<input_items>",
    JSON.stringify(items),
    "</input_items>",
    "",
    "<raw_output>",
    compactText(rawModelOutput, 6000),
    "</raw_output>",
  ].join("\n");
}

function buildMonthPrompt(month: string, monthText: string): string {
  return [
    `Create a monthly summary for ${month}.`,
    "Return markdown with these sections:",
    "- Wins",
    "- Recurring issues",
    "- Most important learnings",
    "Keep it concise and actionable.",
    "",
    "<month_journal>",
    monthText,
    "</month_journal>",
  ].join("\n");
}

function buildMarkdownEntry(when: Date, turnLabel: string, reflection: LearningReflection): string {
  const lines: string[] = [];
  lines.push(`## ${toTimeUTC(when)} — ${turnLabel}`);
  lines.push("");

  lines.push("### What went wrong");
  if (reflection.mistakes.length === 0) lines.push("- (none)");
  for (const item of reflection.mistakes) lines.push(`- ${item}`);
  lines.push("");

  lines.push("### How it was fixed");
  if (reflection.fixes.length === 0) lines.push("- (none)");
  for (const item of reflection.fixes) lines.push(`- ${item}`);
  lines.push("", "");

  return lines.join("\n");
}

function getBranchMessages(ctx: ExtensionContext, maxMessages: number): unknown[] {
  const entries = ctx.sessionManager.getBranch() as SessionEntry[];
  return entries
    .filter((e) => e.type === "message" && e.message)
    .map((e) => e.message)
    .slice(-Math.max(1, maxMessages));
}

function getRuntimeEnabledOverride(ctx: ExtensionContext): boolean | undefined {
  const branch = ctx.sessionManager.getBranch() as SessionEntry[];
  let latest: boolean | undefined;

  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== TOGGLE_ENTRY || !entry.data) continue;
    const value = (entry.data as { enabled?: unknown }).enabled;
    if (typeof value === "boolean") latest = value;
  }

  return latest;
}

function parseModelRef(input: string): ModelRef | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;

  const provider = trimmed.slice(0, slash).trim();
  const id = trimmed.slice(slash + 1).trim();
  if (!provider || !id) return undefined;
  return { provider, id };
}

function getRuntimeModelOverride(ctx: ExtensionContext): ModelRef | undefined {
  const branch = ctx.sessionManager.getBranch() as SessionEntry[];
  let latest: ModelRef | undefined;

  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== MODEL_ENTRY || !entry.data) continue;

    const data = entry.data as { provider?: unknown; id?: unknown; reset?: unknown };
    if (data.reset === true) {
      latest = undefined;
      continue;
    }

    if (typeof data.provider === "string" && typeof data.id === "string" && data.provider && data.id) {
      latest = { provider: data.provider, id: data.id };
    }
  }

  return latest;
}

function configuredModel(config: SelfLearningConfig): ModelRef | undefined {
  const raw = config.model as unknown;

  if (typeof raw === "string") {
    return parseModelRef(raw);
  }

  if (isPlainObject(raw) && typeof raw.provider === "string" && typeof raw.id === "string") {
    return { provider: raw.provider, id: raw.id };
  }

  return undefined;
}

async function getAvailableModelRefs(ctx: ExtensionContext): Promise<ModelRef[]> {
  try {
    const registry = ctx.modelRegistry as unknown as {
      getAvailable?: () => Promise<Array<{ provider?: string; id?: string }>>;
    };

    const models = (await registry.getAvailable?.()) ?? [];
    return models
      .filter((m) => typeof m?.provider === "string" && typeof m?.id === "string")
      .map((m) => ({ provider: m.provider as string, id: m.id as string }))
      .sort((a, b) => {
        const providerDelta = a.provider.localeCompare(b.provider);
        if (providerDelta !== 0) return providerDelta;
        return a.id.localeCompare(b.id);
      });
  } catch {
    return [];
  }
}

async function pickReflectionModel(config: SelfLearningConfig, ctx: ExtensionContext) {
  const diagnostics: string[] = [];

  let validModelsCache: string[] | undefined;
  const getValidModels = async (): Promise<string[]> => {
    if (validModelsCache) return validModelsCache;

    try {
      const registry = ctx.modelRegistry as unknown as {
        getAvailable?: () => Promise<Array<{ provider?: string; id?: string }>>;
      };

      const available = (await registry.getAvailable?.()) ?? [];
      validModelsCache = available
        .filter((m) => typeof m?.provider === "string" && typeof m?.id === "string")
        .map((m) => `${m.provider}/${m.id}`)
        .sort();
    } catch {
      validModelsCache = [];
    }

    return validModelsCache;
  };

  const pushValidModels = async () => {
    const valid = await getValidModels();
    if (valid.length === 0) {
      diagnostics.push("valid_models=(unavailable from model registry)");
      return;
    }

    const shown = valid.slice(0, 40);
    const suffix = valid.length > shown.length ? ` ... (+${valid.length - shown.length} more)` : "";
    diagnostics.push(`valid_models=${shown.join(", ")}${suffix}`);
  };

  const fromConfig = configuredModel(config);
  if (fromConfig) {
    const registry = ctx.modelRegistry as unknown as {
      find?: (provider: string, id: string) => NonNullable<ReturnType<typeof getModel>> | undefined;
    };

    const configured = registry.find?.(fromConfig.provider, fromConfig.id) ?? getModel(fromConfig.provider, fromConfig.id);
    if (!configured) {
      diagnostics.push(`config_model_not_found=${fromConfig.provider}/${fromConfig.id}`);
      await pushValidModels();
    } else {
      const apiKey = await ctx.modelRegistry.getApiKey(configured);
      if (apiKey) {
        diagnostics.push(`selected=config:${configured.provider}/${configured.id}`);
        return { model: configured, apiKey, diagnostics };
      }
      diagnostics.push(`config_model_api_key_missing=${configured.provider}/${configured.id}`);
      await pushValidModels();
    }
  } else {
    diagnostics.push("config_model=(none)");
  }

  if (ctx.model) {
    const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
    if (apiKey) {
      diagnostics.push(`selected=current:${ctx.model.provider}/${ctx.model.id}`);
      return { model: ctx.model, apiKey, diagnostics };
    }
    diagnostics.push(`current_model_api_key_missing=${ctx.model.provider}/${ctx.model.id}`);
  } else {
    diagnostics.push("current_model=(none)");
  }

  return { diagnostics };
}

type RedistillModelCandidate = {
  model: NonNullable<ReturnType<typeof getModel>>;
  apiKey: string;
  source: "configured" | "current";
};

function modelRef(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function redistillTimeoutMs(_model: { provider: string }, repair = false): number {
  return repair ? REDISTILL_REPAIR_TIMEOUT_MS : REDISTILL_MODEL_TIMEOUT_MS;
}

async function buildRedistillModelCandidates(config: SelfLearningConfig, ctx: ExtensionContext): Promise<{
  candidates: RedistillModelCandidate[];
  diagnostics: string[];
}> {
  const diagnostics: string[] = [];
  const candidates: RedistillModelCandidate[] = [];

  const configured = configuredModel(config);

  if (configured) {
    diagnostics.push(`configured.model=${configured.provider}/${configured.id}`);

    const registry = ctx.modelRegistry as unknown as {
      find?: (provider: string, id: string) => NonNullable<ReturnType<typeof getModel>> | undefined;
      getAvailable?: () => Promise<Array<{ provider?: string; id?: string }>>;
    };

    const model = registry.find?.(configured.provider, configured.id) ?? getModel(configured.provider, configured.id);
    if (model) {
      const apiKey = await ctx.modelRegistry.getApiKey(model);
      if (apiKey) {
        candidates.push({
          model,
          apiKey,
          source: "configured",
        });
        diagnostics.push(`redistill_candidates=configured:${modelRef(model)}`);
        return { candidates, diagnostics };
      }
      diagnostics.push(`configured.model_api_key_missing=${configured.provider}/${configured.id}`);
    } else {
      diagnostics.push(`configured.model_not_found=${configured.provider}/${configured.id}`);
    }

    try {
      const available = (await registry.getAvailable?.()) ?? [];
      const valid = available
        .filter((m) => typeof m?.provider === "string" && typeof m?.id === "string")
        .map((m) => `${m.provider}/${m.id}`)
        .sort();
      diagnostics.push(`valid_models=${valid.length > 0 ? valid.slice(0, 40).join(", ") : "(none)"}`);
    } catch {
      diagnostics.push("valid_models=(unavailable from model registry)");
    }
  } else {
    diagnostics.push("configured.model=(none)");
  }

  if (ctx.model) {
    const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
    if (apiKey) {
      candidates.push({
        model: ctx.model,
        apiKey,
        source: "current",
      });
      diagnostics.push(`redistill_candidates=current:${modelRef(ctx.model)}`);
      return { candidates, diagnostics };
    }
    diagnostics.push(`current_model_api_key_missing=${ctx.model.provider}/${ctx.model.id}`);
  } else {
    diagnostics.push("current_model=(none)");
  }

  return { candidates, diagnostics };
}

function isLearningEnabled(config: SelfLearningConfig, ctx: ExtensionContext): boolean {
  const runtimeEnabled = getRuntimeEnabledOverride(ctx);
  return runtimeEnabled ?? config.enabled;
}

function isAutoReflectionEnabled(config: SelfLearningConfig): boolean {
  if (typeof config.autoAfterTask === "boolean") return config.autoAfterTask;
  if (typeof config.autoAfterTurn === "boolean") return config.autoAfterTurn;
  return true;
}

function runGit(root: string, args: string[], timeoutMs: number): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf-8",
    timeout: timeoutMs,
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";

  if (result.error) {
    return {
      ok: false,
      stdout,
      stderr: `${stderr}\n${result.error.message}`.trim(),
    };
  }

  if (typeof result.status === "number" && result.status !== 0) {
    return { ok: false, stdout, stderr };
  }

  return { ok: true, stdout, stderr };
}

function ensureGitRepo(root: string, config: SelfLearningConfig): void {
  if (!config.git.enabled) return;

  mkdirSync(root, { recursive: true });
  const gitDir = join(root, ".git");
  if (existsSync(gitDir)) return;

  runGit(root, ["init"], GIT_FAST_TIMEOUT_MS);
  const readme = join(root, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      "# Self-learning memory\n\nThis folder is auto-managed by pi-self-learning.\n\n- daily/: day-by-day reflections\n- monthly/: monthly summaries\n- core/CORE.md: top-ranked durable learnings\n- long-term-memory.md: complete learning history\n",
      "utf-8",
    );
  }

  const longTerm = longTermMemoryFile(root);
  if (!existsSync(longTerm)) {
    writeFileSync(
      longTerm,
      "# Long-term Memory\n\nComplete history of durable learnings and recurring mistakes.\n\n## All learnings\n- (none yet)\n\n## All watch-outs\n- (none yet)\n",
      "utf-8",
    );
  }

  runGit(root, ["add", "."], GIT_FAST_TIMEOUT_MS);
  runGit(root, ["commit", "-m", "chore(memory): initialize memory repository"], GIT_COMMIT_TIMEOUT_MS);
}

function gitCommit(root: string, files: string[], message: string, config: SelfLearningConfig): void {
  if (!config.git.enabled || !config.git.autoCommit) return;

  const rel = files.map((file) => relative(root, file)).filter((p) => p && !p.startsWith(".."));
  if (rel.length === 0) return;

  const add = runGit(root, ["add", ...rel], GIT_FAST_TIMEOUT_MS);
  if (!add.ok) return;

  const status = runGit(root, ["status", "--porcelain"], GIT_FAST_TIMEOUT_MS);
  if (!status.ok || !status.stdout.trim()) return;

  runGit(root, ["commit", "-m", message], GIT_COMMIT_TIMEOUT_MS);
}

type CoreKind = "learning" | "antiPattern";

type CoreIndexRecord = {
  key: string;
  text: string;
  kind: CoreKind;
  hits: number;
  score: number;
  firstSeen: string;
  lastSeen: string;
};

type CoreIndex = {
  version: 1;
  updatedAt: string;
  items: CoreIndexRecord[];
};

type RedistillCoreResult = {
  before: number;
  after: number;
  processed: number;
  changed: number;
  deduped: number;
  totalChunks: number;
  modelUsage: Array<{ model: string; chunks: number }>;
  files?: string[];
  model: string;
  diagnostics: string[];
  samples: Array<{ kind: CoreKind; before: string; after: string }>;
};

type RedistillProgress = {
  currentChunk: number;
  totalChunks: number;
  processed: number;
  totalItems: number;
  phase: "started" | "stage" | "completed";
  stage: string;
};

function coreIndexFile(root: string): string {
  return join(coreDir(root), "index.json");
}

function parseCoreItems(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
    .filter((line) => line !== "(none yet)");
}

function normalizeLearningText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function learningKey(text: string): string {
  return normalizeLearningText(text).toLowerCase();
}

function loadCoreIndex(root: string): CoreIndex {
  const indexPath = coreIndexFile(root);
  if (existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(readFileSync(indexPath, "utf-8")) as unknown;
      if (isPlainObject(parsed) && Array.isArray(parsed.items)) {
        const items = parsed.items
          .filter((it) => isPlainObject(it))
          .map((it) => ({
            key: String(it.key || ""),
            text: String(it.text || "").trim(),
            kind: it.kind === "antiPattern" ? "antiPattern" : "learning",
            hits: Number.isFinite(Number(it.hits)) ? Number(it.hits) : 1,
            score: Number.isFinite(Number(it.score)) ? Number(it.score) : 1,
            firstSeen: String(it.firstSeen || new Date().toISOString()),
            lastSeen: String(it.lastSeen || new Date().toISOString()),
          }))
          .filter((it) => it.key && it.text);

        return {
          version: 1,
          updatedAt: String(parsed.updatedAt || new Date().toISOString()),
          items,
        };
      }
    } catch {
      // fall through to migration/default
    }
  }

  const corePath = ensureCoreFile(root);
  const migrated = parseCoreItems(readFileSync(corePath, "utf-8")).map((text) => ({
    key: learningKey(text),
    text,
    kind: text.toLowerCase().startsWith("avoid:") ? ("antiPattern" as const) : ("learning" as const),
    hits: 1,
    score: 1,
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  }));

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    items: migrated,
  };
}

function saveCoreIndex(root: string, index: CoreIndex): string {
  const file = coreIndexFile(root);
  mkdirSync(coreDir(root), { recursive: true });
  writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
  return file;
}

function effectiveScore(item: CoreIndexRecord): number {
  const ageMs = Date.now() - Date.parse(item.lastSeen);
  const ageDays = Number.isFinite(ageMs) && ageMs > 0 ? ageMs / (1000 * 60 * 60 * 24) : 0;
  const recencyPenalty = ageDays * 0.05;
  return item.score - recencyPenalty;
}

function sortedIndexItems(index: CoreIndex): CoreIndexRecord[] {
  return [...index.items].sort((a, b) => {
    const scoreDelta = effectiveScore(b) - effectiveScore(a);
    if (Math.abs(scoreDelta) > 0.0001) return scoreDelta;
    if (b.hits !== a.hits) return b.hits - a.hits;
    return Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
  });
}

function selectBalancedCoreItems(index: CoreIndex, maxItems: number): CoreIndexRecord[] {
  const limit = Math.max(1, maxItems);
  const sorted = sortedIndexItems(index);
  const learnings = sorted.filter((x) => x.kind === "learning");
  const antiPatterns = sorted.filter((x) => x.kind === "antiPattern");

  if (learnings.length === 0 || antiPatterns.length === 0) {
    return sorted.slice(0, limit);
  }

  const basePerKind = Math.max(1, Math.floor(limit / 2));
  const pickedLearnings = learnings.slice(0, basePerKind);
  const pickedAntiPatterns = antiPatterns.slice(0, basePerKind);

  const picked = [...pickedLearnings, ...pickedAntiPatterns];
  if (picked.length >= limit) return picked.slice(0, limit);

  const used = new Set(picked.map((item) => item.key));
  const remainder = sorted.filter((item) => !used.has(item.key));
  const needed = limit - picked.length;
  return [...picked, ...remainder.slice(0, needed)];
}

function renderCoreFromIndex(root: string, index: CoreIndex, maxItems: number): string {
  const selected = selectBalancedCoreItems(index, maxItems);
  const learnings = selected.filter((x) => x.kind === "learning");
  const antiPatterns = selected.filter((x) => x.kind === "antiPattern");

  const content = [
    "# Core Learnings",
    "",
    "Most important durable learnings collected over time.",
    `Last updated: ${new Date().toISOString()}`,
    "",
    "This file keeps only top-ranked, most repeated items.",
    "For the complete history, see long-term-memory.md.",
    "",
    "Ranked by frequency + recency (with light decay over time).",
    "",
    "## High-value learnings",
    ...(learnings.length > 0 ? learnings.map((item) => `- ${item.text}`) : ["- (none yet)"]),
    "",
    "## Watch-outs",
    ...(antiPatterns.length > 0
      ? antiPatterns.map((item) => `- ${item.text.replace(/^avoid:\s*/i, "")}`)
      : ["- (none yet)"]),
    "",
  ].join("\n");

  const file = ensureCoreFile(root);
  writeFileSync(file, content, "utf-8");
  return file;
}

function renderLongTermMemoryFromIndex(root: string, index: CoreIndex): string {
  const sorted = sortedIndexItems(index);
  const learnings = sorted.filter((x) => x.kind === "learning");
  const antiPatterns = sorted.filter((x) => x.kind === "antiPattern");

  const content = [
    "# Long-term Memory",
    "",
    "Complete history of durable learnings and recurring mistakes.",
    `Last updated: ${new Date().toISOString()}`,
    "",
    "## All learnings",
    ...(learnings.length > 0 ? learnings.map((item) => `- ${item.text}`) : ["- (none yet)"]),
    "",
    "## All watch-outs",
    ...(antiPatterns.length > 0
      ? antiPatterns.map((item) => `- ${item.text.replace(/^avoid:\s*/i, "")}`)
      : ["- (none yet)"]),
    "",
  ].join("\n");

  const file = longTermMemoryFile(root);
  writeFileSync(file, content, "utf-8");
  return file;
}

function updateCoreFromReflection(root: string, reflection: LearningReflection, maxItems: number): string[] {
  const index = loadCoreIndex(root);
  const nowIso = new Date().toISOString();

  const updates: Array<{ text: string; kind: CoreKind }> = [
    ...reflection.fixes.map((text) => ({ text, kind: "learning" as const })),
    ...reflection.mistakes.map((text) => ({ text: `Avoid: ${text}`, kind: "antiPattern" as const })),
  ]
    .map((entry) => ({ text: normalizeLearningText(entry.text), kind: entry.kind }))
    .filter((entry) => entry.text.length > 0);

  const byKey = new Map(index.items.map((item) => [item.key, item]));

  for (const entry of updates) {
    const key = learningKey(entry.text);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, {
        key,
        text: entry.text,
        kind: entry.kind,
        hits: 1,
        score: 1,
        firstSeen: nowIso,
        lastSeen: nowIso,
      });
      continue;
    }

    existing.text = entry.text;
    existing.kind = entry.kind;
    existing.hits += 1;
    existing.lastSeen = nowIso;

    const incrementBase = 1;
    const repetitionBonus = Math.min(1, existing.hits * 0.08);
    existing.score += incrementBase + repetitionBonus;
  }

  index.updatedAt = nowIso;
  index.items = [...byKey.values()];

  const renderedCore = renderCoreFromIndex(root, index, Math.max(1, maxItems));
  const longTermFile = renderLongTermMemoryFromIndex(root, index);
  const indexFile = saveCoreIndex(root, index);
  return [renderedCore, longTermFile, indexFile];
}

function mergeCoreRecords(items: CoreIndexRecord[]): CoreIndexRecord[] {
  const byKey = new Map<string, CoreIndexRecord>();

  for (const item of items) {
    const existing = byKey.get(item.key);
    if (!existing) {
      byKey.set(item.key, { ...item });
      continue;
    }

    existing.hits += item.hits;
    existing.score += item.score;
    if (Date.parse(item.firstSeen) < Date.parse(existing.firstSeen)) {
      existing.firstSeen = item.firstSeen;
    }
    if (Date.parse(item.lastSeen) > Date.parse(existing.lastSeen)) {
      existing.lastSeen = item.lastSeen;
      existing.text = item.text;
      existing.kind = item.kind;
    }
  }

  return [...byKey.values()];
}

async function redistillCoreIndex(
  root: string,
  config: SelfLearningConfig,
  ctx: ExtensionContext,
  limit?: number,
  dryRun = false,
  onProgress?: (progress: RedistillProgress) => void | Promise<void>,
): Promise<RedistillCoreResult> {
  const index = loadCoreIndex(root);
  const before = index.items.length;
  if (before === 0) {
    return {
      before,
      after: before,
      processed: 0,
      changed: 0,
      deduped: 0,
      totalChunks: 0,
      modelUsage: [],
      model: "(none)",
      diagnostics: [],
      samples: [],
    };
  }

  const sorted = sortedIndexItems(index);
  const targetCount = Math.min(Math.max(1, limit || sorted.length), sorted.length);
  const targetKeys = new Set(sorted.slice(0, targetCount).map((item) => item.key));
  const targets = index.items.filter((item) => targetKeys.has(item.key));

  const modelSelection = await buildRedistillModelCandidates(config, ctx);
  if (modelSelection.candidates.length === 0) {
    throw new Error([
      "No reflection model with API key available for redistill.",
      ...modelSelection.diagnostics,
    ].join("\n"));
  }

  const primaryModelRef = modelRef(modelSelection.candidates[0].model);
  const chunkModelUsage = new Map<string, number>();
  const chunkSize = REDISTILL_CHUNK_SIZE;
  const totalChunks = Math.max(1, Math.ceil(targets.length / chunkSize));
  let processed = 0;
  let changed = 0;
  const rewrittenByKey = new Map<string, string>();
  const samples: Array<{ kind: CoreKind; before: string; after: string }> = [];

  for (let start = 0; start < targets.length; start += chunkSize) {
    const currentChunk = Math.floor(start / chunkSize) + 1;
    if (onProgress) {
      await onProgress({
        currentChunk,
        totalChunks,
        processed,
        totalItems: targets.length,
        phase: "started",
        stage: "requesting model",
      });
    }
    const chunk = targets.slice(start, start + chunkSize);
    const payload = chunk.map((item, idx) => ({
      id: start + idx,
      kind: item.kind,
      text: item.text,
    }));

    let parsed: Map<number, string> | undefined;
    let usedModelRef = "";
    const attemptErrors: string[] = [];
    let lastOutputPreview = "(none)";

    for (const candidate of modelSelection.candidates) {
      const candidateRef = modelRef(candidate.model);
      usedModelRef = candidateRef;

      if (onProgress) {
        await onProgress({
          currentChunk,
          totalChunks,
          processed,
          totalItems: targets.length,
          phase: "stage",
          stage: `requesting model (${candidate.source}:${candidateRef})`,
        });
      }

      let rawForParsing = "";

      try {
        const response = await withTimeout(
          complete(
            candidate.model,
            {
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: buildRedistillPrompt(payload) }],
                  timestamp: Date.now(),
                },
              ],
            },
            { apiKey: candidate.apiKey, maxTokens: REDISTILL_MODEL_MAX_TOKENS },
          ),
          redistillTimeoutMs(candidate.model, false),
          `Redistill model call failed at chunk ${currentChunk}/${totalChunks} (${processed}/${targets.length}) for ${candidateRef}`,
        );

        if (onProgress) {
          await onProgress({
            currentChunk,
            totalChunks,
            processed,
            totalItems: targets.length,
            phase: "stage",
            stage: `model response received (${candidateRef})`,
          });
        }

        rawForParsing = extractTextFromResponseContent(response.content);
        if (!rawForParsing) {
          rawForParsing = previewResponseContent(response.content, 3000);
        }
        lastOutputPreview = compactText(rawForParsing, 700);

        if (onProgress) {
          await onProgress({
            currentChunk,
            totalChunks,
            processed,
            totalItems: targets.length,
            phase: "stage",
            stage: `parsing model output (${candidateRef})`,
          });
        }

        parsed = parseRedistillOutput(rawForParsing);
        if (!parsed) {
          if (onProgress) {
            await onProgress({
              currentChunk,
              totalChunks,
              processed,
              totalItems: targets.length,
              phase: "stage",
              stage: `repairing malformed output (${candidateRef})`,
            });
          }

          const repairResponse = await withTimeout(
            complete(
              candidate.model,
              {
                messages: [
                  {
                    role: "user",
                    content: [{ type: "text", text: buildRedistillRepairPrompt(rawForParsing, payload) }],
                    timestamp: Date.now(),
                  },
                ],
              },
              { apiKey: candidate.apiKey, maxTokens: REDISTILL_REPAIR_MAX_TOKENS },
            ),
            redistillTimeoutMs(candidate.model, true),
            `Redistill repair call failed at chunk ${currentChunk}/${totalChunks} (${processed}/${targets.length}) for ${candidateRef}`,
          );

          const repairRaw = extractTextFromResponseContent(repairResponse.content) || previewResponseContent(repairResponse.content, 3000);
          lastOutputPreview = compactText(repairRaw, 700);
          parsed = parseRedistillOutput(repairRaw);
        }

        if (parsed) {
          chunkModelUsage.set(candidateRef, (chunkModelUsage.get(candidateRef) || 0) + 1);
          break;
        }

        attemptErrors.push(`model=${candidateRef}: output could not be parsed`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attemptErrors.push(`model=${candidateRef}: ${message}`);
      }
    }

    if (!parsed) {
      throw new Error(
        [
          `Could not parse redistill output as required JSON for chunk ${Math.floor(start / chunkSize) + 1}.`,
          ...attemptErrors,
          `last_model=${usedModelRef || "(none)"}`,
          `output_preview=${lastOutputPreview}`,
        ].join("\n"),
      );
    }

    if (onProgress) {
      await onProgress({
        currentChunk,
        totalChunks,
        processed,
        totalItems: targets.length,
        phase: "stage",
        stage: "applying rewrites",
      });
    }

    for (let idx = 0; idx < chunk.length; idx++) {
      const original = chunk[idx];
      const id = start + idx;
      const candidate = normalizeLearningText(parsed.get(id) || original.text);
      const enforced =
        original.kind === "antiPattern"
          ? /^avoid:\s*/i.test(candidate)
            ? candidate
            : `Avoid: ${candidate}`
          : candidate.replace(/^avoid:\s*/i, "");

      const rewritten = normalizeLearningText(enforced) || normalizeLearningText(original.text);
      rewrittenByKey.set(original.key, rewritten);
      processed += 1;

      if (learningKey(rewritten) !== learningKey(original.text)) {
        changed += 1;
        if (samples.length < 8) {
          samples.push({ kind: original.kind, before: original.text, after: rewritten });
        }
      }
    }

    if (onProgress) {
      await onProgress({
        currentChunk,
        totalChunks,
        processed,
        totalItems: targets.length,
        phase: "completed",
        stage: "chunk complete",
      });
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  if (onProgress) {
    await onProgress({
      currentChunk: totalChunks,
      totalChunks,
      processed,
      totalItems: targets.length,
      phase: "stage",
      stage: "merging rewritten items",
    });
  }

  const rewrittenItems = index.items.map((item) => {
    if (!targetKeys.has(item.key)) return item;
    const rewrittenText = rewrittenByKey.get(item.key) || item.text;
    return {
      ...item,
      text: rewrittenText,
      key: learningKey(rewrittenText),
    };
  });

  const mergedItems = mergeCoreRecords(rewrittenItems);
  const after = mergedItems.length;
  const deduped = rewrittenItems.length - mergedItems.length;

  if (!dryRun) {
    const updated: CoreIndex = {
      ...index,
      updatedAt: new Date().toISOString(),
      items: mergedItems,
    };

    if (onProgress) {
      await onProgress({
        currentChunk: totalChunks,
        totalChunks,
        processed,
        totalItems: targets.length,
        phase: "stage",
        stage: "ensuring git repository",
      });
    }
    ensureGitRepo(root, config);

    if (onProgress) {
      await onProgress({
        currentChunk: totalChunks,
        totalChunks,
        processed,
        totalItems: targets.length,
        phase: "stage",
        stage: "writing memory files",
      });
    }
    const files = [
      renderCoreFromIndex(root, updated, Math.max(1, config.maxCoreItems || 20)),
      renderLongTermMemoryFromIndex(root, updated),
      saveCoreIndex(root, updated),
    ];

    if (onProgress) {
      await onProgress({
        currentChunk: totalChunks,
        totalChunks,
        processed,
        totalItems: targets.length,
        phase: "stage",
        stage: "committing memory changes",
      });
    }
    gitCommit(root, files, "chore(memory): redistill core learnings for global reuse", config);

    return {
      before,
      after,
      processed,
      changed,
      deduped,
      totalChunks,
      modelUsage: [...chunkModelUsage.entries()].map(([model, chunks]) => ({ model, chunks })),
      files,
      model: primaryModelRef,
      diagnostics: [
        ...modelSelection.diagnostics,
        `redistill_model_usage=${
          chunkModelUsage.size > 0
            ? [...chunkModelUsage.entries()].map(([m, count]) => `${m}:${count}`).join(", ")
            : "(none)"
        }`,
      ],
      samples,
    };
  }

  return {
    before,
    after,
    processed,
    changed,
    deduped,
    totalChunks,
    modelUsage: [...chunkModelUsage.entries()].map(([model, chunks]) => ({ model, chunks })),
    model: primaryModelRef,
    diagnostics: [
      ...modelSelection.diagnostics,
      `redistill_model_usage=${
        chunkModelUsage.size > 0
          ? [...chunkModelUsage.entries()].map(([m, count]) => `${m}:${count}`).join(", ")
          : "(none)"
      }`,
    ],
    samples,
  };
}

function collectMonthDailyFiles(root: string, month: string): string[] {
  const dir = dailyDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${month}-`) && name.endsWith(".md"))
    .map((name) => join(dir, name))
    .sort();
}

function compactText(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, maxChars)}\n\n...(truncated)`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function latestMonthlyFile(root: string): string | undefined {
  const dir = monthlyDir(root);
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}\.md$/.test(name))
    .sort();
  const latest = files.at(-1);
  return latest ? join(dir, latest) : undefined;
}

function latestDailyFiles(root: string, take: number): string[] {
  const dir = dailyDir(root);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort();
  return files.slice(-Math.max(0, take)).map((name) => join(dir, name));
}

function readTrimmedFile(file: string, maxChars: number): string {
  const raw = readFileSync(file, "utf-8").trim();
  return compactText(raw, maxChars);
}

function buildMemoryContextBundle(root: string, config: SelfLearningConfig, cwd: string): string | undefined {
  const sections: string[] = [];
  const maxChars = Math.max(2000, config.context.maxChars || 12000);
  const maxPerFile = Math.max(1000, Math.floor(maxChars / 4));

  if (config.context.includeCore) {
    const core = coreFile(root);
    if (existsSync(core)) {
      sections.push(`## ${pathForPrompt(core, cwd)}\n${readTrimmedFile(core, maxPerFile)}`);
    }
  }

  const dailyTake = Math.max(0, config.context.includeLastNDaily || 0);
  if (dailyTake > 0) {
    for (const daily of latestDailyFiles(root, dailyTake)) {
      sections.push(`## ${pathForPrompt(daily, cwd)}\n${readTrimmedFile(daily, maxPerFile)}`);
    }
  }

  if (config.context.includeLatestMonthly) {
    const monthly = latestMonthlyFile(root);
    if (monthly && existsSync(monthly)) {
      sections.push(`## ${pathForPrompt(monthly, cwd)}\n${readTrimmedFile(monthly, maxPerFile)}`);
    }
  }

  if (sections.length === 0) return undefined;

  return compactText(
    [
      "# Self-learning memory context",
      "Use this as historical evidence.",
      `Resolved memory root: ${pathForPrompt(root, cwd)}`,
      "",
      ...sections,
    ].join("\n\n"),
    maxChars,
  );
}

function buildMemoryInstruction(config: SelfLearningConfig, root: string, cwd: string): string {
  if (config.context.instructionMode === "off") return "";

  const strictPrefix =
    config.context.instructionMode === "strict"
      ? "You MUST consult self-learning memory when the user asks about history, prior decisions, patterns, regressions, or follow-up work."
      : "Consult self-learning memory when relevant to history and prior decisions.";

  const rootPath = pathForPrompt(root, cwd);
  const corePath = pathForPrompt(coreFile(root), cwd);
  const dailyPath = pathForPrompt(dailyDir(root), cwd);
  const monthlyPath = pathForPrompt(monthlyDir(root), cwd);
  const longTermPath = pathForPrompt(longTermMemoryFile(root), cwd);

  return [
    strictPrefix,
    `Self-learning memory lives under ${rootPath}.`,
    "Memory policy:",
    `1) Start from ${corePath} for durable learnings.`,
    `2) For historical questions, check ${dailyPath}/*.md then ${monthlyPath}/*.md.`,
    "3) Prefer evidence from memory files over guessing.",
    "4) If evidence is missing, explicitly state that and suggest searching memory logs.",
    `5) If you are stuck and need help, consult ${longTermPath} for broader prior fixes and mistakes.`,
  ].join("\n");
}

function describeReflectionSkipReason(reason: ReflectionSkipReason): string {
  switch (reason) {
    case "disabled":
      return "self-learning is disabled (settings or /learning-toggle override)";
    case "no_messages":
      return "no recent messages were found in this branch";
    case "empty_conversation":
      return "conversation serialization produced empty content";
    case "no_model":
      return "no reflection model with an available API key could be resolved";
    case "empty_model_output":
      return "the model returned no text output for reflection";
    case "invalid_model_output":
      return "the model output could not be parsed as the required reflection JSON, even after extraction and repair";
  }
}

async function reflectNow(turnLabel: string, ctx: ExtensionContext): Promise<ReflectNowResult> {
  const settings = loadMergedSettings(ctx.cwd);
  const config = getSetting(settings, "selfLearning", DEFAULT_CONFIG) as SelfLearningConfig;

  if (!isLearningEnabled(config, ctx)) return { reason: "disabled" };

  const messages = getBranchMessages(ctx, config.maxMessagesForReflection);
  if (messages.length === 0) return { reason: "no_messages" };

  const conversationText = serializeConversation(convertToLlm(messages as any));
  if (!conversationText.trim()) return { reason: "empty_conversation" };

  const interruptionSignals = collectInterruptionSignals(ctx, Math.max(config.maxMessagesForReflection * 4, 24));

  const picked = await pickReflectionModel(config, ctx);
  if (!picked.model || !picked.apiKey) {
    return {
      reason: "no_model",
      diagnostics: [...picked.diagnostics, "resolved_model=(none with available API key)"],
    };
  }

  const resolvedModel = `${picked.model.provider}/${picked.model.id}`;

  const response = await withTimeout(
    complete(
      picked.model,
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildReflectionPrompt(
                  conversationText,
                  config.maxLearnings,
                  config.storage.mode,
                  interruptionSignals,
                ),
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: picked.apiKey, maxTokens: 900 },
    ),
    REFLECTION_MODEL_TIMEOUT_MS,
    `Reflection model call failed for ${turnLabel}`,
  );

  const raw = extractTextFromResponseContent(response.content);
  const rawPreview = raw ? compactText(raw, 1200) : previewResponseContent(response.content, 1200);

  if (!raw) {
    return {
      reason: "empty_model_output",
      rawModelOutput: rawPreview,
      diagnostics: [
        ...picked.diagnostics,
        `resolved_model=${resolvedModel}`,
        `response_items=${Array.isArray(response.content) ? response.content.length : 0}`,
      ],
    };
  }

  let parsed = parseReflectionWithFallback(raw);
  let repairRaw: string | undefined;
  let repairPreview: string | undefined;
  let repairResponseItems = 0;

  if (!parsed) {
    const repairResponse = await withTimeout(
      complete(
        picked.model,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: buildReflectionRepairPrompt(raw) }],
              timestamp: Date.now(),
            },
          ],
        },
        { apiKey: picked.apiKey, maxTokens: 900 },
      ),
      REFLECTION_REPAIR_TIMEOUT_MS,
      `Reflection repair call failed for ${turnLabel}`,
    );

    repairResponseItems = Array.isArray(repairResponse.content) ? repairResponse.content.length : 0;
    repairRaw = extractTextFromResponseContent(repairResponse.content);
    repairPreview = repairRaw ? compactText(repairRaw, 1200) : previewResponseContent(repairResponse.content, 1200);

    parsed = repairRaw ? parseReflectionWithFallback(repairRaw) : undefined;
  }

  if (!parsed) {
    return {
      reason: "invalid_model_output",
      rawModelOutput: rawPreview,
      repairModelOutput: repairPreview,
      diagnostics: [
        ...picked.diagnostics,
        `resolved_model=${resolvedModel}`,
        `initial_response_items=${Array.isArray(response.content) ? response.content.length : 0}`,
        `repair_response_items=${repairResponseItems}`,
      ],
    };
  }

  const now = new Date();
  const entry = buildMarkdownEntry(now, turnLabel, parsed);
  const root = resolveStorageRoot(config, ctx.cwd);
  ensureGitRepo(root, config);

  const dailyFile = appendDailyEntry(root, now, entry);
  const coreFiles = updateCoreFromReflection(root, parsed, Math.max(1, config.maxCoreItems || 20));

  gitCommit(root, [dailyFile, ...coreFiles], `chore(memory): ${toDateKeyUTC(now)} ${turnLabel.toLowerCase()}`, config);

  const shortNote = (parsed.mistakes[0] || parsed.fixes[0] || "").slice(0, 180);
  if (shortNote) {
    RUNTIME_NOTES.push(shortNote);
    if (RUNTIME_NOTES.length > 30) RUNTIME_NOTES.splice(0, RUNTIME_NOTES.length - 30);
  }

  return { file: dailyFile };
}

async function generateMonthSummary(
  month: string,
  ctx: ExtensionContext,
): Promise<{ file?: string; dailyCount: number }> {
  const settings = loadMergedSettings(ctx.cwd);
  const config = getSetting(settings, "selfLearning", DEFAULT_CONFIG) as SelfLearningConfig;
  const root = resolveStorageRoot(config, ctx.cwd);

  const files = collectMonthDailyFiles(root, month);
  if (files.length === 0) return { dailyCount: 0 };

  const monthText = compactText(
    files
      .map((file) => `# ${basename(file)}\n\n${readFileSync(file, "utf-8")}`)
      .join("\n\n"),
    180000,
  );

  const picked = await pickReflectionModel(config, ctx);
  if (!picked.model || !picked.apiKey) return { dailyCount: files.length };

  const response = await withTimeout(
    complete(
      picked.model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: buildMonthPrompt(month, monthText) }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: picked.apiKey, maxTokens: 2500 },
    ),
    MONTH_SUMMARY_MODEL_TIMEOUT_MS,
    `Monthly summary model call failed for ${month}`,
  );

  const summary = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  if (!summary) return { dailyCount: files.length };

  ensureGitRepo(root, config);
  const monthly = writeMonthlySummary(
    root,
    month,
    `# Monthly Summary ${month}\n\nGenerated: ${new Date().toISOString()}\n\n${summary}\n`,
  );

  gitCommit(root, [monthly], `chore(memory): monthly summary ${month}`, config);
  return { file: monthly, dailyCount: files.length };
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (_event, ctx) => {
    const settings = loadMergedSettings(ctx.cwd);
    const config = getSetting(settings, "selfLearning", DEFAULT_CONFIG) as SelfLearningConfig;

    if (!isLearningEnabled(config, ctx) || !isAutoReflectionEnabled(config)) return;
    if (Date.now() < skipAutoReflectionUntil) return;

    try {
      if (ctx.hasUI) ctx.ui.setWorkingMessage("learning");
      const result = await reflectNow("Task", ctx);
      if (result.file && ctx.hasUI) {
        ctx.ui.notify(`Self-learning saved: ${result.file}`, "info");
      }
    } catch {
      // Never break normal flow
    } finally {
      if (ctx.hasUI) ctx.ui.setWorkingMessage();
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const settings = loadMergedSettings(ctx.cwd);
    const config = getSetting(settings, "selfLearning", DEFAULT_CONFIG) as SelfLearningConfig;
    if (!isLearningEnabled(config, ctx)) return;

    const pieces: string[] = [];
    const root = config.context.enabled ? resolveStorageRoot(config, ctx.cwd) : undefined;

    if (RUNTIME_NOTES.length > 0) {
      const take = Math.max(1, config.injectLastN || 5);
      const last = RUNTIME_NOTES.slice(-take).map((note) => `- ${note}`).join("\n");
      pieces.push(`## Recent turn notes\n${last}`);
    }

    if (config.context.enabled && root) {
      const bundle = buildMemoryContextBundle(root, config, ctx.cwd);
      if (bundle) pieces.push(bundle);
    }

    const instruction = config.context.enabled && root ? buildMemoryInstruction(config, root, ctx.cwd) : "";
    if (pieces.length === 0 && !instruction) return;

    return {
      message:
        pieces.length > 0
          ? {
              customType: "self-learning-context",
              content: pieces.join("\n\n"),
              display: false,
            }
          : undefined,
      systemPrompt: instruction ? `${event.systemPrompt}\n\n${instruction}` : event.systemPrompt,
    };
  });

  pi.registerCommand("learning-now", {
    description: "Run self-learning reflection now and append to daily file",
    handler: async (_args, ctx) => {
      try {
        if (ctx.hasUI) ctx.ui.setWorkingMessage("learning");
        const result = await reflectNow("Manual", ctx);
        if (!result.file) {
          const detail = result.reason ? describeReflectionSkipReason(result.reason) : "unknown reason";
          let message = `No reflection generated: ${detail}`;

          if (result.diagnostics && result.diagnostics.length > 0) {
            message += `\nDiagnostics:\n${result.diagnostics.map((d) => `- ${d}`).join("\n")}`;
          }

          if (result.reason === "empty_model_output") {
            const rawPreview = result.rawModelOutput ? compactText(result.rawModelOutput, 500) : "(none)";
            message += `\nInitial output:\n${rawPreview}`;
          }

          if (result.reason === "invalid_model_output") {
            const rawPreview = result.rawModelOutput ? compactText(result.rawModelOutput, 500) : "(none)";
            const repairPreview = result.repairModelOutput ? compactText(result.repairModelOutput, 500) : "(none)";
            message += `\nInitial output:\n${rawPreview}\n\nRepair attempt output:\n${repairPreview}`;
          }

          ctx.ui.notify(message, "warning");
          return;
        }
        ctx.ui.notify(`Reflection saved to ${result.file}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`learning-now failed: ${message}`, "error");
      } finally {
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
      }
    },
  });

  pi.registerCommand("learning-month", {
    description: "Create month summary: /learning-month [YYYY-MM]",
    handler: async (args, ctx) => {
      const month = args.trim() || toMonthKeyUTC(new Date());
      if (!/^\d{4}-\d{2}$/.test(month)) {
        ctx.ui.notify("Usage: /learning-month [YYYY-MM]", "warning");
        return;
      }

      try {
        if (ctx.hasUI) ctx.ui.setWorkingMessage("learning");
        const result = await generateMonthSummary(month, ctx);
        if (!result.file) {
          if (result.dailyCount === 0) {
            ctx.ui.notify(`No daily files found for ${month}`, "warning");
          } else {
            ctx.ui.notify(`Could not generate summary for ${month}`, "warning");
          }
          return;
        }
        ctx.ui.notify(`Monthly summary saved: ${result.file}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`learning-month failed: ${message}`, "error");
      } finally {
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
      }
    },
  });

  pi.registerCommand("learning-redistill", {
    description: "Re-distill core memory into cross-project rules: /learning-redistill [limit] [--dry-run] [--yes]",
    handler: async (args, ctx) => {
      skipAutoReflectionUntil = Date.now() + REDISTILL_SKIP_AUTO_REFLECTION_MS;
      ctx.ui.notify(`learning-redistill invoked with args: ${args.trim() || "(none)"}`, "info");

      const tokens = args
        .trim()
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean);

      let dryRun = false;
      let assumeYes = false;
      let limit: number | undefined;

      for (const token of tokens) {
        if (token === "--dry-run") {
          dryRun = true;
          continue;
        }
        if (token === "--yes") {
          assumeYes = true;
          continue;
        }
        if (/^\d+$/.test(token)) {
          if (limit !== undefined) {
            ctx.ui.notify("Usage: /learning-redistill [limit] [--dry-run] [--yes]", "warning");
            return;
          }
          limit = Number(token);
          continue;
        }

        ctx.ui.notify("Usage: /learning-redistill [limit] [--dry-run] [--yes]", "warning");
        return;
      }

      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        ctx.ui.notify("Limit must be a positive integer", "warning");
        return;
      }

      const settings = loadMergedSettings(ctx.cwd);
      const config = getSetting(settings, "selfLearning", DEFAULT_CONFIG) as SelfLearningConfig;
      const root = resolveStorageRoot(config, ctx.cwd);

      if (config.storage.mode !== "global") {
        ctx.ui.notify(
          "learning-redistill is intended for global memory. Set selfLearning.storage.mode=global before running.",
          "warning",
        );
        return;
      }

      const index = loadCoreIndex(root);
      const targetCount = Math.min(limit || index.items.length, index.items.length);
      if (targetCount === 0) {
        ctx.ui.notify(`No core entries found in ${coreIndexFile(root)}`, "warning");
        return;
      }

      if (!dryRun && !assumeYes && targetCount > 200) {
        const ui = ctx.ui as unknown as { confirm?: (message: string) => Promise<boolean | undefined> };

        if (!ui.confirm) {
          ctx.ui.notify(
            `This operation will process ${targetCount} entries. Re-run with --yes to proceed, or use --dry-run first.`,
            "warning",
          );
          return;
        }

        const confirmed = await ui.confirm(
          `Re-distill ${targetCount} entries in global memory using model calls. Continue?`,
        );

        if (!confirmed) {
          ctx.ui.notify("learning-redistill cancelled", "info");
          return;
        }
      }

      try {
        if (ctx.hasUI) ctx.ui.setWorkingMessage("learning redistill: preparing");

        const estimatedChunks = Math.max(1, Math.ceil(targetCount / REDISTILL_CHUNK_SIZE));
        ctx.ui.notify(
          `Starting redistill: entries=${targetCount}, estimated_chunks=${estimatedChunks}, chunk_size=${REDISTILL_CHUNK_SIZE}, timeout_per_chunk=${Math.round(REDISTILL_MODEL_TIMEOUT_MS / 1000)}s, max_tokens=${REDISTILL_MODEL_MAX_TOKENS}, mode=${dryRun ? "dry-run" : "write"}`,
          "info",
        );

        const startedAt = Date.now();
        let lastProgressLine = "";
        const result = await redistillCoreIndex(root, config, ctx, limit, dryRun, async (progress) => {
          const line = `chunk ${progress.currentChunk}/${progress.totalChunks} ${progress.phase} (${progress.processed}/${progress.totalItems}): ${progress.stage}`;

          if (ctx.hasUI) {
            ctx.ui.setWorkingMessage(`learning redistill: ${line}`);
          }

          if (
            line !== lastProgressLine &&
            (progress.phase === "started" || progress.phase === "completed" || progress.currentChunk === 1)
          ) {
            lastProgressLine = line;
            ctx.ui.notify(`Redistill progress: ${line}`, "info");
          }
        });
        const action = dryRun ? "Dry run completed" : "Redistill completed";

        ctx.ui.notify(
          `${action}: processed=${result.processed}, changed=${result.changed}, deduped=${result.deduped}, items=${result.before}->${result.after}, model=${result.model}`,
          "info",
        );

        if (result.samples.length > 0) {
          const preview = result.samples
            .slice(0, 3)
            .map(
              (sample, idx) =>
                `${idx + 1}. [${sample.kind}] ${compactText(sample.before, 90)} -> ${compactText(sample.after, 90)}`,
            )
            .join("\n");
          ctx.ui.notify(`Sample rewrites:\n${preview}`, "info");
        }

        if (result.files && result.files.length > 0) {
          ctx.ui.notify(`Updated files:\n${result.files.map((f) => `- ${f}`).join("\n")}`, "info");
        }

        if (result.diagnostics.length > 0) {
          const shownDiagnostics = result.diagnostics.slice(0, 8).map((d) => compactText(d, 180));
          const extra = result.diagnostics.length > shownDiagnostics.length ? `\n- ... (+${result.diagnostics.length - shownDiagnostics.length} more)` : "";
          ctx.ui.notify(`Model diagnostics:\n${shownDiagnostics.map((d) => `- ${d}`).join("\n")}${extra}`, "info");
        }

        const elapsedMs = Date.now() - startedAt;
        const changedPct = result.processed > 0 ? Math.round((result.changed / result.processed) * 100) : 0;
        const usage =
          result.modelUsage.length > 0
            ? result.modelUsage.map((m) => `${m.model}:${m.chunks}`).join(", ")
            : "(none)";

        ctx.ui.notify(
          [
            "Redistill stats:",
            `- mode: ${dryRun ? "dry-run" : "write"}`,
            `- elapsed: ${(elapsedMs / 1000).toFixed(1)}s`,
            `- chunks: ${result.totalChunks}`,
            `- processed: ${result.processed}`,
            `- changed: ${result.changed} (${changedPct}%)`,
            `- deduped: ${result.deduped}`,
            `- items: ${result.before} -> ${result.after}`,
            `- model usage: ${usage}`,
          ].join("\n"),
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const hint =
          /timed out/i.test(message)
            ? "\nHint: try /learning-redistill 100 --dry-run, switch redistill model with /learning-model-global or selfLearning.model, or rerun with a smaller limit."
            : "";
        ctx.ui.notify(`learning-redistill failed: ${message}${hint}`, "error");
      } finally {
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
      }
    },
  });

  pi.registerCommand("learning-toggle", {
    description: "Toggle self-learning on/off for this session branch",
    handler: async (_args, ctx) => {
      const settings = loadMergedSettings(ctx.cwd);
      const config = getSetting(settings, "selfLearning", DEFAULT_CONFIG) as SelfLearningConfig;
      const current = isLearningEnabled(config, ctx);
      const next = !current;

      pi.appendEntry(TOGGLE_ENTRY, { enabled: next, ts: Date.now() });
      ctx.ui.notify(`Self-learning ${next ? "enabled" : "disabled"} for this branch`, "info");
    },
  });

  pi.registerCommand("learning-model", {
    description: "Set summarization model: /learning-model (selector) or /learning-model <provider/id> | reset",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) {
        const settings = loadMergedSettings(ctx.cwd);
        const config = getSetting(settings, "selfLearning", DEFAULT_CONFIG) as SelfLearningConfig;
        const configModel = configuredModel(config);
        const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";

        const models = await getAvailableModelRefs(ctx);
        if (models.length === 0) {
          ctx.ui.notify("No available models found in model registry", "warning");
          return;
        }

        const configuredLabel = configModel ? `${configModel.provider}/${configModel.id}` : "(none)";
        const selectorTitle = `Select learning reflection model (configured: ${configuredLabel} | current: ${currentModel})`;

        const options = ["reset", ...models.map((m) => `${m.provider}/${m.id}`)];
        const selected = await ctx.ui.select(selectorTitle, options);
        if (!selected) return;

        if (selected === "reset") {
          pi.appendEntry(MODEL_ENTRY, { reset: true, ts: Date.now() });
          ctx.ui.notify("Learning model override cleared for this branch", "info");
          return;
        }

        const parsedFromSelection = parseModelRef(selected);
        if (!parsedFromSelection) {
          ctx.ui.notify(`Invalid model selection: ${selected}`, "warning");
          return;
        }

        const registry = ctx.modelRegistry as unknown as {
          find?: (provider: string, id: string) => NonNullable<ReturnType<typeof getModel>> | undefined;
        };
        const selectedModel =
          registry.find?.(parsedFromSelection.provider, parsedFromSelection.id) ??
          getModel(parsedFromSelection.provider, parsedFromSelection.id);
        if (!selectedModel) {
          ctx.ui.notify(`Model not found: ${parsedFromSelection.provider}/${parsedFromSelection.id}`, "warning");
          return;
        }

        const selectedApiKey = await ctx.modelRegistry.getApiKey(selectedModel);
        if (!selectedApiKey) {
          ctx.ui.notify(`No API key available for ${parsedFromSelection.provider}/${parsedFromSelection.id}`, "warning");
        }

        pi.appendEntry(MODEL_ENTRY, {
          provider: parsedFromSelection.provider,
          id: parsedFromSelection.id,
          ts: Date.now(),
        });
        ctx.ui.notify(`Learning model set to ${parsedFromSelection.provider}/${parsedFromSelection.id}`, "info");
        return;
      }

      if (raw === "reset") {
        pi.appendEntry(MODEL_ENTRY, { reset: true, ts: Date.now() });
        ctx.ui.notify("Learning model override cleared for this branch", "info");
        return;
      }

      const parsed = parseModelRef(raw);
      if (!parsed) {
        ctx.ui.notify("Usage: /learning-model <provider/id> | reset", "warning");
        return;
      }

      const exists = getModel(parsed.provider, parsed.id);
      if (!exists) {
        ctx.ui.notify(`Model not found: ${parsed.provider}/${parsed.id}`, "warning");
        return;
      }

      const apiKey = await ctx.modelRegistry.getApiKey(exists);
      if (!apiKey) {
        ctx.ui.notify(`No API key available for ${parsed.provider}/${parsed.id}`, "warning");
      }

      pi.appendEntry(MODEL_ENTRY, { provider: parsed.provider, id: parsed.id, ts: Date.now() });
      ctx.ui.notify(`Learning model set to ${parsed.provider}/${parsed.id}`, "info");
    },
  });

  pi.registerCommand("learning-model-global", {
    description: "Set global summarization model: /learning-model-global <provider/id> | reset | show",
    handler: async (args, ctx) => {
      const raw = args.trim();
      const path = globalSettingsPath();

      if (!raw || raw === "show") {
        const globalSettings = loadJsonFile(path);
        const globalModel = parseModelRef(
          `${getSetting(globalSettings, "selfLearning.model.provider", "")}/${getSetting(globalSettings, "selfLearning.model.id", "")}`,
        );

        if (!globalModel) {
          ctx.ui.notify(`No global learning model set in ${path}`, "info");
        } else {
          ctx.ui.notify(`Global learning model: ${globalModel.provider}/${globalModel.id}`, "info");
        }
        return;
      }

      if (raw === "reset") {
        upsertModelInSettings(path, undefined);
        ctx.ui.notify(`Global learning model cleared in ${path}`, "info");
        return;
      }

      const parsed = parseModelRef(raw);
      if (!parsed) {
        ctx.ui.notify("Usage: /learning-model-global <provider/id> | reset | show", "warning");
        return;
      }

      const model = getModel(parsed.provider, parsed.id);
      if (!model) {
        ctx.ui.notify(`Model not found: ${parsed.provider}/${parsed.id}`, "warning");
        return;
      }

      const apiKey = await ctx.modelRegistry.getApiKey(model);
      if (!apiKey) {
        ctx.ui.notify(`No API key available for ${parsed.provider}/${parsed.id}`, "warning");
      }

      upsertModelInSettings(path, parsed);
      ctx.ui.notify(`Global learning model set to ${parsed.provider}/${parsed.id}`, "info");
    },
  });

  pi.registerCommand("learning-daily", {
    description: "Show today's daily self-learning file path",
    handler: async (_args, ctx) => {
      const settings = loadMergedSettings(ctx.cwd);
      const config = getSetting(settings, "selfLearning", DEFAULT_CONFIG) as SelfLearningConfig;
      const root = resolveStorageRoot(config, ctx.cwd);
      const file = join(dailyDir(root), `${toDateKeyUTC(new Date())}.md`);
      ctx.ui.notify(`Today's learning file: ${file}`, "info");
    },
  });

  pi.registerCommand("learning-status", {
    description: "Show self-learning status and effective config",
    handler: async (_args, ctx) => {
      const settings = loadMergedSettings(ctx.cwd);
      const config = getSetting(settings, "selfLearning", DEFAULT_CONFIG) as SelfLearningConfig;
      const runtimeEnabled = getRuntimeEnabledOverride(ctx);
      const enabled = runtimeEnabled ?? config.enabled;
      const autoReflectionEnabled = isAutoReflectionEnabled(config);
      const autoReflectionSource =
        typeof config.autoAfterTask === "boolean"
          ? "autoAfterTask"
          : typeof config.autoAfterTurn === "boolean"
            ? "autoAfterTurn (legacy)"
            : "default";
      const root = resolveStorageRoot(config, ctx.cwd);
      const runtimeModel = getRuntimeModelOverride(ctx);
      const configModel = configuredModel(config);
      const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";

      let configModelStatus = "not configured";
      if (configModel) {
        const model = getModel(configModel.provider, configModel.id);
        if (!model) {
          configModelStatus = "configured but not found in model registry";
        } else {
          const apiKey = await ctx.modelRegistry.getApiKey(model);
          configModelStatus = apiKey ? "configured and API key available" : "configured but API key missing";
        }
      }

      const globalSettings = loadJsonFile(globalSettingsPath());
      const globalModel = parseModelRef(
        `${getSetting(globalSettings, "selfLearning.model.provider", "")}/${getSetting(globalSettings, "selfLearning.model.id", "")}`,
      );

      ctx.ui.notify(`selfLearning.enabled=${enabled} (runtime override: ${runtimeEnabled ?? "none"})`, "info");
      ctx.ui.notify(`selfLearning.autoAfterTask=${autoReflectionEnabled} (source: ${autoReflectionSource})`, "info");
      ctx.ui.notify(`selfLearning.storage.mode=${config.storage.mode}`, "info");
      ctx.ui.notify(`selfLearning.storage.root=${root}`, "info");
      ctx.ui.notify(`selfLearning.git.enabled=${config.git.enabled}`, "info");
      ctx.ui.notify(`selfLearning.git.autoCommit=${config.git.autoCommit}`, "info");
      ctx.ui.notify(`selfLearning.context.enabled=${config.context.enabled}`, "info");
      ctx.ui.notify(`selfLearning.context.includeCore=${config.context.includeCore}`, "info");
      ctx.ui.notify(`selfLearning.context.includeLatestMonthly=${config.context.includeLatestMonthly}`, "info");
      ctx.ui.notify(`selfLearning.context.includeLastNDaily=${config.context.includeLastNDaily}`, "info");
      ctx.ui.notify(`selfLearning.context.maxChars=${config.context.maxChars}`, "info");
      ctx.ui.notify(`selfLearning.context.instructionMode=${config.context.instructionMode}`, "info");
      ctx.ui.notify(
        configModel
          ? `selfLearning.model=${configModel.provider}/${configModel.id} (configured)`
          : "selfLearning.model=(none configured; using current session model)",
        "info",
      );
      ctx.ui.notify(`selfLearning.model.configStatus=${configModelStatus}`, "info");
      ctx.ui.notify(`selfLearning.model.currentSession=${currentModel}`, "info");
      ctx.ui.notify(
        `selfLearning.modelResolutionOrder=configured model -> current session model${runtimeModel ? " (runtime /learning-model override is currently ignored for reflection)" : ""}`,
        "info",
      );
      ctx.ui.notify(
        globalModel
          ? `selfLearning.globalModel=${globalModel.provider}/${globalModel.id} (${globalSettingsPath()})`
          : `selfLearning.globalModel=(none) (${globalSettingsPath()})`,
        "info",
      );
    },
  });
}
