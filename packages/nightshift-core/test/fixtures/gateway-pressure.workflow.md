---
apiVersion: nightshift.versa.ai/v1alpha1
kind: Workflow
metadata:
  id: gateway-pressure-canary
  version: 0.1.0
  name: Gateway Pressure Canary
spec:
  ownerAgentRole: operator
  concurrency: {perInstance: 1, maxActiveInstances: 30}
  completion: {mode: strict-v1}
  handoff: {version: 1, mode: stage-input-output}
  inputs:
    row: {type: string, required: true}
---

# Gateway Pressure Canary

## STAGE verify｜No-side-effect V verification

### Goal

Perform no external action. Confirm that this isolated V Session is responsive,
write the declared local JSON receipt and pinned handoff, then complete only
this Workboard card. Do not inspect or modify another card.

```stage
actor: agent
scope: project
skills: [background-worker-contract]
outputs: [canaryReceipt]
outputContracts:
  canaryReceipt: {type: json}
completeWhen: [output.canaryReceipt.verified]
timeout: 5m
retry: {maxAttempts: 1, idempotencyKey: "${instance.id}:verify:${input.hash}"}
```
