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
  autoAfterTurn: boolean;
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
  model?: {
    provider?: string;
    id?: string;
  };
};

type LearningReflection = {
  summary: string;
  learnings: string[];
  antiPatterns: string[];
  nextTurnAdvice: string[];
};

type SessionEntry = {
  type: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
};

const DEFAULT_CONFIG: SelfLearningConfig = {
  enabled: true,
  autoAfterTurn: true,
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
    includeLatestMonthly: true,
    includeLastNDaily: 3,
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

    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    const list = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean)
        : [];

    return {
      summary: summary || "No summary",
      learnings: list(parsed.learnings),
      antiPatterns: list(parsed.antiPatterns),
      nextTurnAdvice: list(parsed.nextTurnAdvice),
    };
  } catch {
    return undefined;
  }
}

function buildReflectionPrompt(conversationText: string, maxLearnings: number): string {
  return [
    "You are a coding session reflection engine.",
    "Summarize what happened and extract learnings.",
    "Return STRICT JSON only with this schema:",
    '{"summary":"string","learnings":["..."],"antiPatterns":["..."],"nextTurnAdvice":["..."]}',
    "Rules:",
    "- Keep summary under 120 words.",
    `- Keep each array short (max ${maxLearnings}).`,
    "- Prefer specific, actionable points.",
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
  lines.push("### Summary");
  lines.push(reflection.summary || "No summary");
  lines.push("");

  lines.push("### Learnings");
  if (reflection.learnings.length === 0) lines.push("- (none)");
  for (const item of reflection.learnings) lines.push(`- ${item}`);
  lines.push("");

  lines.push("### Anti-patterns");
  if (reflection.antiPatterns.length === 0) lines.push("- (none)");
  for (const item of reflection.antiPatterns) lines.push(`- ${item}`);
  lines.push("");

  lines.push("### Next-turn advice");
  if (reflection.nextTurnAdvice.length === 0) lines.push("- (none)");
  for (const item of reflection.nextTurnAdvice) lines.push(`- ${item}`);
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
  if (config.model?.provider && config.model?.id) {
    return { provider: config.model.provider, id: config.model.id };
  }
  return undefined;
}

async function pickReflectionModel(config: SelfLearningConfig, ctx: ExtensionContext) {
  const candidates = [] as NonNullable<ReturnType<typeof getModel>>[];

  const runtimeModel = getRuntimeModelOverride(ctx);
  const fromConfig = configuredModel(config);

  if (runtimeModel) {
    const chosen = getModel(runtimeModel.provider, runtimeModel.id);
    if (chosen) candidates.push(chosen);
  }

  if (fromConfig) {
    const chosen = getModel(fromConfig.provider, fromConfig.id);
    if (chosen) candidates.push(chosen);
  }

  const flash = getModel("google", "gemini-2.5-flash");
  if (flash) candidates.push(flash);

  const mini = getModel("openai", "gpt-5-mini");
  if (mini) candidates.push(mini);

  if (ctx.model) candidates.push(ctx.model);

  const deduped = new Set<string>();
  for (const model of candidates) {
    const key = `${model.provider}/${model.id}`;
    if (deduped.has(key)) continue;
    deduped.add(key);

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (apiKey) return { model, apiKey };
  }

  return undefined;
}

function isLearningEnabled(config: SelfLearningConfig, ctx: ExtensionContext): boolean {
  const runtimeEnabled = getRuntimeEnabledOverride(ctx);
  return runtimeEnabled ?? config.enabled;
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

function parseCoreItems(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function writeCoreItems(root: string, items: string[]): string {
  const file = ensureCoreFile(root);
  const content = [
    "# Core Learnings",
    "",
    "Most important durable learnings collected over time.",
    `Last updated: ${new Date().toISOString()}`,
    "",
    "## Learnings",
    ...items.map((item) => `- ${item}`),
    "",
  ].join("\n");

  writeFileSync(file, content, "utf-8");
  return file;
}

function updateCoreFromReflection(root: string, reflection: LearningReflection, maxItems: number): string {
  const file = ensureCoreFile(root);
  const existing = parseCoreItems(readFileSync(file, "utf-8"));

  const incoming = [
    ...reflection.learnings,
    ...reflection.antiPatterns.map((a) => `Avoid: ${a}`),
  ].map((x) => x.trim()).filter(Boolean);

  const seen = new Set<string>();
  const merged: string[] = [];

  for (const item of [...incoming, ...existing]) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
    if (merged.length >= maxItems) break;
  }

  return writeCoreItems(root, merged.length ? merged : ["(none yet)"]);
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

  if (config.context.includeLatestMonthly) {
    const monthly = latestMonthlyFile(root);
    if (monthly && existsSync(monthly)) {
      sections.push(`## ${relative(root, monthly)}\n${readTrimmedFile(monthly, maxPerFile)}`);
    }
  }

  const dailyTake = Math.max(0, config.context.includeLastNDaily || 0);
  if (dailyTake > 0) {
    for (const daily of latestDailyFiles(root, dailyTake)) {
      sections.push(`## ${relative(root, daily)}\n${readTrimmedFile(daily, maxPerFile)}`);
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
    "2) For historical questions, check monthly/*.md then daily/*.md.",
    "3) Prefer evidence from memory files over guessing.",
    "4) If evidence is missing, explicitly state that and suggest searching memory logs.",
  ].join("\n");
}

async function reflectNow(turnLabel: string, ctx: ExtensionContext): Promise<{ file?: string; summary?: string }> {
  const settings = loadMergedSettings(ctx.cwd);
  const config = getSetting(settings, "selfLearning", DEFAULT_CONFIG) as SelfLearningConfig;

  if (!isLearningEnabled(config, ctx)) return {};

  const messages = getBranchMessages(ctx, config.maxMessagesForReflection);
  if (messages.length === 0) return {};

  const conversationText = serializeConversation(convertToLlm(messages as any));
  if (!conversationText.trim()) return {};

  const picked = await pickReflectionModel(config, ctx);
  if (!picked) return {};

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

  const raw = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  const parsed = parseReflection(raw);
  if (!parsed) return {};

  const now = new Date();
  const entry = buildMarkdownEntry(now, turnLabel, parsed);
  const root = resolveStorageRoot(config, ctx.cwd);
  ensureGitRepo(root, config);

  const dailyFile = appendDailyEntry(root, now, entry);
  const core = updateCoreFromReflection(root, parsed, Math.max(10, config.maxCoreItems || 150));

  gitCommit(root, [dailyFile, core], `chore(memory): ${toDateKeyUTC(now)} ${turnLabel.toLowerCase()}`, config);

  const shortSummary = parsed.summary.slice(0, 180);
  RUNTIME_NOTES.push(shortSummary);
  if (RUNTIME_NOTES.length > 30) RUNTIME_NOTES.splice(0, RUNTIME_NOTES.length - 30);

  return { file: dailyFile, summary: parsed.summary };
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
  if (!picked) return { dailyCount: files.length };

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
  pi.on("turn_end", async (event, ctx) => {
    const settings = loadMergedSettings(ctx.cwd);
    const config = getSetting(settings, "selfLearning", DEFAULT_CONFIG) as SelfLearningConfig;

    if (!isLearningEnabled(config, ctx) || !config.autoAfterTurn) return;

    try {
      const result = await reflectNow(`Turn ${event.turnIndex}`, ctx);
      if (result.file && ctx.hasUI) {
        ctx.ui.notify(`Self-learning saved: ${result.file}`, "info");
      }
    } catch {
      // Never break normal flow
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
        const result = await reflectNow("Manual", ctx);
        if (!result.file) {
          ctx.ui.notify("No reflection generated", "warning");
          return;
        }
        ctx.ui.notify(`Reflection saved to ${result.file}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`learning-now failed: ${message}`, "error");
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
    description: "Set summarization model: /learning-model <provider/id> | reset",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) {
        const runtimeModel = getRuntimeModelOverride(ctx);
        const settings = loadMergedSettings(ctx.cwd);
        const config = getSetting(settings, "selfLearning", DEFAULT_CONFIG) as SelfLearningConfig;
        const configModel = configuredModel(config);
        const active = runtimeModel ?? configModel;

        if (active) {
          ctx.ui.notify(`Current learning model: ${active.provider}/${active.id}`, "info");
        } else {
          ctx.ui.notify("No specific learning model set (using fallback order)", "info");
        }
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
      const root = resolveStorageRoot(config, ctx.cwd);
      const runtimeModel = getRuntimeModelOverride(ctx);
      const configModel = configuredModel(config);
      const model = runtimeModel ?? configModel;

      const globalSettings = loadJsonFile(globalSettingsPath());
      const globalModel = parseModelRef(
        `${getSetting(globalSettings, "selfLearning.model.provider", "")}/${getSetting(globalSettings, "selfLearning.model.id", "")}`,
      );

      ctx.ui.notify(`selfLearning.enabled=${enabled} (runtime override: ${runtimeEnabled ?? "none"})`, "info");
      ctx.ui.notify(`selfLearning.autoAfterTurn=${config.autoAfterTurn}`, "info");
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
        model
          ? `selfLearning.model=${model.provider}/${model.id}${runtimeModel ? " (runtime override)" : " (merged settings)"}`
          : "selfLearning.model=(fallback order)",
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
