import { Bot, Context } from "grammy";
import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { smartChunk } from "../utils/chunker.js";
import { markdownToTelegramHtml, stripHtmlToPlain } from "../utils/markdown-to-telegram.js";
import { logger } from "../utils/logger.js";
import { logTelegramReply } from "../telegram-reply-logger.js";
import type {
  ChannelAdapter,
  ChannelConfig,
  Attachment,
  InboundMessage,
  OutboundMessage,
  ChannelCapabilities,
} from "./adapter.js";

interface TelegramConfig extends ChannelConfig {
  botToken: string;
  allowedUsers: string[];
  dmPolicy: string;
  forumTopics: boolean;
}

const MAXOS_HOME = process.env.MAXOS_HOME || join(homedir(), ".maxos");
const INBOX_DIR = join(MAXOS_HOME, "inbox");

export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram";
  private bot: Bot | null = null;
  private handler: ((msg: InboundMessage) => void) | null = null;
  private healthy = false;
  private config: TelegramConfig | null = null;
  /** Dedup guard: track recent sends to prevent duplicate messages from concurrent handlers. */
  private recentSends: Map<string, { text: string; ts: number }> = new Map();

  async connect(config: ChannelConfig): Promise<void> {
    this.config = config as TelegramConfig;

    // Ensure inbox directory exists for media downloads
    if (!existsSync(INBOX_DIR)) {
      mkdirSync(INBOX_DIR, { recursive: true });
    }

    // Kill any competing bot processes (CCBot, old tmux sessions) before we start polling
    this.killCompetingBots();

    this.bot = new Bot(this.config.botToken);

    // Handle text messages
    this.bot.on("message:text", (ctx: Context) => {
      if (!ctx.from || !ctx.message || !("text" in ctx.message)) return;
      this.handleIncoming(ctx, ctx.message.text!, []);
    });

    // Handle photos
    this.bot.on("message:photo", async (ctx: Context) => {
      if (!ctx.from || !ctx.message || !ctx.message.photo) return;
      // Telegram sends multiple sizes — grab the largest
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const attachment = await this.downloadFile(photo.file_id, "image", `photo_${Date.now()}.jpg`);
      const caption = ctx.message.caption || "";
      this.handleIncoming(ctx, caption, attachment ? [attachment] : []);
    });

    // Handle voice messages
    this.bot.on("message:voice", async (ctx: Context) => {
      if (!ctx.from || !ctx.message || !ctx.message.voice) return;
      const voice = ctx.message.voice;
      const attachment = await this.downloadFile(
        voice.file_id, "voice",
        `voice_${Date.now()}.ogg`,
        voice.mime_type,
        voice.file_size,
      );
      const caption = ctx.message.caption || "";
      this.handleIncoming(ctx, caption, attachment ? [attachment] : []);
    });

    // Handle audio files (music, podcasts, etc.)
    this.bot.on("message:audio", async (ctx: Context) => {
      if (!ctx.from || !ctx.message || !ctx.message.audio) return;
      const audio = ctx.message.audio;
      const filename = audio.file_name || `audio_${Date.now()}.mp3`;
      const attachment = await this.downloadFile(
        audio.file_id, "audio", filename, audio.mime_type, audio.file_size,
      );
      const caption = ctx.message.caption || "";
      this.handleIncoming(ctx, caption, attachment ? [attachment] : []);
    });

    // Handle documents (PDFs, files, etc.)
    this.bot.on("message:document", async (ctx: Context) => {
      if (!ctx.from || !ctx.message || !ctx.message.document) return;
      const doc = ctx.message.document;
      const filename = doc.file_name || `doc_${Date.now()}`;
      const attachment = await this.downloadFile(
        doc.file_id, "document", filename, doc.mime_type, doc.file_size,
      );
      const caption = ctx.message.caption || "";
      this.handleIncoming(ctx, caption, attachment ? [attachment] : []);
    });

    // Handle video
    this.bot.on("message:video", async (ctx: Context) => {
      if (!ctx.from || !ctx.message || !ctx.message.video) return;
      const video = ctx.message.video;
      const filename = video.file_name || `video_${Date.now()}.mp4`;
      const attachment = await this.downloadFile(
        video.file_id, "video", filename, video.mime_type, video.file_size,
      );
      const caption = ctx.message.caption || "";
      this.handleIncoming(ctx, caption, attachment ? [attachment] : []);
    });

    // Handle video notes (round video messages)
    this.bot.on("message:video_note", async (ctx: Context) => {
      if (!ctx.from || !ctx.message || !ctx.message.video_note) return;
      const vn = ctx.message.video_note;
      const attachment = await this.downloadFile(
        vn.file_id, "video", `videonote_${Date.now()}.mp4`,
      );
      this.handleIncoming(ctx, "", attachment ? [attachment] : []);
    });

    // Handle stickers (treat as image)
    this.bot.on("message:sticker", async (ctx: Context) => {
      if (!ctx.from || !ctx.message || !ctx.message.sticker) return;
      const sticker = ctx.message.sticker;
      const ext = sticker.is_animated ? "tgs" : sticker.is_video ? "webm" : "webp";
      const attachment = await this.downloadFile(
        sticker.file_id, "image", `sticker_${Date.now()}.${ext}`,
      );
      const emoji = sticker.emoji || "";
      this.handleIncoming(ctx, `[Sticker: ${emoji}]`, attachment ? [attachment] : []);
    });

    this.bot.catch((err) => {
      logger.error("telegram:error", { error: err.message });
    });

    // bot.start() is a long-running polling loop — don't await it
    // or it blocks the rest of gateway startup (health server, scheduler)
    this.startWithRetry();
  }

  /**
   * Unified handler for all incoming message types.
   * Validates sender, builds InboundMessage, dispatches to gateway.
   */
  private handleIncoming(ctx: Context, text: string, attachments: Attachment[]): void {
    if (!ctx.from || !ctx.message) return;

    const senderId = String(ctx.from.id);

    // Allowlist enforcement
    if (
      this.config!.dmPolicy === "allowlist" &&
      this.config!.allowedUsers.length > 0
    ) {
      if (!this.config!.allowedUsers.includes(senderId)) {
        logger.warn("telegram:unauthorized", { senderId });
        return;
      }
    }

    const conversationId = ctx.message.message_thread_id
      ? `topic:${ctx.message.message_thread_id}`
      : `dm:${senderId}`;

    const msg: InboundMessage = {
      channelName: "telegram",
      senderId,
      senderName: ctx.from.first_name || "Unknown",
      conversationId,
      text: text || "",
      attachments: attachments.length > 0 ? attachments : undefined,
      replyToId: ctx.message.reply_to_message
        ? String(ctx.message.reply_to_message.message_id)
        : undefined,
      timestamp: ctx.message.date * 1000,
    };

    try {
      const logPath = join(MAXOS_HOME, "workspace", "memory", "telegram-replies.jsonl");
      logTelegramReply(
        {
          messageId: String(ctx.message.message_id),
          conversationId: msg.conversationId,
          text: msg.text,
          replyToId: msg.replyToId,
          timestamp: msg.timestamp,
        },
        logPath,
      );
    } catch (err) {
      logger.warn("telegram:reply_log_failed", { error: err instanceof Error ? err.message : String(err) });
    }

    this.handler?.(msg);
  }

  /**
   * Download a Telegram file to the local inbox directory.
   * Returns an Attachment object, or null if download fails.
   */
  private async downloadFile(
    fileId: string,
    type: Attachment["type"],
    filename: string,
    mimeType?: string,
    fileSize?: number,
  ): Promise<Attachment | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn("telegram:download:no_path", { fileId });
        return null;
      }

      // Telegram file download URL
      const url = `https://api.telegram.org/file/bot${this.config!.botToken}/${file.file_path}`;

      // Create date-based subdirectory to keep inbox organized
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const dayDir = join(INBOX_DIR, today);
      if (!existsSync(dayDir)) {
        mkdirSync(dayDir, { recursive: true });
      }

      const localPath = join(dayDir, filename);

      // Stream download to disk
      const response = await fetch(url);
      if (!response.ok || !response.body) {
        logger.error("telegram:download:http_error", { status: response.status, fileId });
        return null;
      }

      const readable = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
      await pipeline(readable, createWriteStream(localPath));

      logger.info("telegram:download:success", { type, filename, path: localPath });

      return {
        path: localPath,
        type,
        mimeType: mimeType || guessMimeType(filename),
        filename,
        size: fileSize || file.file_size,
      };
    } catch (err) {
      logger.error("telegram:download:error", {
        error: err instanceof Error ? err.message : String(err),
        fileId,
      });
      return null;
    }
  }

  private startWithRetry(attempt = 0): void {
    if (!this.bot) return;

    // Drop any pending updates from other pollers before we claim the token
    this.bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => {});

    this.bot.start({
      onStart: () => {
        this.healthy = true;
        if (attempt > 0) {
          logger.info("telegram:reconnected", { attempt });
        } else {
          logger.info("telegram:connected");
        }
      },
    }).catch((err: Error) => {
      this.healthy = false;
      const is409 = err.message?.includes("409") || err.message?.includes("Conflict");

      if (is409 && attempt < 5) {
        const delay = Math.min(2000 * 2 ** attempt, 30_000);
        logger.warn("telegram:409_conflict_retry", { attempt: attempt + 1, delayMs: delay });
        // Kill again — the competing process may have respawned
        this.killCompetingBots();
        setTimeout(() => this.startWithRetry(attempt + 1), delay);
      } else {
        logger.error("telegram:start_failed", { error: err.message, attempt });
      }
    });
  }

  async disconnect(): Promise<void> {
    this.healthy = false;
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handler = handler;
  }

  async sendTyping(conversationId: string): Promise<void> {
    if (!this.bot) return;
    const [_type, id] = conversationId.split(":");
    try {
      await this.bot.api.sendChatAction(id, "typing");
    } catch {
      // Non-critical — don't break the flow
    }
  }

  async send(
    conversationId: string,
    content: OutboundMessage,
  ): Promise<void> {
    if (!this.bot) throw new Error("Telegram not connected");

    // Dedup guard: skip exact duplicate messages sent within 5 seconds.
    // Catches concurrent handler race conditions in the gateway's early-ack system.
    const dedupKey = conversationId;
    const recent = this.recentSends.get(dedupKey);
    if (recent && content.text === recent.text && Date.now() - recent.ts < 5000) {
      logger.info("telegram:dedup_skipped", { conversationId, textLen: content.text.length });
      return;
    }
    this.recentSends.set(dedupKey, { text: content.text, ts: Date.now() });
    // Clean old entries every 100 sends to prevent unbounded growth
    if (this.recentSends.size > 100) {
      const cutoff = Date.now() - 10_000;
      for (const [k, v] of this.recentSends) {
        if (v.ts < cutoff) this.recentSends.delete(k);
      }
    }

    const [type, id] = conversationId.split(":");
    // For DMs, id is the user's chat ID — works directly.
    // TODO: For topic conversations (type === "topic"), id is the thread ID,
    // but sendMessage needs the *group* chat ID as chatId and the thread ID
    // as message_thread_id. Topic support requires passing the group chat ID
    // through the conversation metadata. For now, DM-only usage is correct.
    const chatId = id;

    // Convert Markdown to Telegram HTML — Claude outputs Markdown but Telegram
    // renders HTML. Without this, **bold** shows as literal asterisks.
    const formatted = markdownToTelegramHtml(content.text);
    // Chunk at 3800, not 4096 — HTML tags add overhead beyond visible text,
    // and Telegram counts UTF-8 bytes not characters for some content.
    const chunks = smartChunk(formatted, 3800);

    for (const chunk of chunks) {
      try {
        const opts: Record<string, unknown> = {
          parse_mode: "HTML",
        };
        if (type === "topic") opts.message_thread_id = Number(id);

        await this.bot.api.sendMessage(chatId, chunk, opts);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // Message too long — strip HTML, re-chunk smaller, retry as plain text
        if (errMsg.includes("message is too long")) {
          logger.warn("telegram:message_too_long", { chunkLen: chunk.length });
          const plainChunks = smartChunk(stripHtmlToPlain(chunk), 3400);
          for (const pc of plainChunks) {
            const plainOpts: Record<string, unknown> = {};
            if (type === "topic") plainOpts.message_thread_id = Number(id);
            await this.bot.api.sendMessage(chatId, pc, plainOpts).catch((retryErr) => {
              logger.error("telegram:retry_failed", { error: String(retryErr), chunkLen: pc.length });
            });
          }
          continue;
        }

        // HTML parsing failed — strip tags, unescape entities, retry as plain text
        if (errMsg.includes("can't parse entities")) {
          logger.warn("telegram:html_parse_failed", { chunkLen: chunk.length });
          const plainOpts: Record<string, unknown> = {};
          if (type === "topic") plainOpts.message_thread_id = Number(id);
          await this.bot.api.sendMessage(chatId, stripHtmlToPlain(chunk), plainOpts).catch((retryErr) => {
            logger.error("telegram:retry_failed", { error: String(retryErr), chunkLen: chunk.length });
          });
          continue;
        }

        logger.error("telegram:send_error", { error: errMsg });
        throw err;
      }
    }
  }

  private killCompetingBots(): void {
    // No-op: competing bot cleanup is handled by the onboarding/setup flow,
    // not at runtime on every connect. Previous implementation had hardcoded
    // process names (ccbot, tmux sessions) that were deployment-specific.
    logger.debug("telegram:kill_competing_skipped", {
      reason: "competitor cleanup delegated to setup flow",
    });
  }

  capabilities(): ChannelCapabilities {
    return {
      markdown: false,
      html: true,
      threads: true,
      reactions: true,
      voice: true,
      maxMessageLength: 4096,
    };
  }
}

/** Best-effort MIME type guess from filename extension */
function guessMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
    ogg: "audio/ogg", oga: "audio/ogg", mp3: "audio/mpeg",
    wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    pdf: "application/pdf", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    txt: "text/plain", csv: "text/csv", json: "application/json",
    tgs: "application/x-tgsticker",
  };
  return map[ext || ""] || "application/octet-stream";
}
