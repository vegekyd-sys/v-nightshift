import { createHash } from "node:crypto";
import { canonicalJson, reviewContext, selectReviewItems } from "../delivery/review.js";
import { trustedUrl } from "../delivery/manifest.js";
import { demandWindow } from "./buffer-intake-plan.mjs";

export const INTAKE_WORKFLOW_ID = "xingqing-buffer-intake-f";
export const intakeProjectId = sourceId => `BI-${digest(sourceId).slice(0, 24)}`;
const digest = value => createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };

// Reuse a native Night Shift project as the durable confirmation/task record.
// There is no parallel queue or card store, and no new SQLite schema.
export class DeliveryIntakeService {
  constructor({ store, loadSource, createTask, enqueue, resumeTask = async task => task, readResult = async () => null, projectLinks, now = () => new Date() }) {
    Object.assign(this, { store, loadSource, createTask, enqueue, resumeTask, readResult, projectLinks, now });
    this.pending = new Map();
  }

  async batch(sourceId) {
    if (!/^F-[A-Za-z0-9._-]{1,28}$/u.test(sourceId)) fail(404, "测试批次不存在。");
    const data = await this.loadSource(sourceId);
    if (!data?.source || data.sourceRelease?.metadata?.id !== "xingqing-night-f") fail(404, "此批次未启用测试入池。");
    if (data.source.status !== "done" || data.page?.published !== true) fail(409, "批次尚未完成交付，暂时不能入池。");
    let context;
    try { context = reviewContext(data.manifest); } catch (error) { fail(409, error.message); }
    if (!context || context.batchId !== sourceId) fail(409, "这份交付尚未启用验收确认。");
    const manifestUrl = trustedUrl(data.page.manifest);
    if (!manifestUrl || manifestUrl.username || manifestUrl.password || manifestUrl.port) fail(409, "批次清单链接无效。");
    const known = new Set(data.contentItems.map(item => item.id));
    if (context.items.some(item => !known.has(item.id))) fail(409, "交付视频与制作条目对不上。");
    const target = data.source.inputs?.publicationTarget;
    const scope = data.source.inputs?.testScope;
    if (!target?.accountRecordId || !target?.geelarkDeviceId || !target?.tiktokHandle || !target?.market || !target?.language || !target?.timezone || scope?.accountRecordId !== target.accountRecordId) fail(409, "批次缺少已核实的发布账号。");
    try { new Intl.DateTimeFormat("en", { timeZone: target.timezone }); } catch { fail(409, "发布时区无效。"); }
    if (!Number.isInteger(scope?.productionCount) || scope.productionCount < 1 || scope.productionCount > 30 || scope?.publishCount !== 5 || scope?.reserveCount !== scope.productionCount - 5 || scope?.workdays !== 5 || data.source.inputs.targetCount !== scope.productionCount || context.items.length > scope.productionCount) fail(409, "批次数量与已确认的制作及排期需求不符。");
    return { ...data, context, manifestUrl: manifestUrl.toString(), manifestHash: digest(data.manifest) };
  }

  async describe(sourceId) {
    const data = await this.batch(sourceId);
    const task = this.store.getInstance(intakeProjectId(sourceId));
    return this.response(data, task, true);
  }

  submit(sourceId, body, actor) {
    const previous = this.pending.get(sourceId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.confirm(sourceId, body, actor));
    this.pending.set(sourceId, operation);
    operation.then(() => this.clear(sourceId, operation), () => this.clear(sourceId, operation));
    return operation;
  }

  clear(id, operation) { if (this.pending.get(id) === operation) this.pending.delete(id); }

