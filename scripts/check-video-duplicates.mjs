#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const input = args.find((entry) => !entry.startsWith("--"));
if (!input || args.includes("--help")) {
  console.error("Usage: check-video-duplicates.mjs <video> [--out report.json] [--threshold 0.985] [--max-ratio 0.25] [--fps 2]");
  process.exit(args.includes("--help") ? 0 : 2);
} else {
  const fps = positive(option("--fps") ?? 2, "--fps");
  const threshold = range(option("--threshold") ?? 0.985, "--threshold");
  const maxDuplicateRatio = range(option("--max-ratio") ?? 0.25, "--max-ratio");
  const report = analyze(resolve(input), { fps, maxDuplicateRatio, threshold });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const output = option("--out");
  if (output) await writeFile(resolve(output), serialized, "utf8");
  process.stdout.write(serialized);
  if (report.status !== "passed") process.exitCode = 1;
}

function analyze(path, { fps, maxDuplicateRatio, threshold }) {
  const width = 32;
  const height = 18;
  const frameSize = width * height;
  const ffmpeg = spawnSync("ffmpeg", [
    "-v", "error", "-i", path,
    "-vf", `fps=${fps},scale=${width}:${height}:flags=area,format=gray`,
    "-f", "rawvideo", "pipe:1",
  ], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (ffmpeg.status !== 0) {
    throw new Error(`ffmpeg duplicate sampling failed: ${String(ffmpeg.stderr ?? "").trim().slice(0, 1000)}`);
  }
  const bytes = ffmpeg.stdout ?? Buffer.alloc(0);
  const frameCount = Math.floor(bytes.length / frameSize);
  if (frameCount < Math.max(4, Math.ceil(fps * 2))) throw new Error("Video is too short for temporal duplicate analysis");
  const frames = [];
  for (let offset = 0; offset + frameSize <= bytes.length; offset += frameSize) {
    frames.push(bytes.subarray(offset, offset + frameSize));
  }
  const windowFrames = Math.max(2, Math.round(fps * 2));
  const minGapFrames = Math.max(windowFrames, Math.round(fps * 3));
  const matches = [];
  const duplicated = new Set();
  let comparedPairs = 0;
  for (let left = 0; left + windowFrames <= frames.length; left += 1) {
    for (let right = left + minGapFrames; right + windowFrames <= frames.length; right += 1) {
      comparedPairs += 1;
      let similarity = 0;
      for (let index = 0; index < windowFrames; index += 1) {
        similarity += frameSimilarity(frames[left + index], frames[right + index]);
      }
      similarity /= windowFrames;
      if (similarity < threshold) continue;
      for (let index = 0; index < windowFrames; index += 1) duplicated.add(right + index);
      matches.push({
        firstStartSec: round(left / fps),
        repeatedStartSec: round(right / fps),
        similarity: round(similarity, 4),
      });
    }
  }
  matches.sort((a, b) => b.similarity - a.similarity || a.repeatedStartSec - b.repeatedStartSec);
  const duplicateRatio = duplicated.size / frames.length;
  return {
    version: 1,
    status: duplicateRatio <= maxDuplicateRatio ? "passed" : "failed",
    method: "temporal-luma-window-v1",
    input: path,
    fps,
    durationSeconds: round(frames.length / fps),
    frameCount: frames.length,
    windowSeconds: round(windowFrames / fps),
    threshold,
    maxDuplicateRatio,
    duplicateRatio: round(duplicateRatio, 4),
    comparedPairs,
    matchedWindows: matches.length,
    topMatches: matches.slice(0, 20),
  };
}

function frameSimilarity(left, right) {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs(left[index] - right[index]);
  }
  return 1 - difference / (left.length * 255);
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be positive`);
  return number;
}

function range(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error(`${name} must be between 0 and 1`);
  return number;
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}
