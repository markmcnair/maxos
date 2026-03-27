import { Bot, Context } from "grammy";
import { smartChunk } from "../utils/chunker.js";
import { logger } from "../utils/logger.js";
import type {
  ChannelAdapter,
  ChannelConfig,
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

export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram";
  private bot: Bot | null = null;
  private handler: ((msg: InboundMessage) => void) | null = null;
  private healthy = false;
  private config: TelegramConfig | null = null;

  async connect(config: ChannelConfig): Promise<void> {
    this.config = config as TelegramConfig;
    this.bot = new Bot(this.config.botToken);

    this.bot.on("message:text", (ctx: Context) => {
      if (!ctx.from || !ctx.message || !("text" in ctx.message)) return;

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
        text: ctx.message.text!,
        replyToId: ctx.message.reply_to_message
          ? String(ctx.message.reply_to_message.message_id)
          : undefined,
        timestamp: ctx.message.date * 1000,
      };

      this.handler?.(msg);
    });

    this.bot.catch((err) => {
      logger.error("telegram:error", { error: err.message });
    });

    await this.bot.start({
      onStart: () => {
        this.healthy = true;
        logger.info("telegram:connected");
      },
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

  async send(
    conversationId: string,
    content: OutboundMessage,
  ): Promise<void> {
    if (!this.bot) throw new Error("Telegram not connected");

    const [type, id] = conversationId.split(":");
    const chatId = type === "dm" ? id : id;

    const chunks = smartChunk(content.text, 4096);
    for (const chunk of chunks) {
      try {
        const opts: Record<string, unknown> = {};
        if (content.format === "html") opts.parse_mode = "HTML";
        if (type === "topic") opts.message_thread_id = Number(id);

        await this.bot.api.sendMessage(chatId, chunk, opts);
      } catch (err) {
        logger.error("telegram:send_error", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
  }

  capabilities(): ChannelCapabilities {
    return {
      markdown: false,
      html: true,
      threads: true,
      reactions: true,
      voice: false,
      maxMessageLength: 4096,
    };
  }
}
