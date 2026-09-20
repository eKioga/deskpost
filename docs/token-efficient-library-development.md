# Token-Efficient Library Development

**Status:** planning brief, recorded 2026-08-21 and corrected 2026-08-25. The phase 1 frozen spec
supersedes its measurement method and implementation sequence.

The Library has become two compatible things: a research and problem-solving environment, and an
increasingly active development environment. The same durable knowledge model supports both, but
development produces longer conversations, more tool calls, repeated test output, and larger
working context. Token efficiency is therefore the first development-workflow improvement to plan:
reducing that overhead early should preserve more of the weekly model window and lower the cost of
per-token delegates without removing any Library capability.

## What was measured

A read-only review examined the repository's instruction surfaces, MCP tool catalog, current Desk
state, Book and Project catalogs, the Library Development Hub, and structural token counters from
`~/.codex/sessions` only. It excluded Claude sessions entirely, even though Claude performs much of
the reading. Message bodies were not used for the usage totals. The sample covers 25 Codex sessions
rooted at `D:\Library` from 2026-08-17 through 2026-08-21 and likely overweights the recent
development push; the records do not label ordinary reading, research, and development separately.

This brief did not record its counting algorithm, so its 89.3M gross-input figure is unreproducible
as written: it cannot be confirmed or refuted from this document alone. Three demonstrated errors
are available in these transcript shapes: summing cumulative Codex `total_token_usage` overcounts by
11.9x in a measured session, summing Codex's non-additive fields overcounts by 2.9x, and summing
duplicated Claude records overcounts by more than 2x. Phase 1's cross-engine baseline supersedes this
measurement with explicit per-engine formulas, deduplication, cumulative-counter handling, and a
replayable byte-prefix source manifest.

| Measure | Observed |
| --- | ---: |
| Model events carrying token counts | 951 |
| Gross input tokens | 89.3M |
| Cached input tokens | 84.5M (94.7%) |
| Uncached input tokens | 4.7M |
| Output tokens | 398k |
| Median input per event | 83.4k |
| 95th-percentile input per event | 194.1k |
| Maximum input in one event | 224.4k |
| Events above 200k input | 43 |
| Observed model context window | 258.4k |
| Compaction events | 4 |

Fourteen of the 25 sessions exceeded one million cumulative input tokens. Gross input was about 224
times output. The 94.7% cache share is excellent and materially softens price and latency, but
cached content still occupies the context window. At the 95th percentile only about 64k tokens of
the observed window remained.

This is a real long-session and attention problem, not evidence that every Library request is
expensive. The fixed workspace guidance is comparatively modest: `AGENTS.md` is 1,248 words;
`CLAUDE.md` is 780 words; Claude's measured always-on surface is 885 of its 1,100-word budget; and
the dynamic Desk sentence is small. A combined Book Catalog read was approximately 1.8k tokens and
the active Project Catalog approximately 91. By contrast, a 2026-08-25 read of the current Library
Development `_project` page returned 82,901 characters, or about 20,725 tokens at the explicitly
approximate `chars/4` method. `Now` contributed 8,716 estimated tokens (42.1%), `Connected tools`
5,351 (25.8%), `Next` 3,726 (18.0%), `Connected knowledge` 2,433 (11.7%), `Prior implementation`
283 (1.4%), and `Purpose` 192 (0.9%); title, frontmatter, and preamble contributed 24 (0.1%).

Repository size is not prompt size. The roughly 1.88 GB under `raw/` is not itself a context cost
because the Library searches one named source batch. That scoped retrieval design is already doing
the right thing.

## Where development spends context

1. **Conversation growth.** Each turn carries the accumulated transcript and its tool results.
   Cache reuse makes repetition cheaper but does not make it disappear from the context window.
2. **Large tool returns.** Shell and wait results contributed an estimated 1.47M tokens of raw
   transcript material in the measured sessions; the largest individual result was about 44.8k.
   Those bytes can then be carried through later turns.
3. **A hot Project Hub page carrying cold history.** The Library Development Hub describes
   `_project` as orientation and open items, yet its `Now` section contains substantial historical,
   superseded, and implementation-reference material.
4. **Potential tool-schema fan-out.** The Library exposes eight validated-reader tools (about 1.2k
   tokens of definitions) and 23 Basic Memory tools (about 7.2k) before counting other harness
   tools. This matters if a client eagerly loads them; deferred clients avoid most of it.
5. **Late compaction.** Only four compactions appeared while 43 events crossed 200k input tokens.

## Recommended sequence

### 1. Establish a cross-engine retroactive baseline

