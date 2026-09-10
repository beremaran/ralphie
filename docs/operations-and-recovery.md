# Operations and recovery

This page is for operators inspecting a run, integrating Ralphie's output,
or recovering after interruption or failure. It is the authoritative reference
for progress output, artifacts, state, cancellation, resume, and cleanup. Start
at the [documentation index](README.md) for other audience paths.

## Progress output

Ralphie receives the complete pi event stream while each task runs,
including thinking deltas, assistant text, tool calls, and tool results. Tasks
and issues are intentionally processed sequentially so this event stream remains
ordered. JSON output exposes it losslessly for integrations.

Human-readable transcript output groups each pi session into a compact block:
assistant text streams immediately within a 140-character bound; thinking deltas
and intermediate tool output stay in the compact activity surface; tool calls are
shown as readable commands; and each tool completion or failure gets one concise
summary line. Truncated assistant streams report their total with a `truncated`
marker.

Ralphie adapts its progress renderer to its environment. `--output default`
resolves to `interactive` only when stdin and stderr are both TTYs and `CI`
is neither `"true"` nor `"1"` (rechecked against `stderr.isTTY`); otherwise
it uses append-only `plain` output. The locked interactive layout strategy is
`durable-transcript-breadcrumbs` (`INTERACTIVE_FOOTER_LAYOUT_STRATEGY`, with
`INTERACTIVE_FOOTER_USES_SCROLL_REGION=false` and
`INTERACTIVE_FOOTER_USES_RESERVED_ROW=false`): the status is an in-place
replaceable region below streamed content, never a reserved bottom row or
DECSTBM scroll region. Reserved-row/scroll-region cursor manipulation is
disabled — the controller never emits DECSTBM (`...r`), absolute cursor
addressing (CUP `H`/`f`), alternate-screen, or save/restore sequences; only
in-place line erase (`\r\x1b[2K`) and single-row step-up (`\x1b[1A`) plus SGR
color repaint the region, with strict clear-before-draw on every replacement.
No reserved-row or scroll-region strategy is tested or published.

- interactive terminals receive the streamed pi transcript plus one replaceable
  interactive region: the sticky stage/status line and the bounded activity
  rows run together in a single region of at most three physical terminal rows
  (the cap is measured in rows actually painted, never newline counts), each
  row is clipped before it can wrap at the width sampled for its own repaint,
  and replacements repaint the region in
  place — intermediate activity, long commands, and deep paths never spill
  into scrollback or onto extra rows. Transcript token deltas stream
  immediately without waiting for the footer scheduler, which coalesces
  footer-only repaints at roughly 100–125 ms (clamped, default 100 ms).
  Repaints defer while a transcript fragment is open mid-line or a control
  sequence is incomplete, durable progress lines wait for a safe line boundary,
  and resize clears and repaints at the new width only at a safe boundary. On
  completion, interruption (SIGINT/Ctrl-C), failure, or disposal the live
  region is erased in place, the cursor settles on a fresh line below durable
  content, the resize subscription and refresh timer are released, and no
  further bytes are emitted; no live-only row (`◐`, `›`, started progress,
  activity) survives on screen or scrollback;
- each tool completion and each failure surfaces one concise summary line
  (`✓ <tool> done`, or a single sanitized, character-bounded failure line with
  enough error detail to act on) instead of streamed multi-line output;
- CI and redirected output are the deterministic noninteractive fallback:
  durable, append-only lines, byte-identical across identical runs, with
  neither ANSI cursor controls (`ESC`) nor
  carriage-return bytes and no footer/status residue (no `◐`, no
  `\r\x1b[2K`); `stripTerminalControls` is an identity no-op on these streams;
- `--output verbose` keeps the same mode selection and adds operational details
  (the structured details payload on durable rows) without expanding the
  interactive region beyond its three-row cap;
- `--output json` writes progress and `agent_event` objects one per line to
  stdout with stderr empty: every non-empty line parses as one complete JSON
  record, human headers/footers/glyphs/breadcrumbs never appear, and values
  are preserved as supplied; and
- `--output quiet` suppresses routine progress and transcript rows but retains failures
  and needs-attention decisions.

JSON events use a stable operational vocabulary and include `runId`,
`timestamp`, `stage`, `status`, and `message`. Grounding events identify
whether agent work was skipped. Human-readable needs-attention decisions name
the issue number and title and show the current/total queue position. A
`needs-attention` event includes its reason, summary, evidence, questions,
diagnostic or artifact path, and issue budget; verbose and
JSON output retain those complete details.
Depending on the event, it may also include the repository, review attempt,
session ID, commit SHA, created issue numbers, or diagnostic paths. Supplied
progress-event values are preserved as-is; pi transcripts and breadcrumbs
are never redacted, and terminal control sequences are stripped at the
reporting boundary.

