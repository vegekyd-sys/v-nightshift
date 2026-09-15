#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createPublicAuth } from "../apps/nightshift-dashboard/server/public-auth.mjs";

const [outputArg, username = "versa"] = process.argv.slice(2);
const password = process.env.NIGHTSHIFT_NEW_PASSWORD;
if (!outputArg || !password) {
  console.error("Usage: NIGHTSHIFT_NEW_PASSWORD=<secret> create-nightshift-auth.mjs <output.json> [username]");
  process.exit(2);
}

const output = resolve(outputArg);
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await writeFile(output, `${JSON.stringify(createPublicAuth(username, password, randomBytes(16).toString("hex")), null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ok: true, output, username }));

