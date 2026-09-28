# Deskpost

**Status: 1.2, for Windows and Linux.** See [Prerequisites](#prerequisites) before you install.

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
  not supported in 1.1.
- **Claude Code or Codex**, installed and signed in. Both are supported, and both read through the
  same validated reader.

That is all. Your Library keeps its Books and Project Hubs in a folder inside the workspace, on
your own disk, with no server and no account beyond your assistant's.

## Install

### Install with your assistant

Ask Claude Code or Codex, in a folder that is not a Library:

```text
Install Deskpost for me, following https://github.com/eKioga/deskpost/releases/latest/download/llms-install.md
```

It asks where your Library should live, shows you the plan as a short table, and installs only when you say
yes. It then tells you the one thing to type in a new terminal, `deskpost`, and which prompts to expect when the
Librarian starts. [`llms-install.md`](llms-install.md) is the page it follows, written for the assistant.

### Install from a terminal

In PowerShell, from the folder you want your Library in:

```powershell
& ([scriptblock]::Create((irm https://github.com/eKioga/deskpost/releases/latest/download/install.ps1)))
```

It asks one question, **where your Library should live**, with the answer already filled in: the
folder you ran it from, or a `Library` folder inside it when that folder already holds other files.
Type another folder, or `none` to install only the program. Then it shows one screen with everything
it will do, and does it when you press Enter:

```
Deskpost 1.1.0  (checksum matches the release's SHA256SUMS)
  Library     D:\dev\Deskpost            your Books, Notebook and seats (new folder)
  Program     %LOCALAPPDATA%\deskpost    a new folder; updates and undo touch only this
  Command     deskpost                   ready in this window; other open terminals after a restart
  Librarian   Claude Code
  Undo        deskpost uninstall         shows what it removes first
```

`[p]` picks another program folder (it must be new or empty), and `[a]` switches between Claude Code
and Codex when both are installed. The Library and the program folder are kept apart, so deleting
one never deletes the other. The installer runs `deskpost doctor`, and that result is the install's
result. Other terminals that are already open keep their old PATH: restart them.

It ends with a choice: **Show me around**, which starts the Librarian in a `deskpost-help` seat as
your guide, or **the main menu**. Type `deskpost` any time to come back to it.

On Linux:

```sh
curl -fsSL https://github.com/eKioga/deskpost/releases/latest/download/install.sh | sh
```

It installs into `~/.local/share/deskpost` and links `deskpost` (and `library`, the same command)
into `~/.local/bin`. Make your Library with `deskpost init ~/Library`, then run `deskpost` inside it.

### Install options

Options go after the scriptblock: `& ([scriptblock]::Create((irm …/install.ps1))) -Library D:\Notes`.

| Option | What it does |
| --- | --- |
| `-InstallRoot <folder>` (`DESKPOST_INSTALL_ROOT`) | Where the program goes; `%LOCALAPPDATA%\deskpost` by default. It must be new, empty, or an existing Deskpost install. |
| `-Library <folder>` or `-Library none` (`DESKPOST_LIBRARY`) | Answers the question; `none` installs the program only, and `deskpost setup <folder>` makes a Library later. |
| `-Yes` (`DESKPOST_YES=1`) | No prompts: the defaults, and the plan screen is still printed. It never launches an assistant; it ends with `Next: deskpost`. |
| `-DryRun` | Shows the plan and changes nothing. |
| `-AllowOverlap` | Lets the Library and the program folder contain each other, which is otherwise refused without a prompt. |
| `-Repair` | Reinstalls the same version over itself, and brings an existing Library's managed files up to date. |
| `-Resume finish` / `-Resume undo` | Finishes or undoes an install, upgrade or uninstall that was interrupted. Running the one-liner again offers the same choice. |
| `-NoPathChange` | Leaves PATH alone; run `<program>\bin\deskpost.cmd` instead. |
| `-Plugin` | Also installs the Claude Code plugin. Opt-in, because each Library registers its own guards. |
| `-Rollback` | Switches back to the version installed before this one, as `deskpost rollback` does. |
| `-Json` | Prints one JSON result on stdout; everything else goes to stderr. |

**Upgrading** is the same one line: it upgrades in place, and refuses while a session is open at a
seat of a Library it serves, naming it (close it and press Enter to look again). `deskpost rollback`
switches back. **`deskpost uninstall`** shows what it will remove, removes only what Deskpost put there
-- its entries in your Libraries, its PATH entry and its program files -- and never your Libraries.

The checkout of this repository is the program, not a Library: cloning it gives you the source, and
`deskpost setup <folder>` (or `deskpost init`) is what makes a Library.

## Basic Memory (optional)

Your Library always keeps its own Books and Project Hubs, in its own `collection/` folder. A
[Basic Memory](https://github.com/basicmachines-co/basic-memory) server is an optional **connection**: a
second place the Library can read from, to open a Book shared from another machine or to import an older
Basic Memory workspace. Nothing is ever written to Basic Memory. Connect with
`deskpost basic-memory setup --url <mcp-url> --collection <name>`, or press `b` in the main menu; the
[Basic Memory guide](docs/guides/basic-memory.md) has the rest.

## Using it

Describe the work you want to do in a sentence or two, and the Librarian will ask what it needs.
Before anything consequential — publishing, triage, archive, or a reset — it reads
[`docs/librarian-operation-playbooks.md`](docs/librarian-operation-playbooks.md) and shows you a
preflight with a `plan_id` you approve. Nothing consequential happens without that.

Run the checks yourself any time with `deskpost doctor` in your Library. In a clone of this
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

- **1.0.** One binary for Windows and Linux
  ([ADR-0028](docs/adr/0028-the-kernel-is-typescript-shipped-as-one-binary.md)), installed apart from
  the Libraries it serves ([ADR-0027](docs/adr/0027-the-program-is-separate-from-the-workspace.md)).
  Claude Code and Codex are both supported. A local collection is the default, with Basic Memory as
  the optional shared route. Each Seat carries its own Notebook
  ([ADR-0029](docs/adr/0029-the-notebook-belongs-to-the-seat.md)).
- **1.1.** An install that asks one question and shows its plan, `deskpost uninstall` and `deskpost rollback`,
  and bare `deskpost` as the main menu: your seats, a number to resume one
  ([ADR-0059](docs/adr/0059-bare-deskpost-is-the-main-menu-and-seat-start-is-its-one-launcher.md)).
- **1.2: this release.** Install by asking your assistant: [`llms-install.md`](llms-install.md), a plan the
  assistant shows and an install bound to it, Show me around on `h` in every Library, and the `library-help`
  Skill in every Library.
- **After 1.1.** The guided tutorial, an Orca Quick Command per seat, and macOS
  ([ADR-0048](docs/adr/0048-a-note-is-named-by-the-local-date-and-saving-is-not-reading.md)).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Pull requests are opened and reviewed on GitHub; they are
merged at the private origin and the mirror carries the result back, so nothing is ever merged on
GitHub itself.

## Licence

MIT — see [`LICENSE`](LICENSE). Copyright 2026 Eric Post.
