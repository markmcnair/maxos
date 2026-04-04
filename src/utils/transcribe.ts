import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

// Whisper model to use — "base" is fast and good enough for voice messages
const WHISPER_MODEL = process.env.WHISPER_MODEL || "base";

/**
 * Transcribe an audio file using OpenAI Whisper (local).
 * Returns the transcribed text, or null if transcription fails.
 *
 * Supports: .ogg, .mp3, .m4a, .wav, .mp4, .webm (anything ffmpeg can decode)
 */
export async function transcribeAudio(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) {
    logger.warn("transcribe:file_not_found", { filePath });
    return null;
  }

  try {
    // Use whisper CLI — outputs to stdout with --output_format txt
    // --fp16 False for CPU (MacBook Air has no CUDA)
    const { stdout, stderr } = await execFileAsync("whisper", [
      filePath,
      "--model", WHISPER_MODEL,
      "--language", "en",
      "--output_format", "txt",
      "--output_dir", "/tmp",
      "--fp16", "False",
    ], {
      timeout: 120_000, // 2 min timeout for long voice messages
      maxBuffer: 5 * 1024 * 1024,
    });

    // Whisper writes a .txt file next to the output_dir
    // But it also prints the transcription to stderr in verbose mode
    // The actual text file is at /tmp/<basename>.txt
    const baseName = filePath.split("/").pop()!.replace(/\.[^.]+$/, "");
    const txtPath = `/tmp/${baseName}.txt`;

    if (existsSync(txtPath)) {
      const { readFileSync, unlinkSync } = await import("node:fs");
      const text = readFileSync(txtPath, "utf-8").trim();
      // Clean up temp file
      try { unlinkSync(txtPath); } catch { /* ignore */ }

      if (text) {
        logger.info("transcribe:success", { filePath, length: text.length });
        return text;
      }
    }

    // Fallback: try to parse from stderr (whisper prints timestamps + text)
    const lines = (stderr || stdout || "").split("\n");
    const textLines = lines
      .filter(l => l.match(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/))
      .map(l => l.replace(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/, "").trim())
      .filter(Boolean);

    if (textLines.length > 0) {
      const text = textLines.join(" ");
      logger.info("transcribe:success_from_stderr", { filePath, length: text.length });
      return text;
    }

    logger.warn("transcribe:empty_result", { filePath });
    return null;
  } catch (err) {
    logger.error("transcribe:error", {
      error: err instanceof Error ? err.message : String(err),
      filePath,
    });
    return null;
  }
}
