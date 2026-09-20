# The program is separate from the workspace

Deskpost is an installed program. A workspace is a folder the program initialises and never a
checkout of the program. Reader material — `raw/`, `notebook/`, `shelf/`, `output/`, `internal/`,
seats — lives only in workspaces, so the public repository holds none of it by construction
rather than by ignore rule.

## Status

accepted — 2026-09-19, Eric's ruling Q1 in `PLAN-public-release.md`. Effective from that plan's
Phase C; until then this checkout is both program and workspace, as it has been since 2026-08-17.

## Why

Every leak vector the 2026-09-19 survey found comes from code and data sharing one folder with
`.gitignore` as the only fence: `output/` tracked although it is reader material by the
workspace's own definition, `.claude/.library-project` tracking a deployment's collection id,
thirteen planning logs at the root naming the reader's hosts, and `.dsh-prototype/` whose fixture
tree was swallowed by ignore rules written for the reader's data. One `git add -f` was the distance
between the Shelf and a public mirror. With the split, a fresh clone is a program, not a
half-workspace; the program resolves its workspace the way git resolves a repository; and retiring
`D:\Library` becomes a data move under a cutover protocol instead of surgery.

## Considered options

**A stricter `.gitignore` on the mono-folder.** Rejected. Every clone still carries development
material, and the fence remains one forced add away from failing.

**A monorepo with `app/` and `workspace/` side by side.** Rejected. The same leak surface with more
paths, and every reader's checkout would still contain a workspace shape.

**Keep "clone the folder and go."** Rejected; it is the cost of this decision. `library init
<folder>` replaces it, and the README's portability promise is rewritten to match.

## Consequences

- `library init` writes `.library/workspace.json` (workspace id, program version, collection id and
  backend, writable flag), registers the workspace in the reader's profile, creates the
  workspace's `CLAUDE.md` and `AGENTS.md` only when absent and otherwise owns one marked section,
  and merges harness settings without overwriting unrelated entries.
- A hook is inert only when neither the cwd nor the **accessed path** is inside a registered
  workspace; a registered workspace whose marker is missing fails closed. Explicit selection
  (`--workspace`, `LIBRARY_WORKSPACE`) beats derivation, and disagreeing selections refuse.
- The reader's own workspace may be a private git repository, which finally gives the Shelf the
  history the 2026-08-17 brief asked for and this repository deliberately excludes.
- `output/` leaves the program repository; `.claude/.library-project` becomes generated state.
