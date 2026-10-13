import assert from "node:assert/strict";
import test from "node:test";
import { createIntakeMediaChecker } from "./intake-media.mjs";

const inputs = { acceptedItems: [{ id: "v1", url: "https://cdn.makaron.app/one.mp4" }] };
test("media dimensions come from ffprobe, never from a filename or manifest claim", async () => {
  const check = createIntakeMediaChecker({ runner: async (command, args) => {
    assert.equal(command, "ffprobe"); assert.equal(args.at(-1), inputs.acceptedItems[0].url);
    return { stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920 }], format: { duration: "23.5" } }) };
  } });
  assert.deepEqual(await check(inputs), [{ contentItemId: "v1", width: 1080, height: 1920, durationSeconds: 23.5 }]);
});
test("720p, 4K, unreadable, still-image and reused video objects stop before a write plan", async () => {
  for (const probe of [{ streams: [{ width: 720, height: 1280 }], format: { duration: "20" } }, { streams: [{ width: 2160, height: 3840 }], format: { duration: "20" } }, { streams: [{ width: 1080, height: 1920 }], format: {} }]) {
    await assert.rejects(createIntakeMediaChecker({ runner: async () => ({ stdout: JSON.stringify(probe) }) })(inputs), /不入池/);
  }
  await assert.rejects(createIntakeMediaChecker({ runner: async () => { throw new Error("network down"); } })(inputs), /无法实测/);
  const repeated = { acceptedItems: [inputs.acceptedItems[0], { id: "v2", url: "https://cdn.makaron.app/one.mp4?cache=2" }] };
  await assert.rejects(createIntakeMediaChecker({ runner: async () => ({ stdout: '{"streams":[{"width":1080,"height":1920}],"format":{"duration":"20"}}' }) })(repeated), /重复/);
});
test("rotation metadata is evaluated as the displayed portrait dimensions", async () => {
  const check = createIntakeMediaChecker({ runner: async () => ({ stdout: '{"streams":[{"width":1920,"height":1080,"side_data_list":[{"rotation":90}]}],"format":{"duration":"12"}}' }) });
  assert.equal((await check(inputs))[0].height, 1920);
});
