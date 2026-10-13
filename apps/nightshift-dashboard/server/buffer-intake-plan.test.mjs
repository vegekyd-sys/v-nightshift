import assert from "node:assert/strict";
import test from "node:test";
import { demandWindow, planBufferIntake, utcForLocal, validateBufferReceipt } from "./buffer-intake-plan.mjs";
import { createBufferReadback } from "./buffer-readback.mjs";

function setup() {
  const inputs = { sourceProjectId: "F-TEST-1", enterpriseName: "企业甲", publicationTarget: { accountRecordId: "account", tiktokHandle: "handle", geelarkDeviceId: "device", market: "巴西", language: "葡萄牙语", timezone: "America/Sao_Paulo" }, testScope: { ...demandWindow("2026-10-13T15:00:00Z", "America/Sao_Paulo"), publishCount: 5, workdays: 5, scheduleLocalTime: "19:50" }, bufferTarget: { baseId: "base-test", tableId: "table-test" }, acceptedItems: Array.from({ length: 7 }, (_, i) => ({ id: `v${i + 1}`, url: `https://cdn.makaron.app/${i + 1}.mp4` })) };
  const copies = inputs.acceptedItems.map(item => ({ contentItemId: item.id, videoDesc: `Texto ${item.id}`, qc: { status: "passed" } }));
  return { inputs, copies };
}

