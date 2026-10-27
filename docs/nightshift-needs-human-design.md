# Night Shift: when a card needs a person

Status: design, approved in direction by Tianyi on 2026-09-28. Built in three steps.

## The gap

Night Shift recovers by itself from infrastructure faults: lease timeouts, Worker loss, a Session that died mid-run (#80). Everything else ends the same way. The card sits `blocked`, the reason stays in the card's comments or the Agent's last message, and nobody is told.

The person who could decide finds out only by looking at the board. What they would decide is never asked, and nothing carries the decision back into the run. Four cases from V show the pattern:

| Date | Card | What only a person could decide |
|---|---|---|
| 09-26 | GEE-TIMED-PUB 圣山-BR-008 | GeeLark returned 20206. Retry on another device, or give up this post? The project could never finish, because one failed item keeps it `active` forever. |
| 09-28 | DL-0928-07 item 1 | 中纺 has one source video. Makaron could not fetch it after it was repeated nine times. Add footage, accept repetitive videos, or skip? |
| 09-28 | DL-0928-01 item 11, 03 item 6 | The Agent died and the video was ready. This one is now automatic (#80). |
| 09-28 | DL-0928-02 delivery | A lease timeout struck with no ledger entry. Safe to retry, but nothing said so. |

Each of these was found by an operator reading logs. The error was different each time. The missing step was always the same: tell the right person what is wrong, offer the choices, and continue from their choice.

## Principle

"Needs a person" is the board's **需要你**. It is one queue, and the engine owns it. It is not a per-error rule and not a second concept next to 需要你.

The queue holds everything only a person can move:

- **Approvals.** Execution confirmation, output review and publication authorization. They already have their choices: approve, request changes, reject. Today their `reviewRequested` notice is accepted and ignored. Here they reach people through the same notice as everything else.
- **Stops.** A card that stopped and will not recover by itself. This design adds these.

- Anything that stops and will not recover by itself becomes a **decision request**. That covers a problem an Agent files, a block the Agent leaves without a filed problem, a failed completion contract, a failed external operation, and an infrastructure fault that has used up its retries.
- The engine keeps one truth. The board's 需要你, the Feishu notice and `nightshiftctl` all read the same records, both approvals and decision requests. A board that decides on its own drifts: today it shows DL-0928-07 item 1 as "paid task still running, will recover" because the ledger still says `executing`, although the Agent gave up and Makaron failed twice.
- Choices are generic. Every request offers **retry** (with a note for the Agent), **skip this item** and **pause the project**. An Agent may add choices specific to the problem. Each of those is a retry that carries a note.
- A decision flows back into the run. A retry carries the person's note into the Agent's brief. A skip makes the item terminal, so the project can still finish. A pause stops dispatch.

## What reaches a person (2026-09-29)

A card may block for many reasons. A notice exists to tell someone what they have to handle, so only stops a person can act on are announced. A stop of the substrate, such as a Gateway error, a Worker failure, an Agent DB lease timeout or a run that timed out, is the engine's to retry. It may block the card; it is never announced.

From 2026-09-28 to 09-29 V opened ten requests. Two needed a person: Makaron failed twice on 中纺, and a GeeLark publication failed. Eight did not:

| Cause | Requests | Announced as |
|---|---|---|
| The run failed or timed out before the Agent's first turn | 2 | the handoff is missing |
| The run failed or timed out mid-work | 3 | the handoff is missing; the payment is unrecorded |
| The run was still going; the card was blocked anyway | 1 | the payment is unrecorded |
| Outputs cited by absolute path inside the instance | 2 | files delivered outside the project |

Six of the eight took one path. The engine read the transcript to learn why a run stopped, found no terminal message, tried to salvage written outputs and, finding none, recorded a contract failure. A contract failure skips the grace period and the paid-work guard, so it was announced at once. Absence of evidence became a verdict. Meanwhile the Gateway's task registry held the answer for every one of them: `failed` with "Agent DB process coordinator wait exceeded", `failed` with "Agent run failed", `timed_out`, or still `running`.

The rules:
- **Facts before inference.** A blocked card is explained first by how the Gateway says its run ended. A run still going is left alone. A failed or timed-out run is the substrate's stop and follows the retry policy. Only a run that ended normally is judged by the Agent's transcript and outputs.
- **Salvage is not judgement.** Recovering written outputs completes a card when they pass; when they do not, nothing is recorded.
- **Only positive evidence is announced.** A request opens when the Agent stopped on purpose, when its finished outputs fail the contract, when a paid operation failed or may have been charged, or when retries are used up. A card nobody can explain waits an hour, longer than the engine's 45-minute orphan rule, before it reaches a person.

## What the card asks, and what the engine does itself (2026-10-08)

From 2026-09-28 to 10-08 V decided 42 stops. Every one was answered with retry or skip, almost always without a note; 13 were retried by a monitoring session noting that the run had been interrupted. Only a handful needed something only a person could do: top up a provider balance (DL-0929-02 item 15), supply footage the library lacked (DL-0929-10 item 21), fix a rejected phone proxy (GeeLark Brazil, 10-07), look at a video that failed its checks (DL-1008-04 item 22). The cards never said which: they named the engine's rule and quoted the Agent's English first sentence. Retrying also looped where it could not move: a card's ledger key carries the item's revision, so the same card meets the same reserved, failed or hung operation every time (DL-1008-04 item 28, DL-0929-08 item 25, GeeLark 圣山-BR-015).

The rules:
- **The Agent says what a person must do.** Every brief asks a stopping Agent to open its final message with `需要人做：` (an instruction for someone who is not technical, saying where to do it, or `无`) and `原因：` (one sentence). Agents never see the operator skill, so the brief is the only place this can be asked.
- **A stop that asks nothing is the engine's.** After two minutes (its Agent may still be working) the engine goes on by itself, at most twice per item and stage, and pays for at most one fresh attempt (Tianyi). After that, or when the Agent asked for something, the stop reaches a person.
- **One way to go on.** Going on uses the same card when its external call can still move: nothing registered, a result to reuse, a task still running once. Otherwise it is a fresh attempt: the item's revision goes up, the stage (and later stages that ran on it) start over with new cards, and their paid call is a new operation. Old operations are never touched.
- **The card asks, it does not report.** It shows what to do and one sentence of why, then the answers: 继续 (labelled 处理好了，继续 after an ask, 再试一次 otherwise, with its cost in the description), 这条不做了, 暂停项目. A paid result that exists but failed its checks offers 用这次的结果 or 重新生成 instead of 继续. A published post is never published again.

## Project-scope external-operation recovery (2026-10-27)

For a stopped `scope: project` stage, a person's **continue**, or V invoking the
explicit recovery API, can authorize a new operation after its ledger records a
definitive `failed` outcome. Its choice
explicitly warns about a new external action and, for paid stages, possible new
charges. This is not an automatic retry and does not imply that the failed call
was free: that conclusion still needs supplier evidence. Requests carrying the
older no-charge wording must refresh before they can authorize a new operation.

- The new identity is derived from a new persisted `stage_runs.attempt`; no schema
  migration is needed. The old card, request hash, operation and receipt remain.
- Only that stage and already-run dependent project stages are revised. Upstream
  stages (such as a completed purchase) stay done. A dependent stage that is
  running, has an external operation, or has already fanned out content items
  needs a separate explicit recovery plan; this path refuses to invalidate it.
- Revision reservations and `project-stage.redo.requested` are one transaction.
  The stopped source card is their idempotency boundary. Replaying a decision,
  including after a process restart, cannot allocate another revision.
- `succeeded` reuses its result; `executing` with an external task ID resumes
  reading that task, on the same card and operation. `reserved`, `unknown`, or
  `executing` without a readable task remain blocked for supplier readback. A
  person's generic continue does not bypass an ambiguous-outcome payment gate.
- Existing stage approvals still apply to the pinned target; planning a new
  card does not bypass an approval that is missing or expired. Content-item
  recovery and redo keep their existing behavior.

### V can recover work from any channel

Tianyi clarified on 2026-10-27: recovery must be callable by V in a group, direct
chat, or a workflow run. It must not require a person to click a dashboard button
or wait for an engine-created decision request. This is a caller-initiated
recovery capability, not a new scheduler auto-retry policy.

```sh
nightshiftctl cards retry <card-id> --actor V --note "<what was fixed / how to continue>"
# Only when a new external call is needed and covered by the task authorization:
nightshiftctl cards retry <card-id> --actor V --note "<correction>" --allow-new-operation
```

The existing endpoint is `POST /api/cards/:id/retry`, with `note` (or legacy
`evidence`) and the boolean
`allowNewOperation`. It derives project/stage/item from the actual card, takes the
authenticated actor (or local V identity), serializes recovery, and enqueues only
the existing guarded scheduler. It does not start a second Agent or bypass
admission. It reads just that card, not a full board snapshot.

V may invoke this within the task's existing authorization without asking a
person to click again. `--allow-new-operation` is V's explicit intent and audit
record, not a human-only token and not permission to expand the budget, buy a
second account, or change the publication target. The stage's approval must
still be valid. Unknown supplier outcomes require readback even with the flag.
A paused project stays paused. Repeated resume of a replaced or already queued
card is a no-op; old open requests are superseded, not falsely recorded as a
person's decision. The caller and note are recorded as `stage.resume.requested`.

Agent first: V uses the existing `cards retry` control; the existing dashboard
Retry button and `decisions decide` remain auxiliary entry points. No new UI
button is introduced. `cards resume` and `/api/cards/:id/resume` are aliases, not
a second recovery policy. Both public HTTP routes use the same serialized,
ledger-aware runtime operation. The internal same-card retry helper still resets
the native failure budget and releases stale claims; it is not a public bypass.
A legacy Retry click never silently authorizes a new paid/external operation.
Do not create a replacement project, clear the old ledger, or retry a completed
upstream purchase. Existing owned operations and their keys survive input edits
and legacy formats. Multiple owned operations require readback, not guessing.

### Why the anti-duplicate gate stays

- [Platform #20](https://github.com/vegekyd-sys/v-openclaw-platform/pull/20)
  introduced paid/public-operation checkpoints: interruption of local work does
  not prove the supplier did not execute or charge.
- [Platform #28](https://github.com/vegekyd-sys/v-openclaw-platform/pull/28)
  repaired stale claims while preserving the key: executing+task ID continues the
  original task; reserved without a task ID requires readback, never resubmission.
- [Platform #47](https://github.com/vegekyd-sys/v-openclaw-platform/pull/47)
  reset exhausted native failure budgets so reopening a card actually executes.
- [Platform #128](https://github.com/vegekyd-sys/v-openclaw-platform/pull/128)
  and [#132](https://github.com/vegekyd-sys/v-openclaw-platform/pull/132)
  added item revisions and fixed keys after real board normalization. That
  recovery was limited to content items, leaving project stages without it.
- [Nightshift #4](https://github.com/vegekyd-sys/v-nightshift/pull/4) added
  ledger-aware continuation and bounded automatic recovery. This PR extends the
  explicit caller-driven project recovery, not that scheduler's retry policy.

A recorded `failed` status is not evidence of zero cost. A new revision may charge
again and needs caller intent within existing approval. Successful results remain
reusable; readable executing tasks keep their ID; ambiguous project/V outcomes
remain held. These protections do not require a human-only button.

Pre-merge integration scenario: `lab/candidate/project-stage-recovery.mjs`. It
uses a private Gateway's real Workboard plus synthetic SQLite, reopens the DB,
and proves corrected-hash reservation without dispatching an Agent or supplier.

## Model

A new table, `decision_requests`, holds one row per card attempt that needs a person:

```
id, instance_id, card_id, content_item_id, stage_id, attempt,
source        agent | engine
problem       short text the person reads first
detail        what was tried and the evidence (markdown)
scope         item | project
options       JSON: [{ id, label, effect: retry|skip|pause, note? }]
group_key     requests with the same root cause share it, so one notice covers N cards
status        open | decided | superseded
decision      JSON: { optionId, note, actor, at }
created_at, decided_at
```

### How a request is opened

1. **The Agent files it** (step 2). The stage cannot proceed because a condition is not met, for example missing footage, a provider refusal, or an input that is wrong. The Agent runs `nightshiftctl cards needs-decision <card> --file problem.json` instead of only blocking. `problem.json` carries `problem`, `detail`, `scope`, an optional `groupKey` and optional extra `options`. The engine records the request and blocks the card.
2. **The engine opens it** (step 1). A card sits blocked with a recorded failure, no automatic retry is due and no request exists. A card with no recorded failure waits an hour first (see *What reaches a person*). The engine then opens one itself.
   - The problem text comes from the recorded failure: completion rejection, attempt failure or failed operation. Failing that, it comes from the Agent's last comment or final message.
   - It is the safety net. Every stop reaches a person, even when the Agent did not file anything.
   - A card whose paid operation is still `executing` is included once its Agent Session is terminal or silent (#80). A stale ledger must not hide a stop.

A new attempt of the card supersedes its open request.

### How a person hears about it

- The completion-notice path gains a second event, `needsYou`. It covers approvals waiting on a person as well as decision requests; it replaces the ignored `reviewRequested`. Its routing is the same as the completion notice: the project's own `collaboration.sourceChatId`, then the Workflow's `notifications.*.to`.
- There is **one notice per project per root cause**. Requests are batched for about two minutes and grouped by `group_key`. The notice reads, for example: "DL-0928-07：5 条卡在同一个问题：素材只有 1 段视频，Makaron 拉取超时". It lists the choices and links to the decision view on the board.
- A new root cause, or a new card joining a group that was already announced, updates the notice. Unchanged requests are never announced again.
- The board's 需要你 lists open decision requests and pending approvals, both served by the engine.

### How a decision continues the run

`POST /api/decisions/:id` takes `{ optionId, note, actor, applyToGroup }`, and so does `nightshiftctl decisions decide`.

- **continue**: the engine goes on (see above): the same card retried, or a fresh attempt under a new revision. The decision and the person's note reach the next attempt's brief. With `applyToGroup`, every open request in the group that offers it gets the same decision.
- **retry** (用这次的结果, and requests opened before 2026-10-08): the same card is retried.
- **redo** (重新生成): a fresh attempt under a new revision, whatever the ledger says.
- **skip**: the item is recorded as skipped (`skipped_content_items`, 2026-09-30). The engine plans nothing more for it and leaves it out of every stage that waits on all items and of `workflowComplete`. The completion notice reports the skipped items with their reasons. Only a stop on one content item offers it.
- **pause**: the project is paused, as `projects pause` does. Its open requests stay open until the project is restarted and a decision is made.

Each decision is an audit event (`decision.requested`, `decision.decided`).

## Steps

1. **Engine safety net and notice.** The table; opening requests from blocked cards; the `needsYou` notice (decision requests and pending approvals) routed like the completion notice; the decide API and `nightshiftctl` for retry and pause; `overview` exposes open requests so the board can show them.
2. **Agent-filed problems and the full set of choices.** `nightshiftctl cards needs-decision`; Agent-supplied choices; skip as a terminal item state; the decision note in the retry brief; buttons on the Feishu notice. The existing `nightshift-feishu` plugin already handles card commands.
3. **Authoring.** The operator skill and the workflow authoring reference tell stages to check preconditions before they spend money, and to file a problem instead of improvising. For example, a brief stage checks that the footage covers the items before any paid production. The pattern was seen on 09-28: one video reused across 30 briefs, and Agents downloading footage to work around provider limits.

## Ownership

- Engine, API, notices and CLI: 夜班模式 - 监控 session.
- Board decision view (需要你 reads the engine's queue of decision requests and approvals; a decide drawer): 夜班模式 - 设计 session, which owns the dashboard client.