  async confirm(sourceId, body, actor) {
    if (typeof actor !== "string" || !actor.trim()) fail(403, "请先登录夜班后再确认。");
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["manifestUrl", "manifestHash", "rejectedIds"].includes(key))) fail(400, "确认请求格式不对。");
    const data = await this.batch(sourceId);
    if (body.manifestHash !== data.manifestHash || body.manifestUrl !== data.manifestUrl) fail(409, "交付清单已更新，请刷新后重新验收。");
    let selection;
    try { selection = selectReviewItems(data.manifest.items, body.rejectedIds); } catch (error) { fail(400, error.message); }
    if (selection.accepted.length === 0) fail(422, "没有通过的视频，不会创建入池任务。");
    const selectionHash = digest({ manifestHash: data.manifestHash, rejected: selection.rejected.map(item => item.id) });
    const id = intakeProjectId(sourceId);
    let task = this.store.getInstance(id);
    if (task) {
      if (task.inputs?.reviewConfirmation?.selectionHash !== selectionHash) fail(409, "这个批次已确认，不能更换已提交的视频集合。");
      const previousStatus = task.status;
      task = await this.resumeTask(task);
      if (previousStatus === "paused" && task.status === "active") this.enqueue(task.id);
      return this.response(data, task, true);
    }
    const release = this.store.listReleases().find(entry => entry.workflowId === INTAKE_WORKFLOW_ID);
    if (!release) fail(409, "入池任务流程尚未就绪，未写入发布池。");
    const source = data.source;
    const request = {
      id, name: `入池排期 · ${source.inputs.enterpriseName} · ${selection.accepted.length}条`,
      workflowSha256: release.workflowSha256, status: "active",
      agentBindings: source.agentBindings, collaboration: source.collaboration,
      inputs: {
        sourceProjectId: sourceId, sourceWorkflowSha256: source.workflowSha256,
        enterpriseName: source.inputs.enterpriseName, planningDocUrl: source.inputs.planningDocUrl,
        publicationTarget: structuredClone(source.inputs.publicationTarget), testScope: { ...structuredClone(source.inputs.testScope), ...demandWindow(this.now(), source.inputs.publicationTarget.timezone), scheduleLocalTime: source.inputs.testScope.scheduleLocalTime ?? "19:50" },
        sourceInstanceDir: data.instanceDir ?? null,
        bufferTarget: { baseToken: "MOYqbvbt5amKPesStYEcRIrxnTb", tableId: "tblwJhquHsqNWHKn" },
        acceptedItems: selection.accepted.map(item => ({ id: item.id, title: item.title, url: item.url, fileName: item.fileName ?? null, bytes: item.bytes ?? null, durationSec: item.durationSec ?? null })),
        rejectedItemIds: selection.rejected.map(item => item.id),
        reviewConfirmation: { sourceProjectId: sourceId, manifestHash: data.manifestHash, manifestUrl: data.manifestUrl, selectionHash, confirmedBy: actor, confirmedAt: this.now().toISOString(), confirmed: true },
        authorizationScope: { paidProduction: false, externalPublication: false },
      },
    };
    try { task = await this.createTask(request); } catch (error) {
      // A second server process may win the database's unique project-id insert.
      const saved = this.store.getInstance(id);
      if (!saved || saved.inputs?.reviewConfirmation?.selectionHash !== selectionHash) throw error;
      task = await this.resumeTask(saved);
    }
    this.enqueue(task.id);
    return this.response(data, task, false);
  }

  async response(data, task, reused) {
    let result = null;
    if (task?.status === "done") {
      result = await this.readResult(task.id);
      if (!result?.recordedAll || result?.submittedCount !== task.inputs.acceptedItems.length) fail(409, "任务已结束但结果凭证不完整，尚不能确认入池成功。");
    }
    return {
      batch: {
        id: data.source.id, title: data.manifest.title, enterpriseName: data.source.inputs.enterpriseName,
        market: data.source.inputs.publicationTarget.market, language: data.source.inputs.publicationTarget.language,
        publishCount: data.source.inputs.testScope.publishCount, manifestHash: data.manifestHash,
        itemIds: data.context.items.map(item => item.id),
        omittedItems: data.contentItems.filter(item => !data.context.items.some(entry => entry.id === item.id)).map(item => ({ id: item.id, title: item.title, reason: "未进入交付清单" })),
      },
      task: task ? {
        id: task.id, status: task.status, progressStatus: this.store.listStageRuns?.(task.id)?.at(-1)?.status ?? task.status, links: this.projectLinks(task.id), result,
        acceptedIds: task.inputs.acceptedItems.map(item => item.id), rejectedIds: task.inputs.rejectedItemIds,
        confirmedAt: task.inputs.reviewConfirmation.confirmedAt, manifestHash: task.inputs.reviewConfirmation.manifestHash,
      } : null,
      reused,
    };
  }
}

export function assertConfirmationRequestOrigin(request) {
  const origin = request.headers.origin;
  if (origin) {
    let url;
    try { url = new URL(origin); } catch { fail(403, "确认来源无效。"); }
    if (!["http:", "https:"].includes(url.protocol) || url.host !== request.headers.host) fail(403, "请在原交付页确认。");
  } else if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)) fail(403, "请在原交付页确认。");
  if (request.headers["sec-fetch-site"] && !["same-origin", "none"].includes(request.headers["sec-fetch-site"])) fail(403, "请在原交付页确认。");
  if (!/^application\/json(?:;|$)/iu.test(request.headers["content-type"] ?? "")) fail(415, "确认请求必须是JSON。");
}
