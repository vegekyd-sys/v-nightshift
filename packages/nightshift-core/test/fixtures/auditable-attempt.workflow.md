---
apiVersion: nightshift.versa.ai/v1alpha1
kind: Workflow
metadata:
  id: ns-attempt-canary
  version: 0.1.1
  name: Night Shift 审计链路 Canary
spec:
  ownerAgentRole: operator
  concurrency: {perInstance: 1, maxActiveInstances: 4}
  completion: {mode: strict-v1}
  handoff: {version: 1, mode: stage-input-output}
  inputs:
    row: {type: string, required: true}
---

# Night Shift 审计链路 Canary

## STAGE plan｜执行单条验收任务

### Goal

Run the single-row JSON canary described by nightshift-audit-canary. Write and
read back result.json and the pinned plan handoff, then complete only this card.

```stage
actor: agent
scope: project
skills: [nightshift-audit-canary]
outputs: [planResult]
outputContracts:
  planResult: {type: json}
completeWhen: [output.planResult.verified]
timeout: 5m
retry: {maxAttempts: 1, idempotencyKey: "${instance.id}:plan:${input.hash}"}
next: [review]
```

## STAGE review｜下游卡生成验收

### Goal

This human review card proves downstream creation. Leave it awaiting review.

```stage
actor: human
scope: project
needs: [plan]
outputs: [decision]
approval: {actions: [approve, request-changes, reject], evidenceRequired: true}
timeout: 1d
```
