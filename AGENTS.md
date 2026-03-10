This file provides guidance to AI coding agents like Claude Code (claude.ai/code), Cursor AI, Codex, Gemini CLI, GitHub Copilot, and other AI coding assistants when working with code in this repository.

## Project at a glance

- This repo is a **single pi extension package** (`pi-self-learning`).
- Runtime logic is concentrated in **`extensions/self-learning.ts`**.
- The extension implements a reflection loop: analyze recent conversation after completed agent tasks for mistakes/fixes, persist learnings to markdown/json files, optionally commit to a dedicated memory git repo, and inject memory back into future prompts.

## Common commands in this repo

There are currently **no npm scripts** for build/lint/test in `package.json`.

Use these commands for day-to-day development:

```bash
# install dependencies (peer dep is provided by host pi environment)
npm install

# create a publishable tarball to verify package contents
npm pack

# local extension development: copy extension into a project's local pi extensions folder
mkdir -p .pi/extensions
cp extensions/self-learning.ts .pi/extensions/

# local extension development: copy extension into global pi agent extensions folder
cp extensions/self-learning.ts ~/.pi/agent/extensions/
```

Alternative loading method (from `README.md`):

```json
{
  "packages": ["./extensions/self-learning.ts"]
}
```

Place that in project `.pi/settings.json`.

### Tests

- There is **no automated test suite** in this repository right now.
- There is no "single test" command available yet.
- Validate behavior manually inside pi via extension commands:
  - `/learning-now`
  - `/learning-status`
  - `/learning-month [YYYY-MM]`
  - `/learning-redistill [limit] [--dry-run] [--yes]` (when validating global-memory migration behavior)

## Quick start checklist (for AI agents)

1. Read `README.md` first for installation/config/commands.
2. Read `extensions/self-learning.ts` end-to-end before making behavior changes.
3. Decide whether the change affects:
   - reflection pipeline (`agent_end`)
   - context injection (`before_agent_start`)
   - memory storage format (`daily`, `monthly`, `core/index.json`)
4. If adding config, wire it through merged settings (global + project) and keep defaults in `DEFAULT_CONFIG`.
5. Manually validate in pi with `/learning-status` and `/learning-now`; verify files written under configured memory root.
6. If behavior or commands change, update `README.md` and this `AGENTS.md` in the same change.

## High-level architecture

### 1) Configuration layering and overrides

`self-learning.ts` resolves config in this order:

1. defaults (`DEFAULT_CONFIG`)
2. global settings `~/.pi/agent/settings.json`
3. project settings `<cwd>/.pi/settings.json`
4. branch runtime overrides stored as session custom entries:
   - `self-learning:toggle` (enabled/disabled)
   - `self-learning:model` (provider/id override or reset)

Settings merge is deep for plain objects (`deepMerge`).

### 2) Task-end reflection pipeline

On `agent_end` (when enabled and `autoAfterTask`):

1. collect recent branch messages (`maxMessagesForReflection`)
2. serialize conversation to text
3. run LLM reflection prompt expecting strict JSON:
   - mistakes
   - fixes
   - scope-aware wording:
     - `storage.mode=project`: keep project-specific detail when useful
     - `storage.mode=global`: distill to cross-project reusable actions (avoid repo-specific identifiers)
4. append markdown entry to `daily/YYYY-MM-DD.md`
5. update durable memory:
   - `core/index.json` (scored records)
   - `core/CORE.md` (top-ranked render)
   - `long-term-memory.md` (complete learnings history)
6. optionally auto-commit changes in memory repo

Reflection failures are intentionally non-blocking.

### 3) Memory storage model

Memory root is resolved from config:

- project mode: `.pi/self-learning-memory` (default)
- global mode: `~/.pi/agent/self-learning-memory`

Expected layout:

- `daily/` turn-level journal entries
- `monthly/` generated month summaries
- `core/CORE.md` top-ranked durable learnings
- `long-term-memory.md` complete learnings history
- `core/index.json` canonical scored index

If git is enabled, the extension initializes a repo in the memory root and commits updates.

### 4) Core learnings ranking strategy

Durable learnings are tracked in `core/index.json` records:

- normalized key
- kind: `learning` or `antiPattern`
- hits, score, firstSeen, lastSeen

Ranking favors:

- higher score/hits
- recency (with light time decay)
- balanced representation in `CORE.md` (learnings + watch-outs each get reserved slots when both exist)

`CORE.md` is rendered from this ranked index (do not treat `CORE.md` as the only source of truth).

### 5) Context injection before agent start

On `before_agent_start`, extension can inject:

- recent in-memory runtime notes (`injectLastN`)
- bundled memory files (`core`, optional latest monthly, optional last N daily)
- optional system prompt memory policy (`instructionMode`: off/advisory/strict)

Important path rule: injected headings and memory-policy instructions must reference the resolved memory file paths under the actual memory root, not synthetic `core/CORE.md` paths relative to the agent's current cwd. In project mode, resolve relative storage paths from the nearest ancestor `.pi/settings.json` (or nearest git root if no project settings file exists).

Keep this flow intact when editing; it is how historical memory influences future turns.

### 6) Model resolution for reflections

Reflection model selection order:

1. merged config model (`selfLearning.model`)
2. fallback current `ctx.model`

The extension only uses a candidate if an API key is available from `ctx.modelRegistry`.
If the configured model is missing/invalid, diagnostics include the reason and available model list.

Redistill model resolution:

- `/learning-redistill` first tries the configured `selfLearning.model`
- If no configured model or it lacks API key, falls back to current session model (`ctx.model`)
- If neither is available, diagnostics show the failure reason and available models
## Key extension commands

Implemented in `self-learning.ts`:

- `/learning-now`
- `/learning-month [YYYY-MM]`
- `/learning-redistill [limit] [--dry-run] [--yes]`
- `/learning-toggle`
- `/learning-model` (interactive selector)
- `/learning-model <provider/id> | reset`
- `/learning-model-global <provider/id> | reset | show`
- `/learning-daily`
- `/learning-status`

When adding or changing behavior, update command descriptions and `README.md` in the same change.

## Editing constraints for this codebase

- Keep timestamps/date partitioning in UTC (`toDateKeyUTC`, `toMonthKeyUTC`, `toTimeUTC`) unless migrating all readers/writers.
- Preserve non-blocking behavior in turn hooks; extension should not break normal agent flow.
- If you change memory file formats (`daily`, `monthly`, `core/index.json`, `long-term-memory.md`), include migration/backward-compat handling in code.
