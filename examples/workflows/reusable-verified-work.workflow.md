---
apiVersion: nightshift.versa.ai/v1alpha1
kind: Workflow
metadata:
  id: reusable-verified-work
  version: 0.1.0
  name: 可复用的准备、执行与验证
spec:
  ownerAgentRole: operator
  concurrency: {perInstance: 1}
  inputs:
    brief: {type: string, required: true}
    reuseAllowed: {type: boolean, required: true}
    resourceRef: {type: string}
  outputs:
    result: {stage: verify, output: result}
---

# 可复用工作单元

这是不产生费用或对外副作用的组合示例。三阶段的 skills 与产物契约只维护一份；调用方决定单次还是循环。实际业务应选用真正拥有该能力的 skill，不得为执行此示例而创建或采购资源。

## STAGE prepare｜准备或复用资源

### Goal

按 brief 整理可用资料。reuseAllowed 为 true 时核对并复用 resourceRef，否则准备本地资料；不采购、不提交外部任务。输出 resource.json，记录资源引用和复用证据。

```stage
actor: agent
skills: [lark-doc]
outputs: [resource]
completeWhen: [output.resource.exists]
timeout: 20m
```

## STAGE execute｜完成工作

### Goal

读取准备阶段的 resource，按 brief 形成一份可验证的成果 work.json；不对外发布。

```stage
actor: agent
skills: [lark-doc]
needs: [prepare]
outputs: [work]
completeWhen: [output.work.exists]
timeout: 20m
```

## STAGE verify｜验证并输出事实

### Goal

根据 brief 验证 work，写 result.json：accepted（布尔）、retryable（布尔）、reuseAllowed（布尔）、resourceRef（字符串）及 evidence（可追溯引用）。accepted 表示成果达标；不达标但有明确可改进路径才设 retryable=true；原因不明设为 false 并说明缺口。业务不达标仍正常提交验证结果，不把它伪装成任务崩溃。不输出密码、凭据或验证码。按正常 stage handoff 登记 result.json。

```stage
actor: agent
skills: [lark-doc]
needs: [execute]
outputs: [result]
outputContracts: {result: {type: json}}
completeWhen: [output.result.exists]
timeout: 20m
```
