import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  buildComposeArgs,
  composeVideo,
  ffmpegPath,
  mediaToolingAvailable,
  parseProbe,
  probeMedia,
} from "./media-ffmpeg";

const execFileAsync = promisify(execFile);

test("parseProbe reads dimensions, orientation, audio, and duration", () => {
  const raw = JSON.stringify({
    streams: [
      { codec_type: "video", width: 720, height: 1280 },
      { codec_type: "audio" },
    ],
    format: { duration: "5.2", format_name: "mov,mp4,m4a" },
  });
  const probe = parseProbe(raw);
  assert.equal(probe.ok, true);
  assert.equal(probe.width, 720);
  assert.equal(probe.height, 1280);
  assert.equal(probe.orientation, "portrait");
  assert.equal(probe.hasVideo, true);
  assert.equal(probe.hasAudio, true);
  assert.equal(probe.durationSec, 5.2);
});

test("parseProbe flags a silent landscape clip and unparseable output", () => {
  const silent = parseProbe(JSON.stringify({ streams: [{ codec_type: "video", width: 1920, height: 1080 }], format: { duration: "3" } }));
  assert.equal(silent.orientation, "landscape");
  assert.equal(silent.hasAudio, false);
  const broken = parseProbe("not json");
  assert.equal(broken.ok, false);
  assert.ok(broken.error);
});

test("buildComposeArgs maps 0, 1, and many audio tracks correctly", () => {
  const copy = buildComposeArgs({ videoPath: "v.mp4", outputPath: "o.mp4" });
  assert.ok(copy.includes("-c") && copy.includes("copy"));

  const one = buildComposeArgs({ videoPath: "v.mp4", audioPaths: ["a.mp3"], outputPath: "o.mp4" });
  assert.ok(one.join(" ").includes("-map 0:v:0 -map 1:a:0"));
  assert.ok(one.includes("-shortest"));

  const many = buildComposeArgs({ videoPath: "v.mp4", audioPaths: ["a.mp3", "b.mp3"], outputPath: "o.mp4" });
  assert.ok(many.join(" ").includes("amix=inputs=2"));
  assert.ok(many.join(" ").includes("[1:a][2:a]"));
});

// Real end-to-end check using the bundled binaries. Skips cleanly if the
// toolchain is not installed, so CI without ffmpeg is unaffected.
test("probe + compose work on a real generated clip", async () => {
  if (!mediaToolingAvailable()) return;
  const ffmpeg = ffmpegPath()!;
  const dir = await mkdtemp(path.join(os.tmpdir(), "gondola-ffmpeg-"));
  try {
    const silentVideo = path.join(dir, "video.mp4");
    const tone = path.join(dir, "tone.mp3");
    const composed = path.join(dir, "out.mp4");
    // A 1s 720x1280 (portrait) silent video, and a 1s tone.
    await execFileAsync(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=black:s=720x1280:d=1", "-pix_fmt", "yuv420p", silentVideo]);
    await execFileAsync(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", tone]);

    const before = await probeMedia(silentVideo);
    assert.equal(before.orientation, "portrait");
    assert.equal(before.hasAudio, false);

    const result = await composeVideo({ videoPath: silentVideo, audioPaths: [tone], outputPath: composed });
    assert.equal(result.ok, true);

    const after = await probeMedia(composed);
    assert.equal(after.hasAudio, true);
    assert.equal(after.orientation, "portrait");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
