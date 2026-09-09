import assert from "node:assert/strict";
import test from "node:test";
import { validateExecutionEvidence } from "../src/execution-evidence.mjs";

const readSkill = (name) => ({
  role: "assistant",
  content: [{ type: "toolCall", name: "read", arguments: { path: `/workspace/skills/${name}/SKILL.md` } }],
});

test("accepts exact declared Skill reads for the current attempt", () => {
  const evidence = validateExecutionEvidence({
    cardId: "card-1",
    messages: [readSkill("finished-video-brief"), readSkill("makaron")],
    requiredSkills: ["finished-video-brief", "makaron"],
  });
  assert.deepEqual(evidence.loadedSkills, ["finished-video-brief", "makaron"]);
});

test("records missing Skill read telemetry without rejecting verified work", () => {
  const evidence = validateExecutionEvidence({
    cardId: "card-1",
    messages: [readSkill("makaron")],
    requiredSkills: ["finished-video-brief", "makaron"],
  });
  assert.deepEqual(evidence.missingSkillReadTelemetry, ["finished-video-brief"]);
  assert.equal(evidence.skillEvidence, "workboard-declaration");
});

test("rejects undeclared Skill reads", () => {
  assert.throws(() => validateExecutionEvidence({
    cardId: "card-1",
    messages: [readSkill("makaron"), readSkill("unrelated-ops")],
    requiredSkills: ["makaron"],
  }), /Undeclared Skill.*unrelated-ops/i);
});

test("rejects an attempt that mutates another Workboard card", () => {
  assert.throws(() => validateExecutionEvidence({
    cardId: "card-1",
    messages: [
      readSkill("makaron"),
      { role: "assistant", content: [{ type: "toolCall", name: "workboard_complete", arguments: { id: "card-2" } }] },
    ],
    requiredSkills: ["makaron"],
  }), /one-attempt-one-card/i);
});
