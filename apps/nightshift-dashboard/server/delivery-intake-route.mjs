import { assertConfirmationRequestOrigin } from "./delivery-intake.mjs";

// Global public authentication runs before this route in the server.
export async function handleDeliveryIntakeRequest(request, response, url, { service, operatorIdentity, bodyJson, json }) {
  const match = url.pathname.match(/^\/api\/delivery\/([^/]+)\/intake$/u);
  if (!match || !["GET", "POST"].includes(request.method)) return false;
  const sourceId = decodeURIComponent(match[1]);
  if (request.method === "GET") {
    json(response, 200, await service.describe(sourceId));
  } else {
    assertConfirmationRequestOrigin(request);
    const actor = operatorIdentity(request, { actor: "delivery-review" });
    const result = await service.submit(sourceId, await bodyJson(request), actor);
    json(response, result.reused ? 200 : 202, result);
  }
  return true;
}