Use the structural usage already present in Claude and Codex session histories. Keep their different
cache formulas separate, report prompt segments rather than claiming workflow attribution where it
does not exist, and make comparisons reproducible with a byte-limited source manifest. Measure
tool-result UTF-8 bytes and inter-record elapsed time; neither is model latency.

The acceptance rule is feature-preserving: a lower-token run is an improvement only when the same
task still succeeds with the same safety boundary and evidence.

### 2. Remove cold closed items from the hot Project Hub

Move reader-approved closed items from `Now` and `Next` to append-only history through the existing
gated edit path, preserving every open item and reader-visible dependency. There is no 1-3k-token
target in phase 1. The measured prediction is about 20,725 to about 11,000 estimated tokens, not an
acceptance threshold. `Connected knowledge` plus `Connected tools` remains the next lever at 7,784
estimated tokens (38%); `read_open_project_briefing` already serves that dependency material in a
bounded return of about 700 tokens.

The sanctioned Project Hub editor enforces a simple shape rule for `Now`: every column-zero list
entry must carry `[ ]` or `[x]`, while nested bullets, fenced examples, and orientation prose remain
valid. This is not a page-wide guarantee. Direct Basic Memory writes bypass the editor entirely, so
the rule is discipline on the bounded helper path and remains deliberately bypassable.

### 3. Make large results artifacts, not transcript

Gate runners, inventories, searches, and delegates should return a small structured result while
retaining full evidence outside the conversation. The result should carry status, counts, important
findings, a path or identifier, a digest, and an explicit way to request more. Add pagination and
default/max result sizes where appropriate. Full logs remain available; they simply stop traveling
through every later model turn.

### 4. Compact at development milestones

Compact after a design decision is accepted, an implementation phase lands, the gate completes, a
research packet is synthesized, or a publication/triage plan is finalized. Persist a concise
milestone record first. Resume freely within a healthy phase; do not carry raw reads and every test
iteration through the next phase solely to avoid a short handoff.

### 5. Expose only tools relevant to the phase

Measure whether each harness eagerly loads MCP schemas. Where it does, use deferred discovery or a
task-scoped tool set. In particular, consider a bounded Basic Memory facade that advertises only the
catalog, permitted reads, and exact active-Project writes the Library actually allows. Hiding
destructive operations already denied by policy removes schema cost and tool-selection ambiguity
without removing a usable feature.

### 6. Preserve prompt-cache stability

The observed cache share is an asset. Keep stable policy at the front of the prompt, place variable
Desk state after it, avoid mid-session configuration changes, and state each rule once. Cache writes
were trackable all along: Codex exposes `cache_write_input_tokens`, and Claude exposes
`cache_creation_input_tokens`. Track those alongside cache reads. Caching and compaction solve
different problems and should be evaluated together.

### 7. Experiment with compression only for evidence packets

The Library already resembles hierarchical memory: the Desk and active Hub are hot context; Books,
Notebook material, history, and raw sources are colder tiers pulled in when needed. Test extractive
or model-assisted compression only on discovery packets, catalog summaries, long source excerpts,
and historical Project notes. Always retain source pointers and a route to reopen the full text.
Never compress approval boundaries, exact action plans, safety policy, or source passages whose
wording is evidence.

### 8. Prefer relevance to capacity

Do not open or retrieve more material merely because the model can hold it. Rank and return fewer,
better passages, keep the current question next to the evidence, and let the model ask for the next
page. The Desk gate and scoped raw search already implement this principle well.

## Research basis

- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model) recommends
  lean prompts, relevant tool exposure, explicit cache measurement, programmatic tool calling for
  bounded reduction work, and representative quality/cost evaluation.
- [OpenAI compaction guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)
  recommends compaction after major milestones rather than every turn.
- [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) reports large token
  savings from deferred tool discovery and from processing intermediate tool results before they
  enter model context.
- [MemGPT](https://arxiv.org/abs/2310.08560) describes hierarchical, virtual context management;
  the Library already has much of this architecture.
- [Lost in the Middle](https://arxiv.org/abs/2307.03172) shows that more context can reduce effective
  retrieval when relevant information is buried among distractors.
- [LLMLingua](https://arxiv.org/abs/2310.05736) demonstrates aggressive prompt compression, but its
  benchmark results justify a bounded evidence-packet experiment, not compression of policy.

## Next planning step

Run a fresh planning session with Claude and the `grill-me-codex` skill. Start from this record and
produce a phased development spec. The session should challenge the measurements, identify which
harness controls are actually available, select representative workflow evals, define token and
quality baselines, and rank the smallest feature-preserving changes. Begin with observability and
the Project Hub briefing path; do not implement compression or tool-surface changes until the evals
can detect a regression.
