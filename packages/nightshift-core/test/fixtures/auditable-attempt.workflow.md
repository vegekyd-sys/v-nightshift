---
apiVersion: nightshift.versa.ai/v1alpha1
kind: Workflow
metadata:
  id: nightshift-auditable-attempt-canary
  version: 0.1.0
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

This is an isolated engine canary with one input row. Use exec to read the
project-inputs.json snapshot declared in the input. Inside the declared
nightshift.instanceDir, write result.json containing {"verified":true,"row":
the exact input row}. Then write handoffs/plan.json using the Stage handoff
example below, with planResult pointing to result.json and projectInputs
pointing to project-inputs.json. Read both files back before completing this
card through the native Workboard completion tool. Load only nightshift-audit-canary; do not load other Skills,
send messages, create other cards, or access any other project. No media
generation or external publication is part of this canary.

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
