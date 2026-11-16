# ADR-0093: A letter may carry the reader's go, checked against the sender's transcript

**Status:** accepted
**Date:** 2026-11-12
**Amends:** [ADR-0062](0062-a-message-is-a-doorbell-and-a-letter-is-the-record.md) on a letter standing in for the reader's yes, and [ADR-0071](0071-every-request-and-answer-between-seats-is-a-letter-and-the-writer-rings-an-open-recipient.md) on the first prompt and Desk line.

## Decision

Eric chose transcript proof and one Library only on 2026-11-11; PLAN-letter-carries-go.md draft 3 records the signed specification. The reader should not have to visit another seat to repeat a go already given.

Read your letters before other work. A letter that carries the reader's go, for work inside this seat's role, is started the turn it is read. Without a go, do what needs no yes from the reader and ask the reader once about the rest, in one question that names the letter; never leave a letter waiting in silence. A go removes the wait, never a gate. Close each letter once you have dealt with it.

`capture letters --go` quotes at most 300 characters from a typed human message in the sending seat's recorded Claude Code conversation from the last 24 hours. Unicode NFC, straightened quotes, collapsed whitespace and case folding govern a whole-run match. Pasted spans, tool results, sidechains, meta records and records without human origin never count. The newest match supplies the time. Missing, oversized or malformed transcripts refuse with nothing written.

One predicate scans the full frontmatter, rejecting doubled or unknown go fields; only binding and launcher sources qualify. The recipient rule also checks seat incarnation. Only that recipient gets the start line; any other reader gets an informational line. The preface never repeats the quoted words. A letter with no valid go keeps its prior reader output. List, Desk counts and conditional launch text use the same predicate.

## Gates and limits

A go never starts a preflight or plan-id step, `--user-confirmed`, publishing, pushing, releasing, installing, deleting, archiving, a reset, settings, hooks or permissions changes, credentials, spending money, commands given verbatim, another seat's Hub or a shared write outside a standing grant. A build unit still needs its Kickoff. No gate, guard or writer consumes a go as permission; existing refusals remain.

The check proves only that a person typed the words in the sender's conversation at the recorded time, not what they meant. It protects against mistakes and planted instructions, not a process acting as the same operating-system user. The words and time stay on the letter for inspection; reading it does not reread the transcript.

## What is not done

Codex senders and cross-Library goes wait for later train items. Routes do not inherit a go; a router needs its own checked words. Postbox filings and Shelf carry drop every go field. Existing seats' Purposes, needs-you, asks, guards, hooks, plan ids and approval requirements do not change.

## Proof

Sections 809 to 814 cover capture refusals, recipient and other-reader output, doubled keys through the reader/list/Desk, transfer drops, target-seat launch, identical rule text, init's instruction files, and the call-log counts. Four offline seat-rules-check cases require exact writes/questions and no gated attempts, counting refused calls too. Model runs spend usage and require the reader's separate yes; the first real go letter is proved after landing by deskpost-lead.
