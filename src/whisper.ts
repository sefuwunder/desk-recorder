// desk-recorder: server-side offline transcription via whisper.cpp.
// Native binary, CPU, fully local. Zero npm deps.
import { join, basename } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";

export interface WhisperPaths {
  bin: string;
  model: string;
  modelName: string;
}

/** Resolve binary + model locations. Env overrides (read per call, so tests
 *  can point at fakes): WHISPER_BIN, WHISPER_MODEL (file name under
 *  data/whisper/), WHISPER_MODEL_PATH (absolute). */
export function whisperPaths(dataDir: string): WhisperPaths {
  const bin = process.env.WHISPER_BIN || join(dataDir, "whisper", "whisper-cli");
  const modelPathEnv = process.env.WHISPER_MODEL_PATH;
  const modelName =
    process.env.WHISPER_MODEL || (modelPathEnv ? basename(modelPathEnv) : "ggml-base.en.bin");
  const model = modelPathEnv || join(dataDir, "whisper", modelName);
  return { bin, model, modelName };
}

/** True when the binary exists and is executable and the model file exists. */
export function isAvailable(dataDir: string): boolean {
  const { bin, model } = whisperPaths(dataDir);
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    return false;
  }
  return existsSync(model);
}

/** Public status for GET /api/transcribe/status. Never exposes paths. */
export function getTranscribeStatus(dataDir: string): {
  available: boolean;
  model: string;
  binary: string;
} {
  const { bin, modelName } = whisperPaths(dataDir);
  return {
    available: isAvailable(dataDir),
    model: modelName,
    binary: basename(bin) || "whisper-cli",
  };
}

/** Validate a WAV header (RIFF....WAVE). buf needs only the first 12+ bytes. */
export function isValidWav(buf: Uint8Array): boolean {
  return (
    buf.length >= 12 &&
    buf[0] === 0x52 && // R
    buf[1] === 0x49 && // I
    buf[2] === 0x46 && // F
    buf[3] === 0x46 && // F
    buf[8] === 0x57 && // W
    buf[9] === 0x41 && // A
    buf[10] === 0x56 && // V
    buf[11] === 0x45 // E
  );
}

/**
 * Transcribe a 16kHz mono WAV file. Returns the trimmed transcript text.
 * Throws on missing engine, non-zero exit, or timeout. Never logs audio.
 */
export async function transcribeFile(
  dataDir: string,
  wavPath: string,
  timeoutMs = 10 * 60 * 1000
): Promise<string> {
  const { bin, model } = whisperPaths(dataDir);
  if (!isAvailable(dataDir)) {
    throw new Error("transcription engine not available");
  }
  const tmpDir = mkdtempSync(join(tmpdir(), "whisper-"));
  const outBase = join(tmpDir, "out");
  // NOTE: env is passed explicitly — Bun.spawn does not pick up
  // runtime mutations of process.env on its own.
  const proc = Bun.spawn(
    [bin, "-m", model, "-f", wavPath, "--output-txt", "-of", outBase, "--no-prints", "-t", "4"],
    { stdout: "ignore", stderr: "ignore", env: { ...process.env } }
  );
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }, timeoutMs);
  try {
    const code = await proc.exited;
    if (timedOut) throw new Error("transcription timed out");
    if (code !== 0) throw new Error(`whisper exited with code ${code}`);
    let text: string;
    try {
      text = readFileSync(outBase + ".txt", "utf8").trim();
    } catch {
      throw new Error("whisper produced no transcript output");
    }
    return text;
  } finally {
    clearTimeout(killer);
    try {
      proc.kill();
    } catch {
      /* noop */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
