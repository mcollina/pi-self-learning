# PLAN: Make `pi-self-learning` more ReasoningBank-like without losing pi-native ergonomics

## Goal

Improve `pi-self-learning` by adding:
- targeted memory retrieval before task start
- reusable success-strategy capture, not only mistake/fix capture
- better durable-memory promotion rules
- richer metadata and feedback loops

Keep these current strengths intact:
- pi hook integration (`agent_end`, `before_agent_start`)
- git-backed durable memory
- daily/monthly/core files
- non-blocking behavior and backward compatibility

## Design principle

Adopt the **useful parts** of ReasoningBank:
- retrieval of relevant prior experience
- learning from both success and failure
- more structured reusable memory

Do **not** copy the research system wholesale:
- do not depend on raw chain-of-thought storage
- do not replace readable markdown/git-backed storage with JSONL-only memory
- do not make retrieval similarity-only with no ranking/usefulness controls

## Delivery strategy

Implement in two stages:

### Phase 1: Hybrid retrieval + richer reflections
No embedding dependency required.
Use lexical scoring + current durable ranking + optional LLM reranking.

### Phase 2: True embedding-backed retrieval
Add only when pi/provider APIs make this clean and stable.

---

## Phase 1 scope

### 1) Extend config

Add new config blocks under `selfLearning`:

```ts
reflection: {
  includeStrategies: boolean,
  maxStrategies: number,
  promotion: {
    enabled: boolean,
    minLength: number,
    requireActionVerb: boolean,
    rejectGeneric: boolean,
    maxPromotedPerReflection: number,
  }
},
retrieval: {
  enabled: boolean,
  mode: "off" | "hybrid" | "hybrid+rerank",
  topK: number,
  maxCandidates: number,
  minScore: number,
  maxChars: number,
  includeCoreFallback: boolean,
  includeRuntimeNotesInQuery: boolean,
  includeRecentMessagesInQuery: number,
  trackUsage: boolean,
  scoreWeights: {
    lexical: number,
    rank: number,
    recency: number,
    scope: number,
  }
}
```

Default intent:
- keep current behavior working out of the box
- enable retrieval by default in a conservative mode
- allow disabling or simplifying retrieval when needed

### 2) Expand reflection schema

Current reflection output:

```json
{"mistakes":["..."],"fixes":["..."]}
```

Target schema:

```json
{
  "strategies": ["..."],
  "mistakes": ["..."],
  "fixes": ["..."],
  "outcome": "success|failure|blocked|interrupted|mixed"
}
```

Requirements:
- remain backward-compatible with older `mistakes/fixes` only outputs
- still accept older `antiPatterns/learnings` fallback fields
- keep strict JSON + repair flow

### 3) Update daily journal format

Add a new section to each daily entry:
- `Reusable strategies`

Suggested order:
1. Reusable strategies
2. What went wrong
3. How it was fixed
4. Outcome

This preserves readability while making successful behaviors visible for later synthesis.

### 4) Introduce richer durable memory kinds

Current durable kinds:
- `learning`
- `antiPattern`

Target durable kinds:
- `strategy`
- `learning`
- `antiPattern`

Mapping:
- `strategies` -> `strategy`
- `fixes` -> `learning`
- `mistakes` -> `antiPattern` with `Avoid:` prefix

### 5) Add promotion gate before durable core updates

Current behavior promotes all reflection items directly into core memory.

Target behavior:
- always write full reflection to daily log
- only promote durable candidates that pass a filter

Promotion heuristics:
- minimum length
- imperative/actionable wording preferred
- reject generic fluff like “be careful”, “double check”, “pay attention”
- reject over-specific repo/file references in global mode
- cap number promoted per reflection
- dedupe against existing durable records

This should reduce memory bloat and improve signal quality.

### 6) Expand `core/index.json` metadata

Keep backward compatibility, but move to a richer record shape.

Add fields like:
- `outcome`
- `storageMode`
- `source`
- `sourceDailyFiles`
- `toolNames`
- `retrievedCount`
- `appliedCount`
- `lastRetrievedAt`
- `lastAppliedAt`

This enables:
- explainable retrieval
- better ranking
- feedback loops
- future pruning/clustering

### 7) Add hybrid retrieval before agent start

Current behavior injects:
- runtime notes
- static `CORE.md`
- optional recent daily/monthly files

Target behavior:
- build a retrieval query from the current task context
- score durable memory records
- inject only the top relevant items
- fall back to `CORE.md` bundle if retrieval finds nothing useful

#### Retrieval query inputs
Use a combination of:
- current user request
- last few messages
- recent runtime notes
- optionally cwd/repo context

#### Retrieval scoring
For Phase 1, use weighted hybrid scoring:
- lexical similarity
- durable rank score (`score`, `hits`, current recency logic)
- recentness bonus
- scope bonus (project/global compatibility)

Optional rerank step:
- take top N candidates from hybrid score
- ask LLM to rerank the most relevant items for the current task
- use strict JSON output and existing repair strategy if needed

### 8) Track retrieval usage and usefulness

When items are retrieved:
- increment `retrievedCount`
- store `lastRetrievedAt`

After the next reflection:
- compare retrieved items against reflected strategies/fixes
- if a retrieved item appears to have informed the work, increment `appliedCount`
- store `lastAppliedAt`

This creates a minimal closed learning loop.

