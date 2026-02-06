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
  maxCoreItems: 150,
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

function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
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
  return isAbsolute(projectPath) ? projectPath : join(cwd, projectPath);
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

function buildReflectionPrompt(conversationText: string, maxLearnings: number): string {
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
    "",
    "<conversation>",
    conversationText,
    "</conversation>",
  ].join("\n");
}

function buildMonthPrompt(month: string, monthText: string): string {
  return [
    `Create a monthly summary for ${month}.`,
    "Return markdown with these sections:",
    "- Wins",
    "- Recurring issues",
    "- Most important learnings",
    "- Next-month focus",
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

function isLearningEnabled(config: SelfLearningConfig, ctx: ExtensionContext): boolean {
  const runtimeEnabled = getRuntimeEnabledOverride(ctx);
  return runtimeEnabled ?? config.enabled;
}

function isAutoReflectionEnabled(config: SelfLearningConfig): boolean {
  if (typeof config.autoAfterTask === "boolean") return config.autoAfterTask;
  if (typeof config.autoAfterTurn === "boolean") return config.autoAfterTurn;
  return true;
}

function ensureGitRepo(root: string, config: SelfLearningConfig): void {
  if (!config.git.enabled) return;

  mkdirSync(root, { recursive: true });
  const gitDir = join(root, ".git");
  if (existsSync(gitDir)) return;

  spawnSync("git", ["-C", root, "init"], { encoding: "utf-8" });
  const readme = join(root, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      "# Self-learning memory\n\nThis folder is auto-managed by pi-self-learning.\n\n- daily/: day-by-day reflections\n- monthly/: monthly summaries\n- core/CORE.md: durable learnings\n",
      "utf-8",
    );
  }
  spawnSync("git", ["-C", root, "add", "."], { encoding: "utf-8" });
  spawnSync("git", ["-C", root, "commit", "-m", "chore(memory): initialize memory repository"], {
    encoding: "utf-8",
  });
}

function gitCommit(root: string, files: string[], message: string, config: SelfLearningConfig): void {
  if (!config.git.enabled || !config.git.autoCommit) return;

  const rel = files.map((file) => relative(root, file)).filter((p) => p && !p.startsWith(".."));
  if (rel.length === 0) return;

  spawnSync("git", ["-C", root, "add", ...rel], { encoding: "utf-8" });
  const status = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf-8" });
  if (!status.stdout?.trim()) return;

  spawnSync("git", ["-C", root, "commit", "-m", message], { encoding: "utf-8" });
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
  const kindBoost = item.kind === "antiPattern" ? 0.2 : 0;
  return item.score + kindBoost - recencyPenalty;
}

function renderCoreFromIndex(root: string, index: CoreIndex, maxItems: number): string {
  const sorted = [...index.items]
    .sort((a, b) => {
      const scoreDelta = effectiveScore(b) - effectiveScore(a);
      if (Math.abs(scoreDelta) > 0.0001) return scoreDelta;
      if (b.hits !== a.hits) return b.hits - a.hits;
      return Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
    })
    .slice(0, Math.max(1, maxItems));

  const learnings = sorted.filter((x) => x.kind === "learning");
  const antiPatterns = sorted.filter((x) => x.kind === "antiPattern");

  const content = [
    "# Core Learnings",
    "",
    "Most important durable learnings collected over time.",
    `Last updated: ${new Date().toISOString()}`,
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
        score: entry.kind === "antiPattern" ? 1.2 : 1,
        firstSeen: nowIso,
        lastSeen: nowIso,
      });
      continue;
    }

    existing.text = entry.text;
    existing.kind = entry.kind;
    existing.hits += 1;
    existing.lastSeen = nowIso;

    const incrementBase = entry.kind === "antiPattern" ? 1.2 : 1;
    const repetitionBonus = Math.min(1, existing.hits * 0.08);
    existing.score += incrementBase + repetitionBonus;
  }

  index.updatedAt = nowIso;
  index.items = [...byKey.values()];

  const renderedCore = renderCoreFromIndex(root, index, Math.max(10, maxItems));
  const indexFile = saveCoreIndex(root, index);
  return [renderedCore, indexFile];
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

function buildMemoryContextBundle(root: string, config: SelfLearningConfig): string | undefined {
  const sections: string[] = [];
  const maxChars = Math.max(2000, config.context.maxChars || 12000);
  const maxPerFile = Math.max(1000, Math.floor(maxChars / 4));

  if (config.context.includeCore) {
    const core = coreFile(root);
    if (existsSync(core)) {
      sections.push(`## core/CORE.md\n${readTrimmedFile(core, maxPerFile)}`);
    }
  }

  const dailyTake = Math.max(0, config.context.includeLastNDaily || 0);
  if (dailyTake > 0) {
    for (const daily of latestDailyFiles(root, dailyTake)) {
      sections.push(`## ${relative(root, daily)}\n${readTrimmedFile(daily, maxPerFile)}`);
    }
  }

  if (config.context.includeLatestMonthly) {
    const monthly = latestMonthlyFile(root);
    if (monthly && existsSync(monthly)) {
      sections.push(`## ${relative(root, monthly)}\n${readTrimmedFile(monthly, maxPerFile)}`);
    }
  }

  if (sections.length === 0) return undefined;

  return compactText(
    [
      "# Self-learning memory context",
      "Use this as historical evidence.",
      "",
      ...sections,
    ].join("\n\n"),
    maxChars,
  );
}

function buildMemoryInstruction(config: SelfLearningConfig): string {
  if (config.context.instructionMode === "off") return "";

  const strictPrefix =
    config.context.instructionMode === "strict"
      ? "You MUST consult self-learning memory when the user asks about history, prior decisions, patterns, regressions, or follow-up work."
      : "Consult self-learning memory when relevant to history and prior decisions.";

  return [
    strictPrefix,
    "Memory policy:",
    "1) Start from core/CORE.md for durable learnings.",
    "2) For historical questions, check daily/*.md then monthly/*.md.",
    "3) Prefer evidence from memory files over guessing.",
    "4) If evidence is missing, explicitly state that and suggest searching memory logs.",
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

  const picked = await pickReflectionModel(config, ctx);
  if (!picked.model || !picked.apiKey) {
    return {
      reason: "no_model",
      diagnostics: [...picked.diagnostics, "resolved_model=(none with available API key)"],
    };
  }

  const resolvedModel = `${picked.model.provider}/${picked.model.id}`;

  const response = await complete(
    picked.model,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildReflectionPrompt(conversationText, config.maxLearnings) }],
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey: picked.apiKey, maxTokens: 900 },
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
    const repairResponse = await complete(
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
  const coreFiles = updateCoreFromReflection(root, parsed, Math.max(10, config.maxCoreItems || 150));

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

  const response = await complete(
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

    if (RUNTIME_NOTES.length > 0) {
      const take = Math.max(1, config.injectLastN || 5);
      const last = RUNTIME_NOTES.slice(-take).map((note) => `- ${note}`).join("\n");
      pieces.push(`## Recent turn notes\n${last}`);
    }

    if (config.context.enabled) {
      const root = resolveStorageRoot(config, ctx.cwd);
      const bundle = buildMemoryContextBundle(root, config);
      if (bundle) pieces.push(bundle);
    }

    const instruction = config.context.enabled ? buildMemoryInstruction(config) : "";
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
