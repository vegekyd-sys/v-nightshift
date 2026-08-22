import { scryptSync, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function loadPublicAuth(path) {
  if (!path) return null;
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!parsed.username || !parsed.salt || !parsed.hash) {
    throw new Error("Night Shift public auth file is invalid");
  }
  return parsed;
}

export function createPublicAuth(username, password, salt) {
  if (!username || !password || !salt) throw new Error("username, password, and salt are required");
  return {
    algorithm: "scrypt-v1",
    hash: scryptSync(password, salt, 32).toString("hex"),
    salt,
    username,
  };
}

export function requiresPublicAuth(request, publicHost) {
  if (!publicHost) return false;
  const host = String(request.headers.host ?? "").split(":")[0].toLowerCase();
  return host === publicHost.toLowerCase();
}

export function verifyPublicAuth(header, auth) {
  if (!auth || typeof header !== "string" || !header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  const actualUser = Buffer.from(username);
  const expectedUser = Buffer.from(auth.username);
  if (actualUser.length !== expectedUser.length || !timingSafeEqual(actualUser, expectedUser)) return false;
  const actualHash = scryptSync(password, auth.salt, 32);
  const expectedHash = Buffer.from(auth.hash, "hex");
  return actualHash.length === expectedHash.length && timingSafeEqual(actualHash, expectedHash);
}

