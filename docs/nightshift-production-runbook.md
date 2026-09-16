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
| `NIGHTSHIFT_HOST_MEMORY_RESERVE_PERCENT` | 40 | Percent of host RAM that must stay available before a new job is admitted. |
| `NIGHTSHIFT_HOST_MEMORY_RESERVE_MIB` | 4096 | Absolute floor for the same reserve. The larger of the two applies. |
| `NIGHTSHIFT_DISPATCH_INITIAL_MAX_ACTIVE` | 3 | Concurrency the ramp starts from after a restart or a red probe. |
| `NIGHTSHIFT_GATEWAY_GREEN_LATENCY_MS` / `_RED_LATENCY_MS` | 250 / 1000 | Worker status RPC latency that pauses growth or halves the target. |
| `NIGHTSHIFT_CARD_REFRESH_MIN_INTERVAL_MS` | 30000 | An explicit `refresh=1` read younger than this is served from the cache. |

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

## Rollback

Use the command printed by deploy. Rollback restores the previous release pointer, service definition, and Night Shift state snapshot, then verifies loopback health. It does not roll back OpenClaw Gateway, Session Store, Memory, or Feishu configuration because Night Shift does not mutate them.
