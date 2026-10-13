import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateBufferReceipt } from "./buffer-intake-plan.mjs";

const run = promisify(execFile);
const FIELDS = ["条目标识", "企业名称", "视频文件URL", "目标账号", "云机ID", "国家市场", "语言", "时区", "发布文案", "状态", "计划发布时间(UTC)", "计划发布时间(当地)"];

export function createBufferReadback({ runner = run, read = readFile, makeTemp = () => mkdtemp(join(tmpdir(), "nightshift-intake-readback-")) } = {}) {
  return async (receipt, inputs) => {
    const target = inputs.bufferTarget;
    if (!target?.baseToken || !target?.tableId || !inputs.publicationTarget?.tiktokHandle) throw new Error("入池回读缺少发布池或目标账号。");
    const cwd = await makeTemp();
    const args = ["base", "+record-list", "--base-token", target.baseToken, "--table-id", target.tableId, "--as", "bot", "--filter-json", JSON.stringify({ logic: "and", conditions: [["目标账号", "==", inputs.publicationTarget.tiktokHandle]] }), ...FIELDS.flatMap(field => ["--field-id", field]), "--format", "ndjson", "--output", "records.ndjson"];
    const result = await runner("lark-cli", args, { cwd, timeout: 20000, maxBuffer: 1024 * 1024 });
    let manifest;
    try { manifest = JSON.parse(result.stdout); } catch { throw new Error("发布池回读未返回完整查询凭证。"); }
    if (manifest.manifest_version !== "v1" || manifest.has_more !== false || manifest.base_token !== target.baseToken || manifest.table_id !== target.tableId) throw new Error("发布池回读范围或分页不完整。");
    const rows = String(await read(join(cwd, "records.ndjson"), "utf8")).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
    if (rows.length !== manifest.records_count) throw new Error("发布池回读行数与凭证不一致。");
    return validateBufferReceipt(receipt, inputs, rows);
  };
}