test("seven accepted videos produce five workday slots and two unscheduled reserve rows", () => {
  const { inputs, copies } = setup();
  const plan = planBufferIntake(inputs, [], copies);
  assert.equal(plan.writes.length, 7);
  assert.equal(plan.writes.filter(entry => entry.fields.状态[0] === "已排期").length, 5);
  assert.equal(plan.writes.filter(entry => entry.fields.状态[0] === "待排期").length, 2);
  assert.deepEqual(plan.writes.filter(entry => entry.fields.状态[0] === "已排期").map(entry => entry.fields["计划发布时间(当地)"].slice(0, 10)), ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"]);
  assert.equal(plan.writes[0].fields["计划发布时间(UTC)"], "2026-10-14T22:50:00.000Z");
});

test("four existing slots remain untouched and admit just one new schedule", () => {
  const { inputs, copies } = setup();
  const dates = ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19"];
  const rows = dates.map((date, i) => ({ record_id: `old${i}`, 目标账号: "handle", 状态: ["已排期"], "计划发布时间(UTC)": utcForLocal(date, "19:50", "America/Sao_Paulo") }));
  const before = structuredClone(rows);
  const plan = planBufferIntake(inputs, rows, copies);
  assert.deepEqual(rows, before);
  assert.equal(plan.occupiedCount, 4);
  assert.equal(plan.writes.filter(entry => entry.fields.状态[0] === "已排期").length, 1);
  assert.equal(plan.writes.filter(entry => entry.fields.状态[0] === "待排期").length, 6);
});

test("older confirmed pending inventory is scheduled before a new batch", () => {
  const { inputs, copies } = setup();
  const old = { record_id: "old-pending", 条目标识: "older:v1", 企业名称: "企业甲", 国家市场: "巴西", 语言: "葡萄牙语", 目标账号: "handle", 云机ID: "device", 时区: "America/Sao_Paulo", 视频文件URL: "https://cdn.makaron.app/older.mp4", 发布文案: "Older copy", 状态: ["待排期"], 上传时间: "2026-10-12T08:00:00Z" };
  const plan = planBufferIntake(inputs, [old], copies);
  assert.equal(plan.writes[0].recordId, "old-pending");
  assert.deepEqual(Object.keys(plan.writes[0].fields).sort(), ["状态", "计划发布时间(UTC)", "计划发布时间(当地)"].sort());
  assert.equal(plan.writes.filter(entry => !entry.old && entry.fields.状态[0] === "已排期").length, 4);
});

test("a partial write followed by retry reuses records and never creates duplicate positions", () => {
  const { inputs, copies } = setup();
  const first = planBufferIntake(inputs, [], copies);
  const rows = first.writes.slice(0, 3).map((entry, i) => ({ ...entry.fields, record_id: `rec${i + 1}` }));
  const retry = planBufferIntake(inputs, rows, copies);
  assert.equal(retry.unchanged.length, 3);
  assert.equal(retry.writes.length, 4);
  assert.equal(retry.writes.filter(entry => entry.fields.状态[0] === "已排期").length, 2);
  assert.equal(retry.writes.filter(entry => entry.fields.状态[0] === "待排期").length, 2);
});

test("real pool readback, not recordedAll alone, determines a valid receipt", () => {
  const { inputs, copies } = setup();
  const plan = planBufferIntake(inputs, [], copies);
  const rows = plan.writes.map((entry, i) => ({ ...entry.fields, record_id: `rec${i + 1}` }));
  const receipt = { recordedAll: true, submittedCount: 7, scheduledCount: 5, pendingCount: 2, records: plan.writes.map((entry, i) => ({ contentItemId: entry.contentItemId, recordId: `rec${i + 1}` })) };
  assert.equal(validateBufferReceipt(receipt, inputs, rows).scheduledCount, 5);
  assert.throws(() => validateBufferReceipt(receipt, inputs, rows.slice(1)), /缺失/);
  const wrong = structuredClone(rows); wrong[0].目标账号 = "other";
  assert.throws(() => validateBufferReceipt(receipt, inputs, wrong), /目标账号/);
  const drift = structuredClone(rows); drift[0]["计划发布时间(当地)"] = "2026-10-14T20:50:00";
  assert.throws(() => validateBufferReceipt(receipt, inputs, drift), /不一致/);
  const overflow = [...rows, { ...rows[0], record_id: "other-record" }];
  assert.throws(() => validateBufferReceipt(receipt, inputs, overflow), /重复排期/);
});

test("different markets respect IANA daylight saving instead of a fixed offset", () => {
  assert.equal(utcForLocal("2026-10-23", "19:50", "Europe/Berlin"), "2026-10-23T17:50:00.000Z");
  assert.equal(utcForLocal("2026-10-26", "19:50", "Europe/Berlin"), "2026-10-26T18:50:00.000Z");
  assert.throws(() => utcForLocal("2026-03-08", "02:30", "America/New_York"), /不存在/);
});

test("readback CLI uses a minimal non-secret projection and rejects partial pagination", async () => {
  const { inputs, copies } = setup();
  const plan = planBufferIntake(inputs, [], copies);
  const rows = plan.writes.map((entry, i) => ({ ...entry.fields, record_id: `rec${i}` }));
  const receipt = { recordedAll: true, submittedCount: 7, scheduledCount: 5, pendingCount: 2, records: plan.writes.map((entry, i) => ({ contentItemId: entry.contentItemId, recordId: `rec${i}` })) };
  let partial = false;
  const readback = createBufferReadback({ makeTemp: async () => "/isolated", read: async () => rows.map(row => JSON.stringify(row)).join("\n"), runner: async (command, args, options) => {
    assert.equal(command, "lark-cli"); assert.equal(options.cwd, "/isolated");
    assert.ok(args.includes("--field-id")); assert.ok(!args.includes("TK密码"));
    assert.ok(args.includes("records.ndjson"));
    return { stdout: JSON.stringify({ manifest_version: "v1", has_more: partial, base_token: "base-test", table_id: "table-test", records_count: rows.length }) };
  } });
  assert.equal((await readback(receipt, inputs)).pendingCount, 2);
  partial = true;
  await assert.rejects(readback(receipt, inputs), /分页不完整/);
});

test("missing copy and conflicting reuse block before a pool write plan is returned", () => {
  const { inputs, copies } = setup();
  assert.throws(() => planBufferIntake(inputs, [], []), /文案/);
  assert.throws(() => planBufferIntake(inputs, [{ 条目标识: "F-TEST-1:v1", 视频文件URL: "https://cdn.makaron.app/replaced.mp4", 目标账号: "handle" }], copies), /不能覆盖/);
});

test("a receipt cannot pass with seven pending rows but no five-day schedule", () => {
  const { inputs, copies } = setup();
  const plan = planBufferIntake(inputs, [], copies);
  const rows = plan.writes.map((entry, i) => ({ ...entry.fields, record_id: `rec${i}`, 状态: ["待排期"], "计划发布时间(UTC)": null, "计划发布时间(当地)": null }));
  const receipt = { recordedAll: true, submittedCount: 7, scheduledCount: 0, pendingCount: 7, records: plan.writes.map((entry, i) => ({ contentItemId: entry.contentItemId, recordId: `rec${i}` })) };
  assert.throws(() => validateBufferReceipt(receipt, inputs, rows), /未排足/);
});
