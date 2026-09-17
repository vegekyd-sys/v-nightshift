---
apiVersion: nightshift.versa.ai/v1alpha1
kind: Workflow
metadata:
  id: timed-release-canary
  version: 0.1.0
  name: Timed Release Canary
spec:
  ownerAgentRole: operator
  concurrency: {perInstance: 2, maxActiveInstances: 30}
  completion: {mode: strict-v1}
  handoff: {version: 1, mode: stage-input-output}
  inputs:
    timezone: {type: string, required: true}
---

# Timed Release Canary

## STAGE finish｜Finish the video

### Goal

Produce the deliverable. No external action, no publication.

```stage
actor: agent
scope: project
skills: [background-worker-contract]
outputs: [deliverable]
outputContracts:
  deliverable: {type: json}
completeWhen: [output.deliverable.ready]
timeout: 5m
retry: {maxAttempts: 1, idempotencyKey: "${instance.id}:finish"}
```

## STAGE publish｜Publish in the evening window

### Goal

Publish the finished deliverable. This stage must not run before its release
moment; the board holds the card until then.

```stage
actor: agent
scope: project
skills: [background-worker-contract]
needs: [finish]
releaseAt:
  dailyAt: "21:00"
  timezone: "${input.timezone}"
outputs: [publicUrl]
outputContracts:
  publicUrl: {type: json}
completeWhen: [output.publicUrl.published]
timeout: 5m
retry: {maxAttempts: 1, idempotencyKey: "${instance.id}:publish"}
```
