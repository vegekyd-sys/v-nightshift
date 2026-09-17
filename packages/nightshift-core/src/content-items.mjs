// Night Shift writes `content-item:<id>` as a card label, and the Gateway
// refuses a label longer than its budget. Without this check a long id is
// accepted here and then makes every card creation fail, leaving the project
// silently undispatchable; that happened to NS-VIG-0917-01 on 2026-09-17.
//
// The Gateway's 40 is one input check with nothing downstream depending on it,
// and the sibling helper in that same file allows 80. So the budget is a knob:
// when the Gateway raises its limit, a drop-in here accepts longer ids without
// a Night Shift release.
const CONTENT_ITEM_LABEL_PREFIX = "content-item:";
export const CARD_LABEL_MAX = labelBudget(process.env.NIGHTSHIFT_CARD_LABEL_MAX);

function labelBudget(value) {
  if (value === undefined || value === null || value === "") return 40;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 20 && parsed <= 200 ? parsed : 40;
}
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const STATUS_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function normalizeContentItems(items, { maxItems = 50, routes = [], labelMax = CARD_LABEL_MAX } = {}) {
  const idMax = labelMax - CONTENT_ITEM_LABEL_PREFIX.length;
  const allowedRoutes = new Set(routes);
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("contentItems must contain at least one video task");
  }
  if (items.length > maxItems) {
    throw new Error(`contentItems exceeds the configured maximum of ${maxItems}`);
  }
  const ids = new Set();
  return items.map((item, ordinal) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`contentItems[${ordinal}] must be an object`);
    }
    const id = String(item.id ?? "").trim();
    if (!ID_PATTERN.test(id)) throw new Error(`Invalid content item id: ${id || "<empty>"}`);
    if (id.length > idMax) {
      throw new Error(`Content item id must be ${idMax} characters or fewer so its Workboard label fits within ${labelMax}: ${id} (${id.length})`);
    }
    if (ids.has(id)) throw new Error(`Duplicate content item id: ${id}`);
    ids.add(id);
    const title = String(item.title ?? "").trim();
    if (!title) throw new Error(`contentItems[${ordinal}].title is required`);
    const route = item.route == null ? null : String(item.route);
    if (route != null && allowedRoutes.size > 0 && !allowedRoutes.has(route)) {
      throw new Error(`Unsupported content route ${route}`);
    }
    const status = String(item.status ?? (route ? "planned" : "routing"));
    if (!STATUS_PATTERN.test(status)) throw new Error(`Invalid content item status ${status}`);
    return { ...item, id, title, route, status, ordinal };
  });
}

export function contentItemRouteAllowed(route, routes = []) {
  return new Set(routes).has(route);
}
