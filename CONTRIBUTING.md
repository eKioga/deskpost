# Contributing to Deskpost

Thank you for looking. This is a small project with an unusual build process, and a few of its
conventions will surprise you if nobody says them out loud — so they are all here.

## The shape of the repository

**This GitHub repository is a mirror.** The origin is a private Forgejo instance, and a scanning
publishing job pushes here after checking every object it is about to publish. That is not
bureaucracy: this codebase is developed inside a working Library that holds its maintainer's own
reading material, and the scan is what guarantees none of it reaches a public object.

The practical consequence, and the one that catches people:

> **Pull requests are opened and reviewed on GitHub, and merged at the origin.** The maintainer
> fetches your branch, merges it at Forgejo, and the mirror carries the result back here. Your PR
> will close when the merge commit arrives, rather than being merged by the button.

GitHub branch protection blocks every push except the mirror's, so nothing merged on GitHub could
survive anyway. Nothing is lost by this — your commits arrive with your authorship intact — but the
PR page will look like it was closed rather than merged, and that is expected.

## Before you open a pull request

Run the gate:

```powershell
tools/Invoke-LibraryChecks.ps1 -Fast
```

About twenty seconds, and exactly what the pre-commit hook fires. It must be green. If you have
touched a tool, a hook, or the reader, that is the minimum; if you have touched the folder mover,
the seat model or either exporter, run those suites directly too — they are skipped in `-Fast`
because they spawn sandboxes:

```powershell
tools/Invoke-LibraryChecks.ps1                      # the full gate, 20+ minutes
```

Install the hooks if you have not already:

```powershell
git config core.hooksPath .githooks
```

There are two. `pre-commit` runs the fast gate. `commit-msg` scans the message itself, because a
message is not a blob and no file scan can reach it.

### If a check fails and you think the check is wrong

Say so in the pull request rather than working around it. Several checks in this tree exist because
the obvious implementation was measured and found to pass on broken code; a few carry deliberate
decoys that a naive rewrite will trip over. The reasoning is in the check's own comments, which are
written to be read.

## Authorship and trailers

**The human is the author, and the only signer.** Whoever opens the pull request is the author of
those commits. That is the whole rule; everything below is detail.

- **`Co-Authored-By: Claude ...`** stays on commits Claude Code wrote. It is accurate, and removing
  it would misrepresent who wrote the code.
- **`Assisted-by: Codex`** goes on a change Codex built.
- **No agent adds a sign-off.** `Signed-off-by` is a statement a person makes about provenance, and
  a model is not in a position to make it. If a trailer appears in an agent-generated commit
  message, remove it.

Write the message for a reader who will find it in `git log` in two years: what changed and why,
not what files were touched.

**Do not put a filesystem path in a commit message.** The `commit-msg` hook will refuse it. This is
the same identity scan that guards the blobs, and it exists because a path names a machine and a
person as surely as an address does.

## A note on identity scanning

A maintainer machine keeps a denylist of its own hostnames, addresses, share paths and usernames at
`%USERPROFILE%\.library\identity-denylist.txt`, with an approved-attribution allowlist beside it.
**Neither file is in any repository** — a file listing those terms would itself be the leak it
prevents.

You will not have one, and you do not need one. Set:

```powershell
$env:LIBRARY_IDENTITY_SCAN = 'contributor'
```

and the scan downgrades a missing denylist from a failure to a warning and reaches for
[`gitleaks`](https://github.com/gitleaks/gitleaks) instead, if you have it installed. A `gitleaks`
*finding* still fails in either mode: that is evidence, not a missing list. The server-side scan at
the origin is what actually guarantees the boundary, and it depends on no contributor's machine.

## Style

Match the code around what you are changing — its naming, its idiom, and in this tree especially its
comment density. Comments here explain **why**, usually with the measurement or the incident that
made the decision necessary. A change that removes a hazard should say what the hazard was.

`.claude/rules/library-development.md` documents the defect families this codebase keeps producing,
several with a lint attached. It is worth reading once before a first change; it will save you a
review round.

## Reporting a problem

Open an issue on GitHub. If it is a security issue — anything where a private path, address or
identity could reach a public object — please describe the class of problem rather than posting a
working reproduction, and the maintainer will follow up.

## Licence

By contributing you agree that your contributions are licensed under the MIT Licence, the same terms
as the rest of the project. See [`LICENSE`](LICENSE).
