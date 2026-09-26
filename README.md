# Deskpost

**Status: 1.0 release candidate, for Windows and Linux.** See [Prerequisites](#prerequisites) before
you install.

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

**[`docs/guides/`](docs/guides/README.md)** is written for the person *using* Deskpost: a quick
start from a fresh install, a learning path, how to begin a project, and the workflow as diagrams.
Install first, then start with the [Quick Start](docs/guides/quick-start.md). The rest
of `docs/` is design records, written for whoever is changing the code.

## Prerequisites

- **Windows 10 or 11**, or **Linux on x64** with `curl` and either `unzip` or `python3`. macOS is
  not supported in 1.0.
- **Claude Code or Codex**, installed and signed in. Both are supported, and both read through the
  same validated reader.

That is all. Your Library keeps its Books and Project Hubs in a folder inside the workspace, on
your own disk, with no server and no account beyond your assistant's.

## Install

In PowerShell:

```powershell
& ([scriptblock]::Create((irm https://github.com/eKioga/deskpost/releases/latest/download/install.ps1)))
```

On Linux:

```sh
curl -fsSL https://github.com/eKioga/deskpost/releases/latest/download/install.sh | sh
```

Each installer checks the download against its published checksum and installs into a versioned
folder. On Windows that is `%LOCALAPPDATA%\deskpost`, and its `bin` folder is added to your PATH. On
Linux it is `~/.local/share/deskpost`, with `library` linked into `~/.local/bin`. Each installer
finishes by running `library doctor`, and that result is the install's result. Open a new terminal
afterwards so the PATH change takes effect. The Claude Code plugin is opt-in (`-Plugin` on Windows,
`DESKPOST_PLUGIN=1` on Linux), because `library init` registers each workspace's own guards.

Then create your Library (a workspace folder, wherever you like) and your first Project and Seat.
On Linux, write the folder as `~/Library`:

```powershell
library init $HOME\Library
cd $HOME\Library
library hub new my-project --title "My project"
library seat start me --project my-project
```

`library init` lays out the workspace: the Notebook, the Shelf with its Holding Shelf and Report
Inbox, and the local collection your Projects live in. `seat start` creates the seat `me`, opens
`my-project` on its Desk, and starts Claude Code there (`--command codex` for Codex). Next time,
`library seat start me` is enough.

The checkout of this repository is the program, not a Library: cloning it gives you the source, and
`library init` is what makes a workspace.

## Sharing a collection across machines (optional)

A Library can keep its collection on a [Basic Memory](https://github.com/basicmachines-co/basic-memory)
server instead of on local disk, so seats on several machines work from one set of Books and
Projects. You need:

- a Basic Memory server reachable from every machine over MCP (an `http` or `https` URL), and a
  project on it for the collection;
- **a filesystem path to that project's storage folder** — a network share, for instance — from
  each machine that writes to it. Creating a Project or publishing a Book takes a lock beside the
  collection's files, which is what keeps two machines from writing the same page at once; a
  server reached only by its URL is readable but not writable;
- the PowerShell setup, for now, which makes this route Windows-only:
  `tools/Initialize-CodexLibrary.ps1 -McpUrl <url> -CollectionId <id>` run from a clone of this
  repository. `library init --mcp-url` records the endpoint but does not
  yet configure the helpers that read it.

## Using it

Describe the work you want to do in a sentence or two, and the Librarian will ask what it needs.
Before anything consequential — publishing, triage, archive, or a reset — it reads
[`docs/librarian-operation-playbooks.md`](docs/librarian-operation-playbooks.md) and shows you a
preflight with a `plan_id` you approve. Nothing consequential happens without that.

Run the checks yourself any time with `library doctor` in your Library. In a clone of this
repository, the gate the pre-commit hook fires is:

```powershell
tools/Invoke-LibraryChecks.ps1 -Fast
```

It takes about twenty seconds. The bare full
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

- **1.0: this release.** One binary for Windows and Linux
  ([ADR-0028](docs/adr/0028-the-kernel-is-typescript-shipped-as-one-binary.md)), installed apart from
  the Libraries it serves ([ADR-0027](docs/adr/0027-the-program-is-separate-from-the-workspace.md)).
  Claude Code and Codex are both supported. A local collection is the default, with Basic Memory as
  the optional shared route. Each Seat carries its own Notebook
  ([ADR-0029](docs/adr/0029-the-notebook-belongs-to-the-seat.md)).
- **After 1.0.** A seat picker and an Orca Quick Command per seat, setting up a shared collection
  from `library init` itself, and macOS
  ([ADR-0048](docs/adr/0048-a-note-is-named-by-the-local-date-and-saving-is-not-reading.md)).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Pull requests are opened and reviewed on GitHub; they are
merged at the private origin and the mirror carries the result back, so nothing is ever merged on
GitHub itself.

## Licence

MIT — see [`LICENSE`](LICENSE). Copyright 2026 Eric Post.