## State and artifacts

The workspace's `.ralphie` directory contains only repository checkouts and
Ralphie's run state, events, and recovery artifacts. Pi credentials and
default-model settings live in `~/.pi/agent` (or `PI_CODING_AGENT_DIR`) and
are never written under this path.

Run artifacts live under:

```text
<workspace>/.ralphie/runs/<run-id>/
├── state.json
├── events.jsonl
└── issues/
```

New runs write the durable event log to
`<workspace>/.ralphie/runs/<run-id>/events.jsonl`; a resumed run reuses the
directory containing its supplied state file.

A normal issue execution obtains a durable per-issue artifact store at:

```text
<workspace>/.ralphie/runs/<run-id>/issues/<issue-number>/artifacts.json
```

The store prevents accidental overwrites and records readiness deferrals,
complexity decisions, checkpoints, review attempts, commit messages, created
commits, resolution proof, decomposition decisions, and created child-number
mappings. Stale or legacy un-fingerprinted decisions are removed on load
without disturbing the other artifacts for the issue.

A successful or interrupted run uses this more detailed layout (pi
configuration is not stored in this tree):

```text
<workspace>/.ralphie/runs/<run-id>/
├── state.json
├── events.jsonl
└── issues/
    └── <issue-number>/
        ├── artifacts.json
        └── review-exhaustion/
            ├── changes.patch
            └── metadata.json
```

`state.json` is versioned, schema-validated, and atomically replaced. It
contains the repository/branch,
notification settings and any pending notification intent, pi model selection,
budget, pending and completed queue numbers, processed count, outcomes, active
issue/stage, checkout invariant, and update time. State is saved before the
queue starts, when an issue becomes active, before and after review/revision/
publication boundaries, after outcomes and queue refreshes, and at final
completion. Version 11 accepts and migrates previous versions while preserving
resumable evidence.

## Failure, cancellation, and exit status

```mermaid
stateDiagram-v2
    [*] --> Active: start or resume
    Active --> Active: persist issue/queue progress
    Active --> Complete: queue empty or budget reached
    Active --> Stopped: error (saved as active)
    Active --> Stopped: AbortSignal
    Complete --> Cleaned: --clean end
    Complete --> Retained: default
    Stopped --> Retained: keep state/artifacts
    Cleaned --> [*]
    Retained --> [*]
```

- One issue failure restores its checkout, persists the failed outcome, retains
  artifacts, and continues to later issues.
- The agent runtime is closed on success, failure, cancellation, and scoped defects. Ordinary
  failures set process exit code `1`.
- Cancellation is checked before long-running boundaries and passed into the agent runtime.
  Ralphie attempts to restore the clean issue checkpoint, saves resumable state,
  skips cleanup, and exits `130`.
- Successful completion persists `complete` before optional `--clean end`
  removes the entire workspace. Cleanup is skipped on failure so state and
  diagnostics remain available.

An ordinary issue failure never stops the queue. Ralphie restores the failed
issue checkout, records its outcome, and continues independent issues. Failed
prerequisites are not marked complete, so dependent issues remain blocked.
After draining all reachable work, the run exits with status `1` and an
aggregate partial-failure summary.

Needs-attention outcomes also continue the queue. A drained run completes with
status `0`, and the deferred issue remains open. The deterministic
`decomposition_limit_reached` boundary behaves the same way: raise the
persisted `--max-decomposition-depth`, narrow the issue, or resolve its review
findings manually before a later run. It never closes or marks the capped
issue complete, so dependent work remains blocked.

## Needs-attention handling

A validated needs-attention decision is not an ordinary failure. Ralphie
persists the summary, evidence, questions, and issue
freshness metadata in the run artifacts, keeps the issue open, and continues
with later work.
Notifications are disabled unless `--notify-needs-attention` is supplied; a
label by itself is rejected. When opted in, Ralphie first persists the
structured outcome and notification label intent, then publishes through the
GitHub notification service. Notification applies only to agent-reported
needs-attention blockers: issues held back by open queue dependencies are
recorded as needs-attention outcomes but never notified or labeled, because
their blocker resolves by queue completion rather than by a human decision.
A failed or uncertain notification remains at an explicit
notification-recovery boundary; resume preserves the saved
notification intent and label, reconciles the stable marker, and retries
without rerunning agent work or closing the issue. Dry runs report
needs-attention outcomes but never publish notifications.

