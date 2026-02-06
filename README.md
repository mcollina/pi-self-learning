# pi-self-learning

A [pi](https://github.com/mariozechner/pi) extension that keeps a **git-backed memory** of each session:

- automatic turn reflections
- daily logs
- monthly summaries
- a durable **core learnings** file
- configurable summarization model (branch-level and global)

## What it does

After each turn (when enabled), it:
1. summarizes what happened,
2. extracts learnings, anti-patterns, and next-turn advice,
3. appends the entry to a daily markdown file,
4. updates `core/CORE.md` with important durable learnings,
5. commits changes in a dedicated memory git repository.

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
└── core/
    └── CORE.md
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
    "autoAfterTurn": true,
    "injectLastN": 5,
    "maxMessagesForReflection": 8,
    "maxLearnings": 8,
    "maxCoreItems": 150,
    "storage": {
      "mode": "project",
      "projectPath": ".pi/self-learning-memory",
      "globalPath": "~/.pi/agent/self-learning-memory"
    },
    "git": {
      "enabled": true,
      "autoCommit": true
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

## Commands

- `/learning-now` → generate reflection now
- `/learning-month [YYYY-MM]` → generate monthly summary
- `/learning-daily` → show today’s daily file path
- `/learning-toggle` → enable/disable for current branch
- `/learning-model <provider/id> | reset` → set/reset branch model override
- `/learning-model-global <provider/id> | reset | show` → set/reset/show global model in `~/.pi/agent/settings.json`
- `/learning-status` → show effective config and model resolution

## Notes

- Reflection errors are non-blocking.
- If model/API key is unavailable, reflection is skipped gracefully.
- Memory repo commits are automatic after each memory update (if enabled).
