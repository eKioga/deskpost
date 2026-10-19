# Shipped workspace skills

Parity plan step 4d. Reader benefit: the same Library procedures are available in Claude Code and Codex without a plugin or a manual copy. Safety boundary: init owns only proven files in this Library, never a reader's skill or a link's destination.

## Inventory and ownership

- `SHIPPED_SKILLS` in `kernel/src/skillcopy.ts` names released skills; `SKILLS_BY_LOCATION` declares the per-harness inventory. `library-help` goes to both `.claude/skills` and `.agents/skills`; `save` and `closeout` go only to `.agents/skills`. Prototypes are excluded.
- Canonical `library-help` content is `.claude/skills/library-help/` in the program; canonical Codex `save` and `closeout` content is `.agents/skills/<name>/`. There is one authored copy of each. A declared skill without `SKILL.md` refuses the whole init before writes. Claude Code keeps its deskpost-mods plugin's save and closeout commands; init adds no duplicate there.
- Each destination has an independent `.deskpost-managed.json`, schema 1: relative file names and SHA-256 hashes Deskpost wrote. Missing files are created; files still matching an owned hash are upgraded; edited or unowned files are preserved and named. A nonempty skill directory with no valid manifest is a reader collision: leave it whole and warn while completing the remaining setup.
- Ownership manifests are written before skill content so interrupted first installs resume. Init is idempotent and repairs missing files in either location independently.
- Every destination directory and file, including the manifest, is checked before reading or planning writes. Junctions, symlinks, dangling links and wrong-shaped file or directory slots refuse the whole init without writes. This includes links at the harness root and nested reference folders. Init never removes a link itself. A Library reached through a parent junction is allowed.
- Renamed or retired managed skills and files are retained with their ownership records. Init and doctor name obsolete managed content; neither deletes it or silently erases edits. Renaming ships a new name and retains the old copy, which may remain discoverable until the reader removes it explicitly.
- Uninstall removes its existing hook and server registrations, retaining managed skill copies, their manifests and reader edits, following [ADR-0058](adr/0058-uninstall-reaches-only-what-deskpost-wrote-and-sessions-close-first.md). Both harnesses have the same retention rule.

## Structural checks and live discovery

Doctor's `workspace.claude-skills-installed` and `workspace.codex-skills-installed` rows report missing, outdated, edited, unowned, linked, blocked and retired copies. Doctor never writes. Structural success proves installation; it does not prove that a live harness discovered a skill.

The Claude row names `library-help`; the Codex row names `library-help, save, closeout`.
Section 249 proves the Codex-only installation, user collision preservation, repeat init and both doctor rows.

Self-test section 219 covers both locations, canonical content, collisions, invalid ownership records, old-hash upgrades, reader edits, missing-file repair, interrupted installation, missing shipped sources, retirement, blocked file slots, linked roots/directories/file slots, actual init and uninstall retention. Section 107 compares interrupted init with a clean init in both skill locations. Existing section 55 retains its front-door ownership checks.

The acceptance matrix has separate real-harness rows for Codex and Claude discovery. In a disposable fresh Library outside the checkout, run source `init` and `doctor`, then ask each harness to list available skill names without invoking a tool. Record the exact harness version and output line. The Claude probe enables only its Skill tool: removing that tool also removes skill advertisement and is not a valid discovery test.

For example, from that disposable Library:

```powershell
codex exec --skip-git-repo-check -s read-only "Do not run any command or tool. List, by name only, every skill available to you."
claude -p --tools Skill "Do not invoke any tool. List, by name only, every skill available to you."
```

Use the fixture recipe below. K1b's signed-in discovery row is unverified; its fallback is the
release rehearsal. Record unavailable harness checks as stalls with their exact output, never as
a passing discovery result or a unit failure. Source-fixture observations are separate from
certification of an exact release binary; release-matrix verdicts remain pending until that binary
is observed. Include discovery checks in the upgrade rehearsal alongside seat holding, reader
response, closed-Book denials and a sandbox shell command.

## Fixtures

Ordinary tests keep fake homes: isolated `HOME`, `USERPROFILE`, `APPDATA` and `LOCALAPPDATA`.
Only a named live proof that needs a signed-in harness runs it against the reader's real home and
login, which are never copied, with a fixture workspace and registry and the fewest tools the proof
needs. Do not change the real home's configuration unless the Kickoff names it, Eric separately
approves it, and the proof restores it and shows restoration by path and matching hash or sanitized
comparison, never contents. The program that makes a fixture removes it in `finally`, under its
session's temp folder. After an abnormal end, the handback names residue paths and their contents'
kind; the reader or a later run of that same program removes them, never a shell delete. A refused
cleanup is a stall, not permission to retry another way.

## Evidence location

The c3 attempt and handback at `projects/deskpost-codex-dev/notes/2026-10-12-c3-a1` record the commit gates and source-fixture proofs. Earlier source observations on 2026-10-11 listed `library-help` in Codex 0.162.1 and Claude Code 2.1.296; they do not certify this unit's tip or an exact release binary.
