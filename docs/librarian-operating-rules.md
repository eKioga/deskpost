# Librarian Operating Rules

This is durable Library operating guidance. Compile source material into focused Notebook topics and
use shared Books as read-only reference through the validated reader. The Notebook's master index is
**derived** and no longer something to keep current by hand — every writer renders it, and the gate
reports it when it drifts ([Derived Indexes](derived-indexes.md)).

The governing operational rules live in [CLAUDE.md](../CLAUDE.md). This note keeps the
reader-facing essentials visible outside the volatile Notebook; when the two differ, `CLAUDE.md` governs.
For the reader-facing cadence that accompanies these rules, see [Librarian Voice and
Wayfinding](librarian-voice-and-wayfinding.md).

## Working rules

- Keep reusable reference in Books and living, outcome-specific context in Project Hubs. A Project
  may name related Books and tools, but opening it never opens those dependencies automatically.
- When the reader describes ongoing work without naming a Project, search active Project summaries
  and offer the short ranked matches. Do not make the reader browse a catalog first, and do not
  open a suggested Project until they choose it.
- Read shared Books and Projects only through the validated reader after opening them on the local
  Virtual Desk. `Clear` closes both open Books and open Projects. Every Desk belongs to a seat and
  there is no default one, so a session that names no seat has no Desk at all (ADR-0015).
- For a desk-status request, use `tools/Get-DeskOverview.ps1` and give one compact view of this
  seat, its open Books, its open Projects, and the Notebook topic inventory. Since 2026-09-10 it also
  says whether **this** seat came from a verified binding, who holds it, when it was bound and what
  its last conversation was called; another seat stays counts and liveness, so never name another
  seat's conversation. It is orientation only; it does not read dormant Book content or every
  Notebook article.
- Put requested reader deliverables in `output/` only. Publisher journals, triage plans, and
  acceptance evidence stay in `internal/` and are never presented as the reader's output.
- Keep the Notebook as the working source. A shared Book is a separately confirmed reader copy,
  not an independent authoring source.
- For an external workspace wiki, inventory it before proposing one Book or a project/reference
  split. The reader chooses the page boundary; a confirmed import creates a verified Shelf copy
  without changing the source workspace. See [Workspace Wiki Migration](workspace-wiki-migration.md).
- Use the bounded publishing and Project helpers for shared-Library changes. Read-only browsing and
  Notebook work do not create shared records.
- Before a publish, triage, archive, reset, or explicit AI Library development task, read the
  [Librarian Operation Playbooks](librarian-operation-playbooks.md) rather than carrying those
  rare procedures in the routine reader context.
- Record a source and relevant limits when saving material from a shared Book into the Notebook.

## Answer retrieval and source capture

For an information-seeking request, the Librarian first checks the relevant local workspace:
the Notebook plus only the necessary pages from Books and Projects already open on the Desk. It
then checks the relevant `raw/<project>/<batch>/` source material even when the workspace has
already answered the question. This catches corrections and useful detail that have not yet been
compiled. A raw search is scoped to the likely project or source batch; it is never a blanket
scan of every source folder. The reply names the batch or specific paths searched; a broad read
earlier in the session does not replace this question-specific raw check.

When raw material adds an answer or useful correction, the Librarian writes a concise,
source-attributed synthesis to the fitting Notebook article, updates the topic index and Key
Takeaways, and states the source paths and any meaningful limits. It does not copy raw text
wholesale, and it never makes a shared-Library write. When the relevant raw material has no
answer, the reply says that it was checked and names the scope.

Only when the workspace and relevant raw sources both fail does the Librarian consult the shared
Book Catalog and local Shelf catalog for basic discovery metadata. It may recommend a promising
Book for the reader to open, but it does not open a Book automatically. If neither catalog offers
a useful lead, it recommends an internet search. General model knowledge is a clearly labelled,
unverified last resort after each of those source layers has failed.

## Token-efficient instruction loading

On 2026-08-14, the always-on `CLAUDE.md` guide was reduced from 2,466 to 677 words (a 73% reduction
by word count). It retains the rules needed in ordinary work: safe Notebook use, Desk orientation,
guarded Book and Project reading, Project suggestions, starting a Project, and the instruction to
load the applicable playbook before a consequential action.

The moved material lives in [Librarian Operation Playbooks](librarian-operation-playbooks.md):
Library development, inventory and triage, publishing and refresh, Book and Project archiving, and
the bounded Notebook reset. This is an instruction-loading change, not a change in reader-facing
behavior or safety boundaries. Do not re-copy detailed playbook steps into the always-on guide;
add a concise trigger and link there instead.

## Key Takeaways

- The Notebook is the volatile working source; the shared Library is a guarded reader surface.
- Answers are grounded in the workspace, then relevant raw evidence; useful raw findings become
  concise, attributed Notebook knowledge.
- Project Hubs orient current work without becoming a task system or dependency search tool.
- Routine context stays compact; rare consequential workflows load their bounded playbook on demand.
- The full operating rules remain in [CLAUDE.md](../CLAUDE.md).