When any executor session requests needs attention, Ralphie first persists the
bounded request, clean checkpoint, and issue freshness fingerprint. Exactly one
fresh read-only grounding session verifies that request before the next artifact,
Git, or GitHub mutation. Only a `needs_attention` verifier disposition confirms
it; actionable and already-resolved dispositions continue the original flow.
The confirmed decision is persisted before recovery writes a bounded binary-safe
patch and decision diagnostic, then restores and verifies the exact clean
checkpoint. A verifier or recovery interruption retains the handoff so resume
can retry verification or recovery without rerunning completed agent work.
The saved decision and handoff are reused only when live `updatedAt` and comment
freshness metadata exactly match; a changed or invalid fingerprint removes both
atomically before routing continues.

```mermaid
stateDiagram-v2
    state "Issue in progress" as IssueInProgress
    state "Recoverable stop" as RecoverableStop
    state "Artifacts retained" as Retained
    state "Workspace cleaned" as Cleaned

    [*] --> Active: Start or resume
    Active --> IssueInProgress: Dequeue issue
    IssueInProgress --> Active: Persist outcome and queue
    IssueInProgress --> RecoverableStop: Failure or interruption
    RecoverableStop --> Active: Resume and reconcile
    Active --> Complete: Queue empty or budget reached
    Complete --> Retained: Keep workspace
    Complete --> Cleaned: --clean end
    Retained --> [*]
    Cleaned --> [*]
```

Needs-attention recovery diagnostics use the same issue directory and contain
`changes.patch` plus `metadata.json` under a fingerprint-bound
`needs-attention-<id>/` directory. The patch includes tracked staged and unstaged
changes as well as untracked files. Matching diagnostics are reused on resume;
a fresh fingerprint receives a distinct directory. Diagnostics are published
atomically before the exact checkpoint is restored and verified.

## Resume and reconciliation

On resume, Ralphie compares persisted intent with both local Git and live GitHub
state before returning to `Active`. Pending issues use the freshly discovered
GitHub snapshots, including issue update and comment freshness metadata. It can
reconcile partially created child issues, a commit created immediately before
interruption, an issue closure whose response was lost, and a needs-attention
notification whose response or label mutation was uncertain without repeating
the corresponding agent work.To resume an interrupted run, provide its saved state file:

```bash
bunx @beremaran/ralphie owner/repository \
  --branch main \
  --resume ~/.ralphie/.ralphie/runs/<run-id>/state.json
```

The repository and branch must match the saved run. On `--resume`:

1. the command loads and validates the saved state;
2. workflow preflight prepares the workspace and checkout and refetches issues;
3. reconciliation compares saved intent with current Git and GitHub state;
4. the saved pending queue, completed numbers, outcomes, and artifacts are
   restored; and
5. the next safe deterministic step continues without unnecessarily rerunning
   pi work.

Examples of resumable boundaries:

- a saved complexity decision is reused;
- a checkpoint plus created commit can finish a push without rerunning the
  implementation/review loop;
- an active `issue-closure` with a completed outcome resumes closure without
  rerunning implementation;
- an active `notification-recovery` retries the saved structured outcome and
  stable GitHub marker without rerunning agent work; and
- a partially created decomposition reuses marker-discovered children and the
  saved key mapping; native sub-issue attachments and `blocked_by` dependencies
  are reconciled idempotently, and a child attached to the wrong parent or a
  native relationship that disagrees with a child's marker halts with a
  recovery diagnostic instead of silently reparenting or duplicating issues.


Native sub-issue and dependency endpoints require `github.com`; GitHub
Enterprise Server is not supported by the current client. With an unavailable
endpoint or a token lacking issue write permission, live decomposition fails with
an actionable error naming the missing capability; there is no body-link fallback.
See [Workflows](workflows.md#platform-support-for-native-sub-issues-and-dependencies).

An ordinary issue failure never stops the queue. Ralphie restores the failed
issue checkout, records its outcome, and continues independent work; the
drained run exits `1` if any issue failed.

A deterministic verification command returning non-zero is handled before it
becomes an issue failure. Ralphie gives the bounded command output and staged
diff to a fresh verification-fix session, restages its changes, and retries up
to five times. Only repair exhaustion or a non-repairable verification fault
(for example missing configuration or a command changing the staged tree)
reaches the ordinary failure boundary.

## Cleanup

`--clean end` removes the entire workspace after success, including completed
state, events, diagnostics, and the repository checkout. Cleanup is skipped on
failure so recovery remains possible. `--clean start` removes the workspace
before preparation, after protected-path checks; resumed runs skip start
cleanup. `--clean both` does both. Use these options only with a path dedicated to
Ralphie; see [Safety](safety.md) for the destructive workspace contract.
