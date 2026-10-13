import { trustedUrl } from "../delivery/manifest.js";

export function localDateAt(instant, timezone) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}
export function addDays(date, count) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("排期日期无效。");
  return new Date(Date.parse(`${date}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
}
export function demandWindow(now, timezone) {
  // Start tomorrow so a batch confirmed after the daily scan is not stranded
  // in today's already-scanned window. Seven calendar days contain five weekdays.
  const periodStartLocalDate = addDays(localDateAt(now, timezone), 1);
  return { periodStartLocalDate, periodEndLocalDate: addDays(periodStartLocalDate, 6) };
}
export function localMinuteAt(instant, timezone) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant));
}
export function utcForLocal(date, time, timezone) {
  if (!/^\d{2}:\d{2}$/u.test(time)) throw new Error("发布时段无效。");
  const desired = `${date} ${time}`;
  let instant = Date.parse(`${date}T${time}:00Z`);
  for (let i = 0; i < 4; i++) {
    const current = localMinuteAt(instant, timezone);
    if (current === desired) return new Date(instant).toISOString();
    instant += Date.parse(`${desired.replace(" ", "T")}:00Z`) - Date.parse(`${current.replace(" ", "T")}:00Z`);
  }
  throw new Error("这个当地时段不存在，请检查排期规则。");
}

const value = (row, field) => Array.isArray(row[field]) ? row[field][0] : row[field];
const occupiedState = status => ["已排期", "发布中", "已发布"].includes(status);
const goodUrl = text => { const url = trustedUrl(text); return url && !url.username && !url.password && !url.port; };
const inWindow = (date, scope) => date >= scope.periodStartLocalDate && date <= scope.periodEndLocalDate;

export function planBufferIntake(input, rows, copies = []) {
  const inputs = input.inputs ?? input;
  const { publicationTarget: target, testScope: scope } = inputs;
  if (!target || !scope?.periodStartLocalDate || scope.periodEndLocalDate !== addDays(scope.periodStartLocalDate, 6) || scope.publishCount !== 5 || scope.workdays !== 5 || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(scope.scheduleLocalTime ?? "")) throw new Error("缺少已确认的排期周期或时段。");
  const accepted = inputs.acceptedItems;
  if (!Array.isArray(accepted) || !accepted.length || new Set(accepted.map(item => item.id)).size !== accepted.length) throw new Error("确认视频集合无效。");
  const sameAccount = row => value(row, "目标账号") === target.tiktokHandle;
  const accountRows = rows.filter(sameAccount);
  const days = new Set();
  const occupied = [];
  for (const row of accountRows.filter(row => occupiedState(value(row, "状态")))) {
    const instant = value(row, "计划发布时间(UTC)");
    if (!Number.isFinite(Date.parse(instant))) throw new Error("账号有一条排期时间不可读，不能安全补位。");
    const date = localDateAt(instant, target.timezone);
    if (!inWindow(date, scope)) continue;
    if (days.has(date)) throw new Error("账号已有同日重复排期，请先核实原排期。");
    days.add(date); occupied.push(row);
  }
  const slots = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(scope.periodStartLocalDate, i);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !days.has(date)) slots.push({ local: `${date}T${scope.scheduleLocalTime}:00`, utc: utcForLocal(date, scope.scheduleLocalTime, target.timezone) });
  }
  let remaining = Math.max(0, scope.publishCount - occupied.length);
  const copyById = new Map((Array.isArray(copies) ? copies : copies.items ?? []).map(copy => [copy.id ?? copy.contentItemId, copy]));
  const existingKeys = new Map();
  for (const row of rows) {
    const key = value(row, "条目标识");
    if (!key) continue;
    if (existingKeys.has(key)) throw new Error("发布池有重复条目标识，不能静默重复写入。");
    existingKeys.set(key, row);
  }
  const unchanged = [];
  const pending = [];
  for (const row of accountRows) {
    if (value(row, "状态") !== "待排期" || value(row, "企业名称") !== inputs.enterpriseName || value(row, "国家市场") !== target.market || value(row, "语言") !== target.language) continue;
    if (!goodUrl(value(row, "视频文件URL")) || !value(row, "发布文案") || value(row, "云机ID") !== target.geelarkDeviceId || value(row, "时区") !== target.timezone) continue;
    pending.push({ recordId: row.record_id, key: value(row, "条目标识"), fields: { ...row }, old: true, uploadedAt: value(row, "上传时间") ?? "" });
  }
  const currentKeys = new Set();
  for (const item of accepted) {
    const key = `${inputs.sourceProjectId}:${item.id}`;
    currentKeys.add(key);
    if (!goodUrl(item.url)) throw new Error("确认视频链接不受发布流程支持。");
    const row = existingKeys.get(key);
    if (row) {
      if (value(row, "视频文件URL") !== item.url || value(row, "目标账号") !== target.tiktokHandle || value(row, "云机ID") !== target.geelarkDeviceId || value(row, "企业名称") !== inputs.enterpriseName) throw new Error("已入池条目与确认版本或账号不符，不能覆盖。");
      unchanged.push({ contentItemId: item.id, recordId: row.record_id, status: value(row, "状态") });
      continue;
    }
    const copy = copyById.get(item.id);
    if (copy?.qc?.status !== "passed" || typeof copy.videoDesc !== "string" || !copy.videoDesc.trim()) throw new Error(`视频 ${item.id} 缺少通过自检的发布文案。`);
    pending.push({ old: false, contentItemId: item.id, key, fields: {
      "条目标识": key, "企业名称": inputs.enterpriseName, "素材批次": inputs.sourceProjectId,
      "视频文件URL": item.url, "目标账号": target.tiktokHandle, "云机ID": target.geelarkDeviceId,
      "国家市场": target.market, "语言": target.language, "时区": target.timezone,
      "发布文案": copy.videoDesc.trim(), "发布节奏": "工作日-1条", "状态": ["待排期"],
    } });
  }
  // Current-batch rows already in the pool are also eligible pending inventory.
  pending.sort((a, b) => Number(b.old) - Number(a.old) || String(a.uploadedAt).localeCompare(String(b.uploadedAt)) || String(a.key).localeCompare(String(b.key)));
  const writes = [];
  for (const entry of pending) {
    const slot = remaining > 0 ? slots.shift() : null;
    if (slot) {
      remaining--;
      writes.push({ ...entry, fields: { ...(entry.old ? {} : entry.fields), "状态": ["已排期"], "计划发布时间(UTC)": slot.utc, "计划发布时间(当地)": slot.local } });
    } else if (!entry.old) writes.push({ ...entry, pendingReason: "本周期发布额度已满", fields: entry.fields });
  }
  return { version: 1, sourceProjectId: inputs.sourceProjectId, periodStartLocalDate: scope.periodStartLocalDate, periodEndLocalDate: scope.periodEndLocalDate, occupiedCount: occupied.length, writes, unchanged, currentKeys: [...currentKeys] };
}

export function validateBufferReceipt(receipt, inputs, rows) {
  if (!receipt || receipt.recordedAll !== true || receipt.submittedCount !== inputs.acceptedItems.length || !Array.isArray(receipt.records) || receipt.records.length !== inputs.acceptedItems.length) throw new Error("入池结果凭证不完整。");
  const target = inputs.publicationTarget, scope = inputs.testScope;
  const accepted = new Map(inputs.acceptedItems.map(item => [item.id, item]));
  const seen = new Set();
  let scheduledCount = 0, pendingCount = 0;
  const records = receipt.records.map(record => {
    const item = accepted.get(record.contentItemId);
    const row = rows.find(entry => entry.record_id === record.recordId);
    if (!item || seen.has(item.id) || !row) throw new Error("入池条目缺失、重复或无法回读。");
    seen.add(item.id);
    const expected = { "条目标识": `${inputs.sourceProjectId}:${item.id}`, "企业名称": inputs.enterpriseName, "视频文件URL": item.url, "目标账号": target.tiktokHandle, "云机ID": target.geelarkDeviceId, "国家市场": target.market, "语言": target.language, "时区": target.timezone };
    for (const [field, text] of Object.entries(expected)) if (value(row, field) !== text) throw new Error(`入池回读不一致：${field}`);
    if (!String(value(row, "发布文案") ?? "").trim()) throw new Error("入池回读缺少发布文案。");
    const state = value(row, "状态");
    if (occupiedState(state)) {
      const instant = value(row, "计划发布时间(UTC)");
      if (!Number.isFinite(Date.parse(instant)) || !inWindow(localDateAt(instant, target.timezone), scope)) throw new Error("计划时间不在已确认需求周期。");
      const weekday = new Date(`${localDateAt(instant, target.timezone)}T12:00:00Z`).getUTCDay();
      if (weekday === 0 || weekday === 6) throw new Error("本批排期必须在工作日。");
      const local = String(value(row, "计划发布时间(当地)") ?? "").slice(0, 16).replace("T", " ");
      if (local !== localMinuteAt(instant, target.timezone)) throw new Error("当地时间和UTC排期不一致。");
      scheduledCount++;
    } else if (state === "待排期") {
      if (value(row, "计划发布时间(UTC)") || value(row, "计划发布时间(当地)")) throw new Error("待排期条目不能带有有效发布时间。");
      pendingCount++;
    } else throw new Error("入池状态尚不满足发布消费者要求。");
    return { contentItemId: item.id, recordId: row.record_id, status: state, plannedAtLocal: value(row, "计划发布时间(当地)") ?? null };
  });
  const slots = new Set();
  let occupied = 0;
  for (const row of rows.filter(row => value(row, "目标账号") === target.tiktokHandle && occupiedState(value(row, "状态")))) {
    const instant = value(row, "计划发布时间(UTC)");
    if (!Number.isFinite(Date.parse(instant))) throw new Error("账号已有排期时间无效。");
    const date = localDateAt(instant, target.timezone);
    if (!inWindow(date, scope)) continue;
    if (slots.has(date)) throw new Error("同一账号同日出现重复排期。");
    slots.add(date); occupied++;
  }
  if (inputs.acceptedItems.length >= scope.publishCount && occupied < scope.publishCount) throw new Error("视频已入池但本周期未排足5个发布计划。");
  if (occupied > scope.publishCount || receipt.scheduledCount !== scheduledCount || receipt.pendingCount !== pendingCount) throw new Error("排期超出需求额度或数量账对不上。");
  return { submittedCount: records.length, scheduledCount, pendingCount, recordedAll: true, records };
}
