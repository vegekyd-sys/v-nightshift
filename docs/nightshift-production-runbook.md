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

## Required acceptance

1. Loopback health and `nightshiftctl health`.
2. Workflow list and Xingqing 0.4.5 Skill preflight for Agent `makaron`.
3. Native card create/list/dispatch and Session linkage.
4. Browser login and Live Board read through the authenticated public hostname.
5. A real project with declared artifacts and human review.
6. `NRestarts=0`, no scheduler error, no Gateway/Worker regression.

## Upgrade

V creates a short-lived branch, runs tests, pushes a Draft PR, and validates in VLab. A production update reuses the same accepted commit and archive checksum. Do not edit an installed release or production SQLite in place.

## Rollback

Use the command printed by deploy. Rollback restores the previous release pointer, service definition, and Night Shift state snapshot, then verifies loopback health. It does not roll back OpenClaw Gateway, Session Store, Memory, or Feishu configuration because Night Shift does not mutate them.
