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

"Needs a person" is one state that the engine owns. It is not a per-error rule.

- Anything that stops and will not recover by itself becomes a **decision request**. That covers a problem an Agent files, a block the Agent leaves without a filed problem, a failed completion contract, a failed external operation, and an infrastructure fault that has used up its retries.
- The engine keeps one truth. The board's 需要你, the Feishu notice and `nightshiftctl` all read the same records. A board that decides on its own drifts: today it shows DL-0928-07 item 1 as "paid task still running, will recover" because the ledger still says `executing`, although the Agent gave up and Makaron failed twice.
- Choices are generic. Every request offers **retry** (with a note for the Agent), **skip this item** and **pause the project**. An Agent may add choices specific to the problem. Each of those is a retry that carries a note.
- A decision flows back into the run. A retry carries the person's note into the Agent's brief. A skip makes the item terminal, so the project can still finish. A pause stops dispatch.

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
2. **The engine opens it** (step 1). A card sits blocked, no automatic retry is due, no request exists, and it has sat for a short grace period. The engine then opens one itself.
   - The problem text comes from the recorded failure: completion rejection, attempt failure or failed operation. Failing that, it comes from the Agent's last comment or final message.
   - It is the safety net. Every stop reaches a person, even when the Agent did not file anything.
   - A card whose paid operation is still `executing` is included once its Agent Session is terminal or silent (#80). A stale ledger must not hide a stop.

A new attempt of the card supersedes its open request.

### How a person hears about it

- The completion-notice path gains a second event, `decisionRequested`. Its routing is the same as the completion notice: the project's own `collaboration.sourceChatId`, then the Workflow's `notifications.*.to`.
- There is **one notice per project per root cause**. Requests are batched for about two minutes and grouped by `group_key`. The notice reads, for example: "DL-0928-07：5 条卡在同一个问题：素材只有 1 段视频，Makaron 拉取超时". It lists the choices and links to the decision view on the board.
- A new root cause, or a new card joining a group that was already announced, updates the notice. Unchanged requests are never announced again.
- The board's 需要你 lists open requests from the same table.

### How a decision continues the run

`POST /api/decisions/:id` takes `{ optionId, note, actor, applyToGroup }`, and so does `nightshiftctl decisions decide`.

- **retry**: the card is retried. The decision and the person's note are added to the brief for the next attempt, so the Agent does not stop at the same point again. With `applyToGroup`, every open request in the group gets the same decision.
- **skip**: the item's remaining stages become `skipped`. `workflowComplete` treats a skipped item as finished. The completion notice reports "N 条完成，M 条跳过" with the reasons.
- **pause**: the project is paused, as `projects pause` does. Its open requests stay open until the project is restarted and a decision is made.

Each decision is an audit event (`decision.requested`, `decision.decided`).

## Steps

1. **Engine safety net and notice.** The table; opening requests from blocked cards; the `decisionRequested` notice routed like the completion notice; the decide API and `nightshiftctl` for retry and pause; `overview` exposes open requests so the board can show them.
2. **Agent-filed problems and the full set of choices.** `nightshiftctl cards needs-decision`; Agent-supplied choices; skip as a terminal item state; the decision note in the retry brief; buttons on the Feishu notice. The existing `nightshift-feishu` plugin already handles card commands.
3. **Authoring.** The operator skill and the workflow authoring reference tell stages to check preconditions before they spend money, and to file a problem instead of improvising. For example, a brief stage checks that the footage covers the items before any paid production. The pattern was seen on 09-28: one video reused across 30 briefs, and Agents downloading footage to work around provider limits.

## Ownership

- Engine, API, notices and CLI: 夜班模式 - 监控 session.
- Board decision view (需要你 reads `decision_requests`; a decide drawer): 夜班模式 - 设计 session, which owns the dashboard client.