### 9) Update rendered core memory

`CORE.md` should evolve from a two-section layout to three sections:
- High-value strategies
- High-value learnings
- Watch-outs

Selection logic should balance across all present kinds, not just learnings vs anti-patterns.

### 10) Add retrieval debugging command

Add:
- `/learning-retrieve-debug`

It should show:
- retrieval query preview
- top candidates
- lexical/rank/recency/scope sub-scores
- final selected items
- whether reranking ran

This is necessary to tune behavior safely.

---

## Phase 2 scope

### 11) Add embedding-backed retrieval

Once cleanly supported, replace or augment lexical retrieval with embeddings.

Possible storage additions:
- `core/embeddings.jsonl`
- or inline embedding metadata tied to core records

Embedding retrieval ranking should combine:
- semantic similarity
- durable score/hits
- recency
- scope match
- historical usefulness (`appliedCount`)

### 12) Add clustering / comparative synthesis

Periodically cluster similar durable or recent daily items and synthesize stronger canonical rules.

Candidates for this later phase:
- monthly redistill improvements
- dedupe of near-duplicate rules
- multi-entry synthesis of repeated patterns

### 13) Add multi-trajectory comparison features

Adopt a ReasoningBank-style comparative synthesis flow for repeated attempts on similar work:
- compare successes and failures
- extract higher-confidence strategies
- promote only when repeated across multiple sessions/tasks

This is explicitly phase 2/3 work, not part of the first patch.

---

## File-level implementation plan

## `extensions/self-learning.ts`

### A. Config and types
Update near the top of the file:
- `SelfLearningConfig`
- `LearningReflection`
- `CoreKind`
- `CoreIndexRecord`
- `CoreIndex`
- `DEFAULT_CONFIG`

### B. Reflection prompt + parsing
Update:
- reflection prompt builder
- reflection repair prompt expectations if needed
- `parseReflection()`
- backward compatibility parsing

### C. Daily entry rendering
Update:
- markdown entry builder to include strategies and outcome

### D. Durable memory updates
Update:
- core index loading/migration logic
- promotion gate helpers
- durable candidate builder
- core update logic
- balanced selection/rendering across 3 kinds

### E. Retrieval helpers
Add:
- query builder
- lexical tokenization / similarity scoring
- weighted candidate scorer
- optional reranker
- compact retrieved-memory context builder

### F. Hook integration
Update:
- `before_agent_start` to prefer retrieved targeted memory over static bundle
- `reflectNow()` to track strategy extraction and possible retrieval application

### G. Commands
Add:
- `/learning-retrieve-debug`

Potential later addition:
- `/learning-promotions-debug`

## `README.md`
Update in the same behavior change:
- config example
- retrieval explanation
- new reflection behavior (`strategies`)
- new command docs
- examples of targeted memory injection

## `AGENTS.md`
Update in the same behavior change:
- reflection pipeline description
- core index kind/metadata description
- context injection flow now including retrieval
- command list if new command is added

---

## Backward compatibility requirements

Must preserve:
- non-blocking hooks
- UTC date handling
- current settings merge order
- old memory files loading successfully
- old reflection JSON still parseable

If `core/index.json` changes shape:
- load old records without failing
- default missing metadata fields
- migrate in memory when saving next time

If retrieval fails:
- do not block agent startup
- fall back to current static memory bundle behavior

---

## Validation plan

There is no automated test suite yet, so validate manually in pi.

### Manual checks
1. `/learning-status`
   - verify new config values appear correctly
2. `/learning-now`
   - verify strategies/mistakes/fixes are written to today’s daily file
3. inspect memory root
   - verify `core/index.json` metadata is preserved and extended safely
4. start a new task
   - verify retrieved memory is injected when relevant
5. `/learning-retrieve-debug`
   - verify candidate ranking and selection are understandable
6. project mode vs global mode
   - ensure global mode still strips project-specific wording appropriately
7. `/learning-redistill`
   - ensure new record shape remains compatible with redistill flows

### Regression checks
- reflection still works when model output is malformed and needs repair
- no change breaks `before_agent_start`
- empty or missing memory files still behave gracefully
- git-backed memory commits still work

---

## Recommended implementation order

### Step 1
- add config fields
- add `strategies` + `outcome` to reflection schema
- update daily markdown entry

### Step 2
- add `strategy` durable kind
- add promotion gate
- extend `core/index.json` metadata with backward-compatible loading

### Step 3
- add hybrid retrieval scoring
- wire retrieval into `before_agent_start`
- keep current static bundle as fallback

### Step 4
- add retrieval usage tracking
- add `/learning-retrieve-debug`

### Step 5
- update `README.md` and `AGENTS.md`

### Step 6
- only after Phase 1 is stable, explore embedding-backed retrieval

---

## Non-goals for the first patch

Do not implement all of these in v1:
- provider-specific embedding integrations
- raw chain-of-thought storage
- benchmark-style multi-trial scaling loops
- full clustering/synthesis pipeline
- large storage format migration beyond safe backward-compatible extension

---

## Success criteria

The project is better if, after Phase 1:
- the extension captures reusable successful strategies, not just fixes to mistakes
- the agent sees smaller, more relevant memory context before starting work
- durable memory quality improves because weak items no longer auto-promote
- retrieved memories can be inspected and explained
- all of this works without weakening the current pi-native, readable, git-backed workflow
