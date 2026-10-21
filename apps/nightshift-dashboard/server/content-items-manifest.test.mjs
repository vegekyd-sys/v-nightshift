import assert from "node:assert/strict";
import test from "node:test";
import { createContentItemsManifestSync } from "./content-items-manifest.mjs";

function fixture(files) {
  const imported = [];
  const sync = createContentItemsManifestSync({
    dataDir: "/data",
    setContentItems: (id, items) => {
      if (items.some((item) => item.id.length > 27)) throw new Error(`Content item id too long: ${items[0].id}`);
      imported.push({ id, items });
    },
    readFile: async (path) => {
      if (!(path in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files[path];
    },
  });
  return { imported, sync };
}

const PATH = "/data/instances/P1/content-items.json";

test("a manifest is imported once per content", async () => {
  const files = { [PATH]: JSON.stringify({ items: [{ id: "a", title: "A" }] }) };
  const { imported, sync } = fixture(files);
  await sync({ id: "P1" });
  await sync({ id: "P1" });
  assert.equal(imported.length, 1);
  files[PATH] = JSON.stringify({ items: [{ id: "b", title: "B" }] });
  await sync({ id: "P1" });
  assert.equal(imported.length, 2);
  await sync({ id: "P2" });
  assert.equal(imported.length, 2, "a project without a manifest has nothing to import");
});

test("a broken manifest is retried every pass but its failure is reported once", async () => {
  const files = { [PATH]: JSON.stringify({ rows: [{ id: "a" }] }) };
  const { imported, sync } = fixture(files);
  const first = await sync({ id: "P1" }).catch((error) => error);
  assert.match(first.message, /no contentItems or items array; it holds rows\(1\)/);
  assert.equal(first.reported, undefined, "the first failure is new");
  const again = await sync({ id: "P1" }).catch((error) => error);
  assert.equal(again.message, first.message);
  assert.equal(again.reported, true, "the same manifest failing the same way was already reported");
  files[PATH] = JSON.stringify({ items: [{ id: "x".repeat(32), title: "X" }] });
  const changed = await sync({ id: "P1" }).catch((error) => error);
  assert.equal(changed.reported, undefined, "a changed manifest that fails differently is reported");
  files[PATH] = JSON.stringify({ items: [{ id: "ok", title: "OK" }] });
  await sync({ id: "P1" });
  assert.equal(imported.length, 1, "a fixed manifest is imported");
});
