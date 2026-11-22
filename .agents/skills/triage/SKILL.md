---
name: triage
description: Use when asked to triage, sort or clear Reports.
---

# Triage Reports

A Report is a claim to verify against the code. Follow library-help's
`references/capture-and-triage.md` where it differs from this method.
Run commands from the Library folder and pass drafted text and actions from files.

1. Run `deskpost triage prepare --json`. Use its seat, pending Reports, program
   and record fields. Act on each `problems` line with the command it names,
   respecting that command's approval gate. If `triager.state` is not `this-seat`,
   tell the reader who triages or what prevents that reading, and stop.
   Resolve problems that prevent verification before deciding a verdict.
2. For each Report with `held` set, read its earlier triage record through the
   validated reader. Check only that record's closing condition. If still unmet,
   leave it open and cite the record; if met, record the result for closing.
3. Pin the code to `program.tag`, or the code's own commit when no tag is given,
   and to the code tip. Record both commits and `program.version` in the draft.
   Check claims about the installed program at both commits; an already fixed
   verdict says whether the installed build contains the fix.
4. Open each remaining pending Report through `read_open_book_page` for `reports`.
   Verify its exact claim against the pinned code, citing `file:line` and commit.
   A `suspected` Report, or a claim the code cannot settle, needs a command that
   fails on its exact symptom to confirm it, or a command expected to expose that
   symptom which passes to support not reproduced. Use a focused test or scratch
   fixture. Record the command and output. Give each Report one verdict:
   - **confirmed**: evidence and the smallest fix;
   - **confirmed by design**: the rule or decision that explains the behavior;
   - **not reproduced**: the command and result;
   - **already fixed**: the fixing commit and installed-build status;
   - **declined**: a received Report only, with the reason;
   - **left open**: why it is unsettled and its exact closing condition;
   - **noted**: about a seat's own working tools, when it stopped no run, gave no
     wrong answer and misled no seat; state its claim and close without a train item.
5. A confirmed defect a user would meet, or one that stopped a run, gets a train
   item unless `train_items` already names one that covers it. Use that item when
   present; otherwise add one with `deskpost train add` in `lane:fixes`, citing the
   triage record as its source. Name who met the defect. A working-tool observation
   that stopped nothing stays in the record without an item.
6. Record every verdict on `record.hub` as a dated `notes/` page, using
   `deskpost hub edit <hub> --mode new-page --page notes/<date>-<topic> --content-path <file>`.
   Use `{{now}}` for the time. Include each Report's title, filer, verdict,
   evidence, train item or other disposition, and each open closing condition.
   When `record.classes_page` is set, read it through the validated reader and
   include `Class:` and `Missed by:` for each confirmed defect by its rules.
   Read the new page back through the validated reader and check its hash against
   the writer's `written_sha256` before closing any Report.
7. Close recorded terminal verdicts in one `triage batch` of `review` actions.
   Write a JSON array to a file, with each action's `kind: review`,
   `source: holding`, `source_slug: reports` and `source_page: notes/<page>`.
   For a received Report also give `outcome` and `outcome_note`; the outcomes are
   `confirmed`, `confirmed-by-design`, `not-reproduced`, `already-fixed`, `declined`.
   Leave left-open Reports pending. Run
   `deskpost triage batch --actions-path <file> --preflight`, then the same command
   with `--plan-id <returned id>`. Review-only actions without `other_seat` need
   no reader approval; any other action kind or `other_seat` waits for the reader's
   yes on the preview. Check the receipt and pending inventory afterward.
8. Tell a seat that was promised an outcome, using
   `deskpost capture letters --why for-seat --for <seat> --content-path <file>`.
   Name the Report, verdict and record. End with what the reader must decide,
   or "nothing", followed by the closed and open Reports and record page.
