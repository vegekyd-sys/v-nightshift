# Night Shift Workboard product architecture

Status: DRAFT

This document defines Night Shift as a reusable automation product. Xingqing
content delivery is the first reference workflow, not the engine itself.

## Product promise

An operator can define and publish a versioned workflow, start a project, and
watch agents claim, execute, review, and complete work from one Workboard.
Human approvals happen on the same surface. External systems such as Base,
Scene, Makaron, GeeLark, and Apify remain integrations, not competing workflow
interfaces.

## Product rules

1. One operator surface: the Night Shift Workboard is the place where people
   see project state, agent activity, evidence, blockers, and approvals.
2. One canonical workflow artifact: `workflow.yaml` is edited visually or as
   code, but both modes change the same parsed document.
3. Immutable releases: publishing creates a version and content hash. Running
   instances stay pinned to that exact release.
4. Workboard owns orchestration state: claim, running, review, blocked, done,
   attempts, heartbeat, and proof live in native Workboard cards/runs.
5. Business systems own their facts: adapters read and write Base, Scene,
   Makaron, GeeLark, and Apify objects. Their facts are projected into card and
   project views; they do not independently advance the workflow.
6. Deterministic scheduling: an orchestrator computes runnable stages from the
   workflow graph and recorded events. An LLM does not poll every few minutes
   to decide whether anything changed.
7. VLab first: development, migration, failure recovery, and real workflow
   acceptance happen in VLab before any production promotion is proposed.

## User-facing information architecture

### 1. Live board

The main screen is designed to stay open on a shared display.

- Filters: workflow, project/instance, customer, agent, and status.
- Columns: `Ready`, `Running`, `Review`, `Blocked`, and `Done`.
- Each card shows project, stage, assigned agent, elapsed time, progress,
  latest event, artifacts, and blocking reason.
- A display mode hides configuration chrome and emphasizes active work,
  reviews, failures, and throughput.
- Opening a card shows business context, the live agent timeline, tool/skill
  activity, proof, artifacts, retry history, and approval actions.

### 2. Workflow designer

- Visual graph and code editor are two views of the same `workflow.yaml` AST.
- V can create or modify a draft through the UI or workflow tools.
- Validation reports missing inputs, cycles, unsafe side effects, missing
  retry/idempotency rules, and unavailable skills before publish.
- A graph preview and dry-run simulation show the path for representative
  inputs.
- Publishing is explicit and produces `workflow_id`, `version`, and SHA-256.
- A change that adds paid production, external publication, destructive
  actions, or broader authorization requires human approval before activation.

### 3. Project/instance view

- Shows the frozen workflow version and current stage.
- Shows the project input, outputs, approvals, total cost/usage, and external
  object links.
- Provides pause, resume, retry-safe, cancel, and archive operations.
- All operations append audit events; they do not rewrite history.

## Runtime architecture

```text
workflow.yaml draft
        |
        v
validator + compiler ----> immutable workflow release
        |                              |
        |                              v
        |                      workflow instance
        |                              |
        v                              v
visual designer <---- Night Shift control plane ----> unified Workboard UI
                                |
                                v
                     deterministic orchestrator
                      /          |          \
                     v           v           v
            native Workboard   approvals   adapter outbox
                cards/runs                   |
                     |                       v
                     v            Base / Scene / Makaron /
              OpenClaw Worker       GeeLark / Apify
```

## Component boundaries

### Night Shift plugin/service

The product should be a versioned external component, not an untracked patch to
the installed OpenClaw bundle. It owns:

- workflow registry, drafts, validation, releases, and instance metadata;
- deterministic graph evaluation and event processing;
- adapter outbox, idempotency ledger, approvals, and audit events;
- the unified UI and Gateway RPC/tools used by V and operators.

It delegates execution lifecycle to native Workboard and OpenClaw Worker.

The first VLab spike must verify whether the current OpenClaw release supports
a safe external Control UI route. If not, serve the UI as a separate loopback
application behind the VLab administration tunnel. Do not patch the bundled
Control UI merely to win the spike.

### Native Workboard

Native Workboard remains the execution runtime:

- card lifecycle, assignment, dependencies, claims, attempts, heartbeat;
- Worker session linkage, logs, proof, artifacts, diagnostics;
- completion, block, retry, reclaim, cancel, and notification events.

Night Shift stores the native card ID on each stage run. It does not create a
second claim or Worker lifecycle system.

### Adapters

Every external integration implements the same narrow contract:

- resolve declared inputs;
- perform a named operation with an idempotency key;
- return typed outputs and evidence;
- read back the authoritative external result;
- report retryable, blocked, or terminal failure without advancing state.

Base becomes an optional business-data adapter and read model. It is no longer
a second scheduler or a screen an operator must keep open to understand the
workflow.

## Runtime model

The minimum durable entities are:

- `WorkflowDraft`: mutable definition before publish.
- `WorkflowRelease`: immutable version, content hash, and compatibility data.
- `Instance`: one project run pinned to one release and authorization scope.
- `StageRun`: reference from `(instance, stage, attempt)` to a native Workboard
  card/run.
- `Approval`: requested decision, actor, evidence, scope, and expiration.
- `ExternalOperation`: adapter, operation, idempotency key, request hash,
  external ID, and readback state.
- `AuditEvent`: append-only state transition and evidence reference.

## Orchestrator contract

The orchestrator reacts to instance creation, card completion/block, approval,
timer, and adapter-result events.

For each event it:

1. loads the pinned workflow release and instance state;
2. computes the newly runnable stages;
3. verifies conditions, authorization, dependency completion, and idempotency;
4. creates or reuses exactly one native Workboard card per stage run;
5. dispatches within workflow and global concurrency limits;
6. validates completion proof and declared outputs;
7. records the transition and wakes downstream stages;
8. creates a Review or Blocked card when a human decision is required.

A low-frequency recovery scan may detect lost events, stale cards, and expired
approvals. It does not run an agent turn when there is no work.

## V editing contract

V can manage workflows through tools such as:

- `workflow_list`, `workflow_read`, `workflow_create_draft`;
- `workflow_patch_draft`, `workflow_validate`, `workflow_simulate`;
- `workflow_diff`, `workflow_publish`;
- `workflow_start_instance`, `workflow_pause_instance`.

V edits drafts, explains the diff, validates, and runs a VLab simulation. A
published release is never modified in place. Production activation remains a
separate release decision.

## Acceptance bar

The first product release is accepted only when VLab proves:

- the same workflow can be created through code and visual editing with an
  identical canonical result;
- two different workflows run on the same engine without workflow-specific
  orchestrator code;
- the board alone is sufficient to understand status and perform approvals;
- Worker crash, Gateway restart, duplicate events, timeout, cancellation, and
  retry do not duplicate paid production or publication;
- external readback and proof are visible from the card;
- a real new Xingqing input reaches a real new deliverable without reusing a
  historical output as the primary acceptance evidence.

