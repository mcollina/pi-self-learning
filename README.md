# pi-self-learning

A [pi](https://github.com/mariozechner/pi) extension that keeps a **git-backed memory** of each session:

- automatic task-level reflections
- daily logs
- monthly summaries
- a durable **core learnings** file
- configurable summarization model (branch-level and global)

## What it does

After each completed agent task (when enabled), it:
1. extracts what went wrong and how it was fixed,
2. appends the entry to a daily markdown file,
3. updates `core/CORE.md` with top-ranked durable learnings (balanced across learnings + watch-outs),
4. writes full history to `long-term-memory.md`,
5. maintains a scored `core/index.json` (frequency + recency),
6. commits changes in a dedicated memory git repository.

## Memory folder layout

Default project path: `.pi/self-learning-memory`

```txt
.pi/self-learning-memory/
├── .git/
├── README.md
├── daily/
│   └── YYYY-MM-DD.md
├── monthly/
│   └── YYYY-MM.md
├── long-term-memory.md
└── core/
    ├── CORE.md
    └── index.json
```

## Installation

```bash
pi install npm:pi-self-learning
```

## Local development

### Method 1 (copy extension)

Global:
```bash
cp extensions/self-learning.ts ~/.pi/agent/extensions/
```

Project:
```bash
mkdir -p .pi/extensions
cp extensions/self-learning.ts .pi/extensions/
```

### Method 2 (settings)

Project `.pi/settings.json`:
```json
{
  "packages": ["./extensions/self-learning.ts"]
}
```

## Configuration

```json
{
  "selfLearning": {
    "enabled": true,
    "autoAfterTask": true,
    "injectLastN": 5,
    "maxMessagesForReflection": 8,
    "maxLearnings": 8,
    "maxCoreItems": 20,
    "storage": {
      "mode": "project",
      "projectPath": ".pi/self-learning-memory",
      "globalPath": "~/.pi/agent/self-learning-memory"
    },
    "git": {
      "enabled": true,
      "autoCommit": true
    },
    "context": {
      "enabled": true,
      "includeCore": true,
      "includeLatestMonthly": false,
      "includeLastNDaily": 0,
      "maxChars": 12000,
      "instructionMode": "strict"
    },
    "model": {
      "provider": "google",
      "id": "gemini-2.5-flash"
    }
  }
}
```

`selfLearning.model` can be set in:
- global `~/.pi/agent/settings.json` (global default)
- project `.pi/settings.json` (project override)

`selfLearning.autoAfterTask` controls automatic reflection after each completed agent task.
Legacy `selfLearning.autoAfterTurn` is still accepted for backward compatibility.

## Loading memory into context

Use `selfLearning.context` to inject memory into each turn:

- `includeCore`: inject `core/CORE.md` (enabled by default)
- `includeLatestMonthly`: inject latest `monthly/YYYY-MM.md` (disabled by default)
- `includeLastNDaily`: inject last N daily files from `daily/` (default `0`)
- `instructionMode`:
  - `off`: do not add memory policy to system prompt
  - `advisory`: suggest checking memory logs
  - `strict`: enforce checking memory logs for history-related questions

With `instructionMode: "strict"`, the extension appends policy telling the assistant to:
1. consult `core/CORE.md` first,
2. check `daily/*.md` then `monthly/*.md` for historical questions,
3. prefer evidence over guessing,
4. if stuck, consult `long-term-memory.md` for broader prior fixes and mistakes.

## Commands

- `/learning-now` → generate reflection now
- `/learning-month [YYYY-MM]` → generate monthly summary
- `/learning-daily` → show today’s daily file path
- `/learning-toggle` → enable/disable for current branch
- `/learning-model` → open model selector (available models)
- `/learning-model <provider/id> | reset` → set/reset branch model override
- `/learning-model-global <provider/id> | reset | show` → set/reset/show global model in `~/.pi/agent/settings.json`
- `/learning-status` → show effective config and model resolution

## Notes

- Reflection errors are non-blocking.
- If model/API key is unavailable, reflection is skipped gracefully.
- Memory repo commits are automatic after each memory update (if enabled).
