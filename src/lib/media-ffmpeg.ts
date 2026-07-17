import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

// Local media toolchain: deterministic verification (ffprobe) and composition
// (ffmpeg mux) of produced files. It uses the bundled static binaries so it
// needs no system install, and it degrades cleanly when they are absent. This
// is what turns "Verification" into code (does the file open? is it vertical?
// does it have audio? how long is it?) and enables narration + music + video to
// be muxed into one deliverable.

const execFileAsync = promisify(execFile);

export function ffmpegPath(): string | null {
  return process.env.GONDOLA_FFMPEG?.trim() || (ffmpegStatic as string | null) || null;
}

export function ffprobePath(): string | null {
  return process.env.GONDOLA_FFPROBE?.trim() || (ffprobeStatic as { path?: string } | undefined)?.path || null;
}

export function mediaToolingAvailable(): boolean {
  return Boolean(ffmpegPath() && ffprobePath());
}

export type Orientation = "portrait" | "landscape" | "square";

export interface MediaProbe {
  ok: boolean;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  orientation: Orientation | null;
  format: string | null;
  error?: string;
}

const EMPTY_PROBE: MediaProbe = {
  ok: false, width: null, height: null, durationSec: null,
  hasVideo: false, hasAudio: false, orientation: null, format: null,
};

function orientationOf(width: number | null, height: number | null): Orientation | null {
  if (!width || !height) return null;
  if (height > width) return "portrait";
  if (width > height) return "landscape";
  return "square";
}

/** Pure parse of `ffprobe -print_format json -show_format -show_streams` output. */
export function parseProbe(raw: string): MediaProbe {
  let parsed: {
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    format?: { duration?: string; format_name?: string };
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_PROBE, error: "ffprobe returned unparseable output" };
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const hasAudio = streams.some((stream) => stream.codec_type === "audio");
  const width = typeof video?.width === "number" ? video.width : null;
  const height = typeof video?.height === "number" ? video.height : null;
  const durationRaw = parsed.format?.duration;
  const durationSec = durationRaw !== undefined && Number.isFinite(Number(durationRaw)) ? Number(durationRaw) : null;
  return {
    ok: true,
    width,
    height,
    durationSec,
    hasVideo: Boolean(video),
    hasAudio,
    orientation: orientationOf(width, height),
    format: parsed.format?.format_name ?? null,
  };
}

export type CommandRunner = (bin: string, args: string[]) => Promise<string>;

const defaultRunner: CommandRunner = async (bin, args) => {
  const { stdout } = await execFileAsync(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  return stdout;
};

/** Probe a media file for its real, deterministic properties. Never throws. */
export async function probeMedia(filePath: string, run: CommandRunner = defaultRunner): Promise<MediaProbe> {
  const bin = ffprobePath();
  if (!bin) return { ...EMPTY_PROBE, error: "ffprobe is not available (install ffmpeg or the ffprobe-static package)" };
  try {
    const raw = await run(bin, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath]);
    return parseProbe(raw);
  } catch (error) {
    return { ...EMPTY_PROBE, error: error instanceof Error ? error.message : "ffprobe failed" };
  }
}

export interface ComposeInput {
  videoPath: string;
  /** Audio tracks to lay over the video (e.g. narration, music). Mixed if >1. */
  audioPaths?: string[];
  outputPath: string;
}

/** Pure: the ffmpeg argument list to mux a video with 0..N audio tracks. */
export function buildComposeArgs(input: ComposeInput): string[] {
  const audio = input.audioPaths ?? [];
  const args = ["-y", "-i", input.videoPath];
  for (const track of audio) args.push("-i", track);
  if (audio.length === 0) {
    args.push("-c", "copy", input.outputPath);
    return args;
  }
  if (audio.length === 1) {
    args.push("-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-shortest", input.outputPath);
    return args;
  }
  const labels = audio.map((_, index) => `[${index + 1}:a]`).join("");
  args.push(
    "-filter_complex", `${labels}amix=inputs=${audio.length}:duration=longest[aout]`,
    "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-shortest", input.outputPath,
  );
  return args;
}

export interface ComposeResult {
  ok: boolean;
  outputPath?: string;
  error?: string;
}

/** Mux a video with narration and/or music into one file. Never throws. */
export async function composeVideo(input: ComposeInput, run: CommandRunner = defaultRunner): Promise<ComposeResult> {
  const bin = ffmpegPath();
  if (!bin) return { ok: false, error: "ffmpeg is not available (install ffmpeg or the ffmpeg-static package)" };
  try {
    await run(bin, buildComposeArgs(input));
    return { ok: true, outputPath: input.outputPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "ffmpeg compose failed" };
  }
}
