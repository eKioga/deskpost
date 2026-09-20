# Deskpost

**Status: Windows preview (`v0.1.0`).** Usable, and narrow on purpose — see
[Prerequisites](#prerequisites) before you clone.

Deskpost is a reading room for working with an AI assistant. You keep source material on one shelf
and your own distilled understanding on another, and nothing crosses between them by accident. The
assistant — the Librarian — reads only what you have deliberately **opened** on the Desk, so "what
does the model know right now" has an answer you can point at. A closed Book is unavailable, and
saying so is the product rather than a limitation of it. The result is a workspace where context is
something you arrange, not something that accumulates.

A Deskpost workspace is called a **Library**. Inside it: **Books** and **Project Hubs** hold durable
material, a **Shelf** stages what is not ready to be shared, a **Notebook** holds your own working
knowledge, and a **Seat** is the station you work from — one Desk, one set of open Books.
[`CONTEXT.md`](CONTEXT.md) is the glossary and the only authority on what those words mean.

## New here?

**[`docs/guides/`](docs/guides/README.md)** is written for the person *using* Deskpost — a quick
start, a learning path, how to begin a project, and the workflow as diagrams. Start there. The rest
of `docs/` is design records, written for whoever is changing the code.

## Prerequisites

- **Windows 10 or 11.** This preview is Windows-only. Cross-platform arrives with the TypeScript
  kernel; see [Roadmap](#roadmap).
- **Windows PowerShell 5.1**, which ships with Windows. Nothing to install.
- **Claude Code or Codex.** Both are supported and both route through the same validated reader.
- **A Basic Memory endpoint. Required in v0.** Deskpost keeps its shared collection there. A
  workspace with no endpoint configured can open a Desk but reaches no shared Book or Project Hub.
  A local collection that needs no server is Tier 0, and it arrives with the TypeScript kernel, not
  before.

## Install

```powershell
git clone https://github.com/eKioga/deskpost.git
cd deskpost
git config core.hooksPath .githooks
tools/Initialize-CodexLibrary.ps1 -McpUrl <your-basic-memory-url> -CollectionId <your-collection-id>
```

Then open the folder as your harness project and trust its configuration.

`git config core.hooksPath .githooks` installs the pre-commit and commit-msg hooks. The initializer
also sets it when run inside a checkout, so the explicit line is belt and braces for anyone who runs
the hooks before the initializer.

**The code carries no deployment.** There is no endpoint, no collection id and no share path
anywhere in the tree — a clone knows nothing about anyone's network, and a static check
(`public.no-deployment-defaults`) fails the build if one ever reappears. The initializer writes
gitignored files under `.claude/` and renders the gitignored `.codex/config.toml` and
`.codex/hooks.json` from tracked, path-free templates. Every helper resolves those values through
one chain — an explicit argument, then `AI_LIBRARY_MCP_URL` / `AI_LIBRARY_PROJECT_ID` /
`LIBRARY_SHARED_COLLECTION_ROOT`, then the generated state — and refuses naming all three routes if
you configure none of them, rather than trying an address that is not yours.

Re-run the initializer after moving the folder. A Codex plugin is not required; any future plugin is
an optional adapter over the same core.

## Using it

Describe the work you want to do in a sentence or two, and the Librarian will ask what it needs.
Before anything consequential — publishing, triage, archive, or a reset — it reads
[`docs/librarian-operation-playbooks.md`](docs/librarian-operation-playbooks.md) and shows you a
preflight with a `plan_id` you approve. Nothing consequential happens without that.

Run the checks yourself any time:

```powershell
tools/Invoke-LibraryChecks.ps1 -Fast
```

That is the same gate the pre-commit hook fires, and it takes about twenty seconds. The bare full
run spawns every helper's self-test and takes twenty minutes or more — a phase gate, not something
to sit and wait for.

## How this is built

Two models and one human, and the division is deliberate. **Claude plans and reviews; Codex builds
or reviews; every diff is approved by a person; every commit runs the gate.** Plans are hardened
adversarially before any code is written — one model drafts, the other attacks it, and a human signs
off on the result.

`AGENTS.md` and `CLAUDE.md` are the working instructions the models actually receive. They are
tracked, so what the assistants are told is part of the repository and reviewable like anything
else. `docs/adr/` records the decisions and why they were made, including the ones that were
reversed.

The design records that drove this release — the plan files and their adversarial review logs — are
private and are not in this repository. [`docs/history.md`](docs/history.md) says where they live and
what is in them.

## Roadmap

- **v0.1 — this preview.** Windows, PowerShell, Basic Memory required, Claude Code and Codex.
- **Next.** The program separates from the workspace and ships as plugins, so one install serves
  many Libraries ([ADR-0027](docs/adr/0027-the-program-is-separate-from-the-workspace.md)).
- **v1.** A TypeScript kernel shipped as a single binary, one-line install, macOS and Linux, and a
  **local collection** so Deskpost runs with no server at all
  ([ADR-0028](docs/adr/0028-the-kernel-is-typescript-shipped-as-one-binary.md),
  [ADR-0030](docs/adr/0030-a-collection-has-one-layout-and-two-backends.md)). A Seat carries its own
  Notebook ([ADR-0029](docs/adr/0029-the-notebook-belongs-to-the-seat.md)).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Pull requests are opened and reviewed on GitHub; they are
merged at the private origin and the mirror carries the result back, so nothing is ever merged on
GitHub itself.

## Licence

MIT — see [`LICENSE`](LICENSE). Copyright 2026 Eric Post.
