# Night Shift production handoff

Night Shift production is a separate loopback service. It uses the production OpenClaw Gateway and native board `nightshift`, but does not own Feishu ingress and never replaces or restarts the Gateway.

## Ownership

- Code and release scripts: `vegekyd-sys/v-openclaw-platform`.
- V operating Skill and durable product model: `vegekyd-sys/v-core/skills/night-shift-operator`.
- Runtime state: `/home/openclaw/.openclaw/nightshift`.
- Immutable releases: `/home/openclaw/releases/nightshift-workboard/<commit>`.
- Service: `nightshift-workboard.service`, loopback `127.0.0.1:24879`.
- Native Workboard board: `nightshift`.

## Release

Package the exact reviewed commit. The packager builds the dashboard inside a clean archive and prints its SHA-256:

```bash
scripts/package-nightshift-release.sh <commit> /tmp/nightshift-workboard.tgz
```

Transfer the archive, verify its SHA-256, then run:

```bash
sudo scripts/manage-nightshift-production.sh deploy <artifact.tgz> <sha256> <commit>
```

The deploy command prints the immutable release, backup, and exact rollback command. It stops/restarts only Night Shift, not `openclaw-gateway.service`.

Append `--code-only` for a release without a SQLite schema change. It skips the multi-gigabyte state snapshot, so scheduling pauses only for the dependency install, and rollback restores the previous release and unit while leaving the data directory untouched.

## Elastic admission

