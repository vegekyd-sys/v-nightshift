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
| `NIGHTSHIFT_DISPATCH_INITIAL_MAX_ACTIVE` | 3 | Concurrency the ramp starts from after a restart or a red probe. |
| `NIGHTSHIFT_GATEWAY_GREEN_LATENCY_MS` / `_RED_LATENCY_MS` | 250 / 1000 | Worker status RPC latency that pauses growth or halves the target. |
| `NIGHTSHIFT_CARD_REFRESH_MIN_INTERVAL_MS` | 30000 | An explicit `refresh=1` read younger than this is served from the cache. |
| `NIGHTSHIFT_BOARD_READ_CHUNK` | 200 | Cards per scoped `workboard.cards.list` request. The Gateway client drops any frame over 25 MiB with close code 1006; at ~13 KB per card (≤36 KB) 200 cards stay near 7 MiB. |
| `NIGHTSHIFT_CARD_LABEL_MAX` | 40 | Longest card label the Gateway accepts. A content item id gets this minus `content-item:`. Raise it here once the Gateway's own limit is raised. |
| `NIGHTSHIFT_SCHEDULER_RETRY_MIN_MS` / `_MAX_MS` | 10000 / 120000 | Backoff between retries after a failed scheduler pass. |
| `NIGHTSHIFT_SCHEDULER_EVENT_MIN_INTERVAL_MS` | 5000 | Floor between event-driven scheduler passes. Raising it trades stage handoff latency for Gateway main-thread time; 15000 is a reasonable production setting. |

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

## Orphaned runs

A card can sit blocked after its Agent is gone. Usually its Worker exited mid-run, for example while polling a provider, and the Session never gets a terminal message. The scheduler checks blocked cards' Sessions on repair passes. When a blocked card's Session has written nothing for `NIGHTSHIFT_ORPHANED_SESSION_MS` (45 minutes), it records `stage.attempt.failed` with kind `agent_interrupted`, and the stage's ordinary retry policy takes over:
- A stage with side effects retries automatically only when the external-operation ledger holds an `executing` or `succeeded` entry with an external task id for that card. The retried Agent then resumes the existing provider task instead of paying again.
- Without such an entry the card stays blocked with "需要人工检查后重试".

A blocked card whose Session has no messages at all, two minutes after its attempt started, never ran: the Worker blocked it before the Agent's first turn. It records `stage.attempt.failed` with kind `agent_not_started` ("Agent 没能启动") and retries automatically, paid stages included, since an attempt that never took a turn cannot have spent anything. The exception is a paid card whose ledger still holds a `reserved` entry, or an `executing` one without an external task id, from an earlier attempt: that one waits for a person. On 2026-09-29 such a brief card, blocked 7 s after dispatch during Agent DB lease contention, had been checked for written artifacts instead and reached 需要你 as "the handoff is missing".

Blocked-card Session checks have their own budget, separate from completion validation. A card deferred for budget is checked on the next ordinary pass rather than at the next repair tick. On 2026-09-28, sharing that budget left two paid produce cards unread and blocked for two hours, while Makaron had finished both videos 3 minutes after their Agents died.

Running cards are never stopped by this guard. A retried card also gets its native failure budget reset (`workboard.cards.reassign`), because the board refuses to start a card whose failure count exceeds `maxRetries`.

## 需要你 (cards that need a person)

A card that stops and will not recover by itself becomes a decision request (`decision_requests`), owned by the engine. The design is in `docs/nightshift-needs-human-design.md`.

**What opens a request**
- A blocked card with a recorded failure and no automatic retry due opens a request on the same pass.
- A blocked card with no failure waits out a 2-minute grace period first. The board shows it as pending.
- The problem text is the Agent's own closing words (`failure.agentReport`) when the Agent stopped on purpose, otherwise the engine's reason.

**What never opens one**
- Cards the engine retries by itself.
- Paid work still `executing` with no recorded stop.
- Shelved projects: paused and untouched for more than 3 days.
Cards blocked before the first run (baseline `needs-you-v1.baseline` in `notification_metadata`) still enter the queue, so the board shows them, but they are not announced.

**The queue.** 需要你 is open decision requests plus review cards waiting on a person, both approvals and human-review stages. `GET /api/overview` returns it as `needsYou { items, pending, countsByInstance }` for every project that is not shelved, whatever the scope.

**Deciding.** `POST /api/decisions/:id { optionId, note, actor, applyToGroup }`, or `nightshiftctl decisions decide <id> --option retry|pause [--note …] [--apply-to-group]`.
- **retry** re-runs the card with `## 人工决定` and the note on top of its brief.
- **pause** pauses the project and leaves the request open.
- A second decision returns the first (`alreadyDecided`).

**What a request says.** Each request carries the text of the accepted card layout:
- `problem`: what happened;
- `cause`: why;
- `impact`: the engine adds "N 张卡停在「stage」";
- `suggestion`: what to do;
- options, each with a one-line description.

An Agent that stops writes its closing report under the labels 问题 / 原因 / 影响 / 建议, and each label fills its field. Unlabeled reports fall back to their sentences, and a missing suggestion falls back to one that fits the kind of stop.

**Notice.** The `needsYou` event goes to the project's `collaboration.sourceChatId`, else to the Workflow's `notifications.needsYou.to`, else to the `instanceCompleted` target. There is one notice per project per 2-minute batch, grouped by root cause (`groupKey`). Review cards already waiting when the notice first runs are not announced (`needs-you-notice-v1.bootstrap`).

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
