---
apiVersion: nightshift.versa.ai/v1alpha1
kind: Workflow
metadata:
  id: generic-agent-delivery
  version: 0.1.1-draft
  name: 通用 Agent 交付
spec:
  ownerAgentRole: operator
  concurrency: {perInstance: 1}
  inputs:
    briefUrl: {type: string, required: true}
---

# 通用 Agent 交付

这个模板证明同一套 Night Shift 引擎并不依赖星擎、视频路线或 Scene。

## STAGE understand｜读取与计划

### Goal

读取输入，明确事实、缺口、执行方案和验收条件。

```stage
actor: agent
scope: project
skills: [lark-doc]
outputs: [executionPlan]
completeWhen: [output.executionPlan.traceable]
timeout: 30m
retry: {maxAttempts: 2, idempotencyKey: "${instance.id}:understand:${input.hash}"}
next: [execute]
```

## STAGE execute｜执行与自检

### Goal

按计划生成新的交付物，并完成可验证的自检。

```stage
actor: agent
scope: project
skills: [makaron]
needs: [understand]
outputs: [deliverable, machineCheck]
completeWhen: [output.deliverable.accessible, output.machineCheck.terminal]
timeout: 4h
retry: {maxAttempts: 2, idempotencyKey: "${instance.id}:execute:${input.hash}"}
next: [review]
```

## STAGE review｜人工审核

### Goal

在 Workboard 查看交付物和证据，批准、要求修改或拒绝。

```stage
actor: human
scope: project
needs: [execute]
approval: {actions: [approve, request-changes, reject], evidenceRequired: true}
outputs: [decision]
timeout: 3d
```