Night Shift starts new native cards only while the Gateway host has headroom, and keeps Worker sessions free for interactive use. The service exposes the effective values in `/api/health`; tune them in a systemd drop-in and restart only Night Shift.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NIGHTSHIFT_RESERVED_INTERACTIVE_SLOTS` | 9 | Worker sessions never handed to Night Shift; foreground load above this shrinks Night Shift capacity further. |
| `NIGHTSHIFT_RESERVED_INTERACTIVE_WORKERS` | 3 | Whole Workers never handed to Night Shift. The pool gives each Session its own Worker before packing a second into any process, so N running cards hold N Workers. Reserving only Session slots left one free Worker on V while the Session arithmetic still reported 29 spare. |
| `NIGHTSHIFT_HOST_MEMORY_RESERVE_PERCENT` | 40 | Percent of host RAM that must stay available before a new job is admitted. |
| `NIGHTSHIFT_HOST_MEMORY_RESERVE_MIB` | 4096 | Absolute floor for the same reserve. The larger of the two applies. |
| `NIGHTSHIFT_AGENT_DB_PRESSURE` | on | Set `0` to stop reading Agent DB lease pressure (below). |
| `NIGHTSHIFT_GATEWAY_UNIT` | `openclaw-gateway` | systemd unit whose journal carries the lease signals. Set it on hosts where the Gateway runs under another unit name. |
| `NIGHTSHIFT_AGENT_DB_PRESSURE_WINDOW_SECONDS` | 120 | How far back each reading looks. |
| `NIGHTSHIFT_AGENT_DB_SLOW_ADMISSION_YELLOW` | 3 | Slow lease admissions in the window that stop new starts. |
| `NIGHTSHIFT_USER_HARM_COOLDOWN_MS` | 900000 | Hold after a lease timeout cut a person's reply. Quiet probes cannot end it early. |
| `NIGHTSHIFT_ORPHANED_SESSION_MS` | 2700000 | A blocked card whose Agent Session has written nothing for this long is failed as `agent_interrupted` and handed to the stage's retry policy. |
| `NIGHTSHIFT_WARMUP_WINDOW_MS` / `NIGHTSHIFT_WARMUP_MAX_CARDS` | 90000 / 3 | At most this many Night Shift cards in their first minutes at once; a start waits until one leaves its window (see below). |
| `NIGHTSHIFT_DISPATCH_INITIAL_MAX_ACTIVE` | 3 | Concurrency the ramp starts from after a restart or a red probe. |
| `NIGHTSHIFT_GATEWAY_GREEN_LATENCY_MS` / `_RED_LATENCY_MS` | 250 / 1000 | Worker status RPC latency that pauses growth or halves the target. |
| `NIGHTSHIFT_CARD_REFRESH_MIN_INTERVAL_MS` | 30000 | An explicit `refresh=1` read younger than this is served from the cache. |
| `NIGHTSHIFT_BOARD_READ_CHUNK` | 200 | Cards per scoped `workboard.cards.list` request. The Gateway client drops any frame over 25 MiB with close code 1006; at ~13 KB per card (≤36 KB) 200 cards stay near 7 MiB. |
| `NIGHTSHIFT_CARD_LABEL_MAX` | 40 | Longest card label the Gateway accepts. A content item id gets this minus `content-item:`. Raise it here once the Gateway's own limit is raised. |
| `NIGHTSHIFT_SCHEDULER_RETRY_MIN_MS` / `_MAX_MS` | 10000 / 120000 | Backoff between retries after a failed scheduler pass. |
| `NIGHTSHIFT_SCHEDULER_EVENT_MIN_INTERVAL_MS` | 5000 | Floor between event-driven scheduler passes. Raising it trades stage handoff latency for Gateway main-thread time; 15000 is a reasonable production setting. |

### Warm-up slots

A card's first minutes are its heaviest on the agent database: its Session is built, context and Skills load, and the first turns are written. On V on 2026-09-29, 10 of the 14 Night Shift runs cut by Agent DB lease timeouts were in their first 5 minutes, and the worst clusters followed 5 to 7 starts within 5 minutes. The start budget (3 per 15 s) allowed that, because it spaces starts but does not see how many new cards are still warming up.

A scheduler pass therefore starts at most `NIGHTSHIFT_WARMUP_MAX_CARDS` minus the running cards started within `NIGHTSHIFT_WARMUP_WINDOW_MS`. When that is zero, the next pass is scheduled for the moment the oldest warming card leaves its window. `/api/health` reports it as `dispatchWarmup { warming, maxWarming, windowMs, available, retryAfterMs }`. The other brakes apply on top; this one only spreads starts out.

The default, 3 cards per 90 s, is Tianyi's choice for throughput (2026-09-29). Most cut runs were 2 to 5 minutes into their run, so a longer window protects more; if lease timeouts stay frequent, lengthen `NIGHTSHIFT_WARMUP_WINDOW_MS` in the drop-in and restart only Night Shift.

### Agent DB lease pressure

Every Agent run writes through one process-global lease on the agent database, and a writer that waits 5 s is killed. Night Shift cards write far more than chat turns, so under load the lease saturates while Workers still have room and the Gateway probe stays green. On V at 10:21 on 2026-09-24 that cut two people's replies with every other signal healthy.

Night Shift therefore reads the Gateway journal (`journalctl -u $NIGHTSHIFT_GATEWAY_UNIT --grep`, as the service user) and reports the result as `dispatchPressure.agentDbPressure` in `/api/health`:

| Level | Condition | Effect |
| --- | --- | --- |
| red | a run ended with `coordinator wait exceeded` in the window | Target halves, no starts for the red cooldown. If the run was a person's (not `workboard:`), the hold is `NIGHTSHIFT_USER_HARM_COOLDOWN_MS` and cannot end early. |
| yellow | slow admissions ≥ threshold | No new starts; running cards continue. |
| unknown | journal unreadable, empty for the unit, or failing | Recorded with a reason; does not block. The other probes still gate. |

A cut reply also sets a ceiling, `dispatchPressure.harmCeiling` in `/api/health`, at 70% of the Night Shift cards running when it happened. Recovery is capped there, including the rule that admits one card beyond those still running, so it cannot jump straight back to the level that caused the harm. The ceiling starts rising when the hold ends: one card per 5 quiet minutes. It lowers again at the next separate cut reply and disappears once it climbs back to `maxActive`. It is held in memory, so a service restart forgets it. On 2026-09-28, without it, recovery at 15:10 returned to the ten cards that had cut a reply at 14:55, and two more replies were cut at 15:22.

### First come, first delivered

The starts that admission allows in one scheduler pass are shared by every project, whatever its Workflow. Projects take them in the order they were created:
- The earliest project takes as many as its Workflow lets one project run (`concurrency.perInstance`).
- The next project takes what is left, and so on.
- A project that arrives when nothing is left waits.

How many projects move together follows from how much admission allows. No fixed count applies. `concurrency.maxActiveInstances`, which was declared in Workflows but never enforced, is now refused at publish; releases published before keep it and it is ignored.

A project waiting only on a person or on a release time has nothing to start, so it holds no place in the queue. Once it can start again, it takes the next free start ahead of any project that arrived after it. Cards already running elsewhere finish; only new starts go to the earlier project.

Each project's place is reported as `control.queue` in `/api/overview`:
- `running`: it has cards running.
- `queued`, with `position`: it has cards ready to start and got no start in the last pass. The board shows 「排队第 N 位」.
- `waiting`: it has nothing to start.

Before this, the scheduler visited projects by last update. On 2026-09-29 that gave the few free starts to the newest batches: DL-0929-01, started at 11:49, sat queued behind projects that arrived four hours later, and all seven batches were heading to finish together late at night.

### A project's own session limit

How many cards one project may run at once can be set while it runs, by an operator or by an Agent. V sets it through the CLI:

```bash
nightshiftctl projects concurrency <project>                                 # show
nightshiftctl projects concurrency <project> 6 --actor V --reason "机器空闲，加快"
nightshiftctl projects concurrency <project> default --reason "高峰结束"
```

- The limit is 1 to 8 (`PROJECT_CONCURRENCY_MAX`). `default` clears it, and the project runs by its Workflow's `concurrency.perInstance` again. A project nobody set runs exactly as before.
- It is stored in `instance_controls.per_instance_limit`. The column is added at startup; a database from before it is upgraded in place, and an older release ignores it.
- It only changes that project's share. The board-wide brakes still cap every start: Agent DB pressure, host memory, `maxActive`, and the first-come queue. Raising one project while the host is braking starts nothing new.
- Every change is an audit event `concurrency.control.changed` with the actor, the reason and the limits before and after. `/api/instances/:id` and `/api/overview` report `control.concurrency { effective, project, workflow, max }`.
- API: `POST /api/instances/:id/concurrency { perInstance: 1–8 | null | "default", reason, actor }`.

### Jumping the queue

A project's place in the queue can be changed while it runs, by an operator or by an Agent on its own judgement (a delivery promise, a customer waiting, a project whose materials need fixing first):

```bash
nightshiftctl projects queue                                              # the order now
nightshiftctl projects priority <project> first --actor V --reason "客户明早要"
nightshiftctl projects priority <project> last  --reason "素材有问题，先放后面"
nightshiftctl projects priority <project> default
nightshiftctl projects order <a> <b> <c> --actor V --reason "按交付承诺排"
```

- The queue orders by priority, higher first, then by arrival. A project nobody set has priority 0, so with no priorities set the order is exactly first come, first delivered.
- `first` sets one above every other active project and `last` one below. A number from -1000 to 1000 sets it directly. `order` puts the listed projects ahead of every other, in the order given; projects not listed keep theirs. `default` clears it.
- It orders only new starts. Cards already running finish. Together with the project's session limit it decides how many of the free starts each project takes, and the board-wide brakes still decide how many there are.
- Stored in `instance_controls.priority` and reported as `control.priority`, and as `priority` in `control.queue`. Each change is an audit event `queue.priority.changed` with the actor, the reason, and the priority before and after.
- API: `POST /api/instances/:id/priority { priority: n | "first" | "last" | "default", reason, actor }` and `POST /api/queue/order { instanceIds: [...], reason, actor }`.

## Why a blocked card stopped

A blocked card is first explained by how its run ended, as the Gateway records it (`tasks.list` for the card's Session, matched by run id). The Workboard keeps no reason for a blocked attempt; the Gateway's task registry does.
- **Still `running` or `queued`**: the Agent is alive. The card is not failed, not salvaged and not announced; it is asked again in the next five-minute window. On 2026-09-29 a produce card blocked at 16:38 while its Agent kept working reached a person, and the Agent finished the video at 16:41.
- **`failed`, `timed_out`**: the substrate stopped the run (Agent DB lease timeouts, provider errors, timeouts). It records `stage.attempt.failed` with the kind the error names (`database_lock`, `connection_reset`, …, otherwise `agent_interrupted`) and retries by the stage's policy. A paid stage retries too, unless its ledger holds an operation this card left `reserved`, or `executing` without an external task id: that may have been charged, so it goes to a person. Agents reserve on the ledger before any paid call.
- **`cancelled`**: recorded as `run_cancelled`, not retried. A run the Gateway killed while restarting is not judged here: see *Gateway restarts*.
- **Ended normally**: the Agent's own transcript and outputs decide, as below. Every stop that needed a person on V from 2026-09-26 to 09-29 had a run that ended normally.

A card still shown `running` is asked too when its transcript ends on an error (`stopReason` error or aborted): a run the Gateway still has running is left alone, and a failed run is classified from the Gateway's record. On 2026-09-29 a transcript ending on "incomplete or malformed tool call", from a run the Gateway recorded as a failed provider request, had been classified as the Agent's own error.

Faults of the substrate have their own retry allowance: up to 5 attempts (backoff 1, 5, 15, 15, 30 minutes) or the stage's `retry.maxAttempts`, whichever is larger. Before, lease timeouts and a Gateway restart could use up a produce card's three attempts and open a request.

When the Gateway has no entry for the run, the transcript rules below apply.

**Written outputs are salvaged, never judged.** A blocked card with no recorded failure is checked for outputs a finished attempt may have left behind; when they satisfy the contract the card completes. When they do not, nothing is recorded: the board shows "Outputs not found yet: …" and the card waits. Before this, a failed salvage became a contract failure, and eight stopped runs on 2026-09-28/29 reached 需要你 as missing handoffs and unrecorded payments.

## Gateway restarts

Night Shift pauses by itself while the Gateway restarts and picks its work back up afterwards. Whoever restarts the Gateway does not need to tell anyone. On 2026-09-30 two restarts by a release session (12:53, 13:01) ended two produce runs, one reached the group as a decision, and three sessions had to message each other to recover them.

What starts the hold (`packages/nightshift-core/src/gateway-restart-hold.mjs`), whichever comes first:
- the Gateway's own `shutdown` broadcast, sent when it restarts itself (SIGUSR1, release scripts, a config change that restarts), whoever asked;
- the persistent connection dropping: a crash, SIGKILL, or a stop that ran past systemd's 45 s timeout never broadcasts, and a SIGTERM stop (systemctl) closes the socket before its broadcast reaches clients;
- a different Gateway `bootId` in the next hello, which also catches a restart that happened while Night Shift itself was down.

While held, no scheduler pass runs: nothing is dispatched, no card is judged, nothing reaches 需要你, and the capacity probe is skipped (a restarting Gateway would read as overload and brake dispatch). The hold survives a Night Shift restart.

When the Gateway is back, Night Shift waits `NIGHTSHIFT_GATEWAY_RESTART_SETTLE_MS` (60 s) for the new process to warm up, then resumes every card the restart interrupted (`runtime.resumeAfterGatewayRestart`):
- a run that ended `cancelled`, `failed`, `timed_out` or `error` between 3 minutes before the hold and the Gateway's return (the drain kills runs with "subagent run terminated" just before the broadcast);
- when the boot id changed, a run the registry still lists as `running` with no activity since the return: a run cannot outlive the process that ran it (2026-09-30 08:26).

Such a card is blocked if it still shows running, then retried. It records `stage.gateway-restart.resumed`, not `stage.attempt.failed`, so it does not spend the card's retries however many restarts there are. A paid card resumes only when its ledger holds nothing `reserved`, or `executing` without an external task id; an already submitted task is only read back. Otherwise it records `gateway_restart` and goes to a person, because it may have been charged. After the pickup, normal scheduling resumes with the usual warm-up slots.

`/api/health` shows the whole state as `gatewayRestart`; `/api/overview` shows `gatewayRestart.status` (`up`, `holding`, `resuming`) for the board, plus what the last pickup did. A shutdown broadcast whose process never went away releases the hold after 5 minutes.

Checked on VLab (candidate, 2026-09-30, `lab/candidate/nightshift-gateway-restart.mjs`) against a private Gateway with a real Workboard card whose Agent was running `sleep 900`: SIGUSR1 broadcast `shutdown` ("gateway restarting") and Night Shift held at once; the process took 5.5 minutes to exit and the run was recorded `cancelled` ("Subagent run killed."); after the new boot and the settle, the pickup put the card back to ready with no failure recorded. SIGTERM and SIGKILL were held through the dropped connection and found the new boot id.

A run that is still in flight when the Gateway stops is always lost: the Gateway kills it during its drain and cannot wait for a produce run to finish. The resumed card runs its stage again from the start; a paid task already submitted is only read back.

## Orphaned runs

A card can sit blocked after its Agent is gone. Usually its Worker exited mid-run, for example while polling a provider, and the Session never gets a terminal message. The scheduler checks blocked cards' Sessions on repair passes. When a blocked card's Session has written nothing for `NIGHTSHIFT_ORPHANED_SESSION_MS` (45 minutes), it records `stage.attempt.failed` with kind `agent_interrupted`, and the stage's ordinary retry policy takes over:
- A stage with side effects retries automatically only when the external-operation ledger holds an `executing` or `succeeded` entry with an external task id for that card. The retried Agent then resumes the existing provider task instead of paying again.
- Without such an entry the card stays blocked with "需要人工检查后重试".

A blocked card whose Session has no messages at all, two minutes after its attempt started, never ran: the Worker blocked it before the Agent's first turn. It records `stage.attempt.failed` with kind `agent_not_started` ("Agent 没能启动") and retries automatically, paid stages included, since an attempt that never took a turn cannot have spent anything. The exception is a paid card whose ledger still holds a `reserved` entry, or an `executing` one without an external task id, from an earlier attempt: that one waits for a person. On 2026-09-29 such a brief card, blocked 7 s after dispatch during Agent DB lease contention, had been checked for written artifacts instead and reached 需要你 as "the handoff is missing".

Blocked-card Session checks have their own budget, separate from completion validation. A card deferred for budget is checked on the next ordinary pass rather than at the next repair tick. On 2026-09-28, sharing that budget left two paid produce cards unread and blocked for two hours, while Makaron had finished both videos 3 minutes after their Agents died.

Running cards are never stopped by this guard. A retried card also gets its native failure budget reset (`workboard.cards.reassign`), because the board refuses to start a card whose failure count exceeds `maxRetries`.

## 需要你 (cards that need a person)

A card that stops and will not recover by itself becomes a decision request (`decision_requests`), owned by the engine. The design is in `docs/nightshift-needs-human-design.md`.

**Only what a person can act on is announced.** A card may block for many reasons; a request says what someone has to do. A stop of the substrate (a failed, timed-out or interrupted run) is retried, never announced. Only these open a request:
- the Agent stopped on purpose and said why (a filed problem or its closing words);
- the Agent finished and its outputs fail the contract;
- a paid or external operation failed, or may have been charged and cannot be retried safely;
- automatic retries are used up;
- approvals and reviews.

**What opens a request**
- A blocked card with a recorded failure and no automatic retry due opens a request on the same pass.
- A blocked card with no failure has no verdict yet. It waits 60 minutes, longer than the orphan rule below (45 minutes), so the engine's own verdict always comes first. The board shows it as pending (「正在判定是否需要你」).
- The problem text is the Agent's own closing words (`failure.agentReport`) when the Agent stopped on purpose, otherwise the engine's reason.

**What never opens one**
- Cards the engine retries by itself.
- Paid work still `executing` with no recorded stop.
- Shelved projects: paused and untouched for more than 3 days.
Cards blocked before the first run (baseline `needs-you-v1.baseline` in `notification_metadata`) still enter the queue, so the board shows them, but they are not announced.

**The queue.** 需要你 is open decision requests plus review cards waiting on a person, both approvals and human-review stages. `GET /api/overview` returns it as `needsYou { items, pending, countsByInstance }` for every project that is not shelved, whatever the scope.

**Deciding.** `POST /api/decisions/:id { optionId, note, actor, applyToGroup }`, or `nightshiftctl decisions decide <id> --option retry|skip|pause [--note …] [--apply-to-group]`.
- **retry** re-runs the card with `## 人工决定` and the note on top of its brief.
- **skip** (「跳过这一条」, offered only on a stop of one content item) takes that item out of the project. Nothing more is planned for it; stages that wait on every item, such as delivery, wait only on the rest, and their brief lists the skipped items with the reason so the Agent neither waits for nor packages them. The project stays active and completes without it; the completion notice lists what was skipped and why. It is stored in `skipped_content_items` (the note, or the request's problem, is the reason) with an audit event `content-item.skipped`; `content-items.json` is not rewritten. A stopped card of a skipped item stays on the board but never opens a request again. Requests opened before skip existed offer it too.
- **pause** pauses the whole project (no new cards at all) and leaves the request open. It is not a way to deliver the rest; use skip for that.
- A second decision returns the first (`alreadyDecided`).

**Reviews: 要求修改 redoes the item.** A review card offers approve, request-changes (「要求修改」) and reject (`POST /api/cards/:id/request-changes { evidence }`, or `nightshiftctl cards changes <card> --evidence …`). Request-changes on a content item's review redoes that item (`runtime.redoForChanges`):
- The redone stages are the Agent stages the review checks, from the first of them (the one that depends on no other stage the review checks), every content-item stage between, and the review itself. For `produce → qc-learn → review` that is produce, qc-learn and review; for xingqing's `produce → review`, produce and review. Project-scope stages are not redone for one item.
- Each gets a new attempt (a run in status `redo`, no card yet). A card's attempt is read back from Night Shift's own run rows by card id: the native board drops unknown automation fields, so `metadata.automation.attempt` never comes back. The planner makes a fresh card for it, in order, when its dependencies are done; the old cards stay as they were. The item's revision (`content_item_revisions`) is part of the new cards' idempotency key, so they are never matched to the old ones.
- A redone paid stage reserves a new ledger operation: the revision is part of the operation key the reserve endpoint and completion validation resolve, so it is never told its first attempt's paid call already settled it.
- The new cards' brief carries the person's note verbatim ("Redo requested (revision N) …"). A paid stage pays again: the existing approval of that item still covers it, and asking for changes is asking for that.
- The old review card stays blocked but never opens a request: a card a newer attempt of its stage replaced is nobody's matter. On V on 2026-09-30 the review a person had sent back reached 需要你 itself.
- A second request while the redo is under way (a redone stage ready, running or waiting) records the decision and does not stack another redo.
- Audit event `content-item.redo.requested`.

Before this, nothing could redo a finished item: the done cards could not be retried and the review sat blocked. On V on 2026-09-30 ref1 and ref2 of NS-BATCHV2-0929-01 waited five hours after a person asked for changes, while the operator retried their approval cards and approved again. **An approval card cannot be retried** now: it is a gate, not work. Approve it to let its stage run; to redo a finished item, request changes on its review.

**What a request says.** Each request carries the text of the accepted card layout:
- `problem`: what happened;
- `cause`: why;
- `impact`: the engine adds "N 张卡停在「stage」";
- `suggestion`: what to do;
- options, each with a one-line description.

An Agent that stops writes its closing report under the labels 问题 / 原因 / 影响 / 建议, and each label fills its field. Unlabeled reports fall back to their sentences, and a missing suggestion falls back to one that fits the kind of stop.

**Notice.** The `needsYou` event goes to the project's `collaboration.sourceChatId`, else to the Workflow's `notifications.needsYou.to`, else to the `instanceCompleted` target. There is one notice per project per 2-minute batch, grouped by root cause (`groupKey`). Review cards already waiting when the notice first runs are not announced (`needs-you-notice-v1.bootstrap`).

## Delivery page template

A download project can end in a web page instead of a zip. The page is a template; the engine has no part in it (Tianyi, 2026-10-02: the engine offers neutral services to every Workflow, and a delivery is the Agent's work). Packing every video into one zip on V took time and disk, everyone downloaded the whole package, and on 2026-09-30 a Windows-illegal name in one hid 14 of 20 videos.

- **The page**: `https://nightshift.tianyi.live/deliver/?m=<manifest URL>`, served by the Night Shift web server as a static file (source `apps/nightshift-dashboard/delivery`, build `vite.delivery.config.mjs` into `dist/deliver`), without login. It plays each video from its CDN, saves one, and 「下载全部」 zips them in the viewer's browser (client-zip: straight to disk in Chromium, in memory up to 1.5 GB elsewhere, one by one on phones). Names are cleaned of characters Windows refuses and never repeat.
- **The manifest** (written and uploaded by the Agent):
  ```json
  {"version": 1, "title": "客户 英语 20条", "deliveredAt": "2026-10-02T08:00:00+08:00",
   "items": [{"title": "…", "url": "https://cdn.makaron.app/…mp4", "fileName": "…mp4", "bytes": 38513653, "durationSec": 20.1}]}
  ```
  Only `title` and `url` are required per item. Every name is the Agent's, as written: `fileName` names each file (any length, any extension; without it, the item title plus the URL's extension) and an optional top-level `archiveName` names the 「下载全部」 zip (without it, the title). A Workflow's naming rule therefore never needs a change to the page. The page only replaces characters Windows refuses and numbers two files that would share a name. The manifest and every video must be https on a trusted host (`cdn.makaron.app`, Makaron's and V's Supabase storage, `delivery/manifest.js`); anything else is not shown. The page's Content-Security-Policy allows media and fetches from those hosts only.
- **Which URL a video gets**: a video exactly as the provider rendered it keeps the provider's link. A video V changed after that (BGM, trim, re-encode: 10–80% of a project's videos on 2026-10-02) is uploaded by the Agent with its CDN upload skill (Makaron's CDN for now; V Base later) and linked there. Checking is the Agent's job: compare the provider URL's size with the validated file.

## Feishu completion notices

When a project reaches `done`, Night Shift sends a Feishu card ("项目已完成", with done/blocked counts and a link to the project) to the person it belongs to. Enabled by `NIGHTSHIFT_FEISHU_NOTIFICATIONS=1` in the unit file; sent through `openclaw message send --channel feishu --presentation`.

A project is announced only if its Workflow declares `spec.notifications.instanceCompleted.enabled: true` **and** a target resolves:

1. the project's own `collaboration.sourceChatId`: the requester's own chat (`user:ou_…`) or a group (`oc_…`), recorded when V creates the project from a Feishu conversation;
2. otherwise the Workflow's `spec.notifications.instanceCompleted.to`, for projects a schedule creates.

Set or change a running project's target with `nightshiftctl projects collaboration <id> --to <oc_…|user:ou_…> [--by <ou_…>]`.

Each transition to `done` is sent once. A failed send is retried on later passes, up to five attempts. Failures appear as `notifications.lastError` in `/api/health` and never as a scheduler error. The first pass after an upgrade records every project's current state and sends nothing, so projects finished before the upgrade are not announced.

This feature first shipped on 2026-08-25 from a side branch (`5cb239f`), never reached dev, and was replaced by the next release built from dev. Review cards (approve/reject from Feishu) from that build are not carried over.

## Timed release

A stage that declares `releaseAt` gets its card immediately, carrying the release
instant as the native Workboard `scheduledAt`. The board holds it in `scheduled`,
refuses any early start, and promotes it to `ready` during the scoped dispatch
Night Shift already makes. The service schedules its next wake for that instant,
so the release does not wait for the five-minute repair pass; if that wake is
lost, the repair pass is the backstop and the card goes out up to five minutes
late. Held cards appear in the Live Board's own `Scheduled` column and never
consume a dispatch slot while they wait.

A recurring window is resolved in its IANA zone on the target date, so a nightly
21:00 in New York survives the daylight-saving change. Authoring rules live in
the `night-shift-operator` Skill, `references/workflow-authoring.md`.

## Board read cost

A routine pass reads only the cards that can still change; the five-minute repair pass reads every card its projects own. Measured on V on 2026-09-17 before this split: 17.6 reads a minute of 319 cards each, about a tenth of the Gateway main thread. Of those 319, 240 had already reached a terminal state and 168 belonged to paused or archived projects held in by a single stale `running` record.

## Board reads

The service never lists the whole native board on a schedule. Scheduler passes, project ticks, decisions, retries and human takeovers read the exact card IDs recorded for the project. `GET /api/cards?refresh=1` and `GET /api/bootstrap?refresh=1` read only the cards of projects that are not archived, and `includeArchived=1` is the one path that walks the whole board; both honour the minimum interval above. A mature production board holds thousands of archived cards, and each full listing walks every one of them on the Gateway main thread. Acceptance scripts must poll `/api/cards` without `refresh=1`.

The 40 percent default was sized on a 16 GiB lab host. A 32 GiB production host that should run Night Shift whenever it is idle normally uses 20 percent with the 4 GiB floor.

## Required acceptance

1. Loopback health and `nightshiftctl health`.
2. Workflow list and Xingqing 0.4.5 Skill preflight for Agent `makaron`.
3. Native card create/list/dispatch and Session linkage.
4. Browser login and Live Board read through the authenticated public hostname.
5. A real project with declared artifacts and human review.
6. `NRestarts=0`, no scheduler error, no Gateway/Worker regression.

## Upgrade

V creates a short-lived branch, runs tests, pushes a Draft PR, and validates in VLab. A production update reuses the same accepted commit and archive checksum. Do not edit an installed release or production SQLite in place.

## Test data governance

Run `nightshiftctl governance audit --refresh` to report expired test/acceptance/canary projects, repeated immutable action labels, and orphan cards. The audit is read-only and never blocks project creation or dispatch.

Archive one confirmed project with `nightshiftctl projects archive <id> --actor <name> --reason <reason>`. Archive refuses running projects, preserves every native card and its evidence, and hides the project from the default Live Board. Restore with `nightshiftctl projects restore <id> --actor <name> --reason <reason>`; restore is dispatch-free and returns a previously active project as paused.

Use an explicit reviewed project-id manifest for batch cleanup. Back up first, archive sequentially, verify each response, and stop on the first mismatch. Never infer a destructive batch from title text alone.

Preview an exact manifest with `nightshiftctl governance archive <manifest.json>`. Apply the same validated manifest with `--apply --actor <name> --reason <reason>`. Every entry pins the expected project status and card count so a changed project stops the batch before mutation.

## Required commands

A workflow may declare the CLIs its agent stages call — `spec.requiredCommands`, `stage.requiredCommands`, or `routeStrategies.<route>.requiredCommands`, bare executable names only. `POST /api/instances/preflight` and project creation resolve each name through the Night Shift service's PATH and refuse the project (422, `commands.missing`) when one is not executable. Declare `scene`, `makaron-cli`, and `lark-cli` on every Xingqing workflow: when a CLI is missing the agent does not stop, it searches the filesystem and greps for keys, which is the recursive-grep incident from 2026-09-17. The check runs on the service host, so it only proves anything when the service and the worker share a host and PATH, as they do on V.

## Instance storage

`nightshift/instances` is the main disk growth on V (8–11 GB/day). Since 2026-09-18 it is a bind mount onto the data disk (`/srv/openclaw-data/disk1/openclaw/nightshift-instances`); the path under `~/.openclaw/nightshift/instances` is unchanged. Check the mount with `sudo findmnt /home/openclaw/.openclaw/nightshift/instances` — a plain `df` without sudo returns nothing for that mount point.

Open item: `openclaw-storage-lifecycle.service` (04:53 daily) has `source_root` pointing at `/srv/openclaw-data/disk/openclaw-storage/cold-migrated-2/openclaw/backups/nightshift-workboard` (188 KB on the data disk), so it reports `storage_level=critical` every day while freeing nothing on the root disk. Repoint it at the real instance store once the bind mount is verified; do not run it against the root disk while a project is active.

## Rollback

Use the command printed by deploy. Rollback restores the previous release pointer, service definition, and Night Shift state snapshot, then verifies loopback health. It does not roll back OpenClaw Gateway, Session Store, Memory, or Feishu configuration because Night Shift does not mutate them.
