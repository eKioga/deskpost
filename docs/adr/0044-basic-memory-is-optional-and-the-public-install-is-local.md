# ADR-0044: Basic Memory is optional, and the public install defaults to a local collection

**Status:** accepted
**Date:** 2026-09-24
**Effective from:** the next public release of `PLAN-public-release.md` (S45, the reader's ruling). Until it ships,
the published README still names Basic Memory as required, and that is a defect of the published tree.
**Relates to:** [ADR-0030](0030-a-collection-has-one-layout-and-two-backends.md) (one layout, two backends;
Tier 0)

## Context

S7's fresh-clone run in Windows Sandbox (S45) followed the public README, which lists "A Basic Memory endpoint.
Required in v0." as a prerequisite, against a disposable project on the reader's own Basic Memory server. To
create the first Project the Sandbox was then asked to sign in to the reader's NAS share: the ownership fence
takes its lock beside the collection's Markdown and so needs a filesystem path to it, which the reader's network
has only because the NAS both runs the container and shares its storage folder. A stranger who installs
Deskpost has none of that. The test measured one person's home lab, not the product.

Basic Memory's role in Deskpost is a server -- a container on another machine, reached over MCP, holding the
shared collection so seats on several machines can use it. That is worth having, and the reader uses it. It is
not worth asking of someone who wants the Deskpost workflows on their own PC.

## Decision

**Basic Memory is optional.** The public install requires Windows and Claude Code or Codex, and nothing else. A
workspace with no endpoint uses the local collection ADR-0030 already defines (Tier 0), and that is the default
the README and the guides describe.

- **Basic Memory stays supported and is advertised,** as the route to a shared collection across machines --
  named in the README with what it adds and its real setup requirements, never as a prerequisite.
- **The reader's own workspaces keep their Basic Memory collection unchanged.** This ruling changes what the
  public install asks of a stranger, not how the reader works.
- **Friction on the default route is a release defect.** A step that makes a local-only user meet a server, a
  share or a credential is a bug, whatever the shared route needs.

## Consequences

- **The default route is the kernel's install, not the PowerShell preview.** Measured in S45: a fresh clone's
  PowerShell helpers have no Tier 0 route at all -- `library init` lays out the local collection and the marker
  says `backend: local`, but `Enter-LibrarySeat.ps1 -Create` and `New-ProjectHub.ps1` resolve a collection only
  through a Basic Memory endpoint and both refuse. The S45 release binary, in a scratch workspace with no
  endpoint, initialised, created a Project in `collection/`, created and entered a seat bound to it, and
  answered the Desk overview and the Project catalog. ADR-0028 already keeps PowerShell to the v0 preview, so
  Tier 0 is not ported back to it.
- The Tier 0 Project reader (S43's third Report Inbox claim: `read_open_project_page` always asks Basic Memory)
  is on the default route, so it blocks the release that implements this ruling rather than waiting on the
  reader's want. The same binary confirmed it: `read_open_project_page` refused "Virtual Desk configuration is
  missing .library-project", and `library desk open project` refused "Virtual Desk is not configured in this
  workspace" -- a second path with the same dependency.
- The README's Prerequisites and Install sections are rewritten for the local default, including the missing
  "create your workspace" step S7 found. The wording is the reader's.
- Two S7 findings stay defects of the shared route, no longer of the first run: `library init` records an
  endpoint without writing the state its helpers read, in both implementations; and the ownership fence needs a
  filesystem view of the collection, which a Basic Memory server reached only at its endpoint does not give.
  How one writer per collection is enforced over MCP alone is an open design question.
- S7's fresh-clone criterion is measured on the local default -- clone, initialise with no endpoint, sit at a
  seat, create and read a Project -- with nothing of the reader's involved.
