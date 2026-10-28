---
apiVersion: nightshift.versa.ai/v1alpha1
kind: Workflow
metadata:
  id: repeat-verified-work
  version: 0.1.0
  name: 调用同一流程直到验证通过
spec:
  ownerAgentRole: operator
  concurrency: {perInstance: 1}
  inputs:
    brief: {type: string, required: true}
  limits: {maxOperations: 0, maxDuration: 2h}
---

# 循环调用示例

先发布 reusable-verified-work.workflow.md，再发布本文件。SHA 绑定的是该示例的确切内容，不能用 latest；改子流程时必须显式更新调用方版本和 SHA。本例不授权任何采购、外呼或发布。

## STAGE verified-work｜获得达标成果

```stage
actor: workflow
scope: project
timeout: 2h
outputs: [result]
call:
  workflow: 5b363116b280a95e72743c419c633f76d74dc87d5f4a265f9c2bab9f79bea207
  inputs:
    brief: {from: input.brief}
    reuseAllowed: {from: previous.result.reuseAllowed, default: false}
    resourceRef: {from: previous.result.resourceRef}
repeat:
  until: {output: result.accepted, equals: true}
  while: {output: result.retryable, equals: true}
  maxIterations: 3
  maxDuration: 2h
  maxOperations: 0
```

## STAGE deliver｜交付已验证成果

### Goal

读取 verified-work 的 result，交付通过验证的成果及其证据引用。循环未通过前不得提前交付。

```stage
actor: agent
skills: [lark-doc]
needs: [verified-work]
outputs: [delivery]
completeWhen: [output.delivery.exists]
timeout: 20m
```
