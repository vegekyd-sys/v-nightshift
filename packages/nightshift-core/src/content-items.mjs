// A card label is at most 40 characters and Night Shift writes
// `content-item:<id>`, so an id has 27 to spend. Project ids are already capped
// the same way. Without this a 28-character id is accepted here and then makes
// every card creation fail, leaving the project silently undispatchable; that
// happened to NS-VIG-0917-01 on 2026-09-17.
const CONTENT_ITEM_LABEL_PREFIX = "content-item:";
const CONTENT_ITEM_ID_MAX = 40 - CONTENT_ITEM_LABEL_PREFIX.length;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const STATUS_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function normalizeContentItems(items, { maxItems = 50, routes = [] } = {}) {
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
    if (id.length > CONTENT_ITEM_ID_MAX) {
      throw new Error(`Content item id must be ${CONTENT_ITEM_ID_MAX} characters or fewer so its Workboard label fits: ${id} (${id.length})`);
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
