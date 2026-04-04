# Adding a Channel Adapter

MaxOS uses a pluggable adapter system for messaging channels. Adding a new channel (Discord, Slack, SMS, etc.) requires implementing one interface and registering it in the gateway. No core code changes needed beyond the registration line.

## The ChannelAdapter Interface

Defined in `src/channels/adapter.ts`:

```typescript
interface ChannelAdapter {
  readonly name: string;
  connect(config: ChannelConfig): Promise<void>;
  disconnect(): Promise<void>;
  isHealthy(): boolean;
  onMessage(handler: (msg: InboundMessage) => void): void;
  send(conversationId: string, content: OutboundMessage): Promise<void>;
  sendTyping?(conversationId: string): Promise<void>;  // optional
  capabilities(): ChannelCapabilities;
}
```

### Required Methods

**`name`** (readonly property)
Unique string identifying this channel. Used in routing rules, state snapshots, and logs. Examples: `"telegram"`, `"discord"`, `"slack"`.

**`connect(config: ChannelConfig): Promise<void>`**
Initialize the channel connection (start polling, open websocket, etc.). Receives the channel-specific config block from `maxos.json`. The base `ChannelConfig` has `{ enabled: boolean }` plus any additional fields your adapter needs.

Important: if your adapter uses a long-running connection (polling loop, websocket), don't `await` it inside `connect()` -- start it in the background and return. Otherwise you'll block gateway startup.

**`disconnect(): Promise<void>`**
Clean shutdown. Close connections, stop polling, release resources. Called during graceful shutdown.

**`isHealthy(): boolean`**
Return `true` if the channel is connected and functional. Used by the health check endpoint and for routing task results.

**`onMessage(handler: (msg: InboundMessage) => void): void`**
Register the message handler. The gateway calls this once after construction. Your adapter calls `handler(msg)` whenever a message arrives.

**`send(conversationId: string, content: OutboundMessage): Promise<void>`**
Send a message to a conversation. The `conversationId` format is adapter-defined (e.g., `"dm:123456"` or `"topic:789"`). Handle message chunking if the platform has length limits.

**`capabilities(): ChannelCapabilities`**
Return what this channel supports:

```typescript
interface ChannelCapabilities {
  markdown: boolean;       // Platform renders Markdown
  html: boolean;           // Platform renders HTML
  threads: boolean;        // Platform supports threaded conversations
  reactions: boolean;      // Platform supports message reactions
  voice: boolean;          // Platform can receive voice messages
  maxMessageLength: number; // Character limit per message
}
```

### Optional Methods

**`sendTyping?(conversationId: string): Promise<void>`**
Send a typing indicator. The gateway calls this every 4 seconds while processing a message. Implement if the platform supports it. Non-critical -- errors are swallowed.

## Data Types

### InboundMessage

What your adapter passes to the gateway:

```typescript
interface InboundMessage {
  channelName: string;      // Must match your adapter's name
  senderId: string;         // Platform-specific user ID
  senderName: string;       // Display name
  conversationId: string;   // "dm:123" or "topic:456" or "channel:789"
  text: string;             // Message text (may be empty for media-only messages)
  attachments?: Attachment[]; // Media attachments (optional)
  replyToId?: string;       // ID of the message being replied to (optional)
  timestamp: number;        // Unix timestamp in milliseconds
}
```

### OutboundMessage

What the gateway passes to your `send()` method:

```typescript
interface OutboundMessage {
  text: string;
  format?: "text" | "markdown" | "html";
  replyToId?: string;
}
```

### Attachment

For channels that support media:

```typescript
interface Attachment {
  path: string;             // Local file path after download
  type: "image" | "voice" | "audio" | "document" | "video";
  mimeType?: string;
  filename?: string;
  size?: number;            // Bytes
}
```

Your adapter is responsible for downloading media to a local path before passing the attachment. The gateway's `buildPrompt()` method handles the rest -- injecting file references or transcribing voice messages via Whisper.

Recommended download location: `~/.maxos/inbox/YYYY-MM-DD/`.

## Example: Discord Adapter

```typescript
// src/channels/discord.ts
import { Client, GatewayIntentBits } from "discord.js";
import type {
  ChannelAdapter,
  ChannelConfig,
  InboundMessage,
  OutboundMessage,
  ChannelCapabilities,
} from "./adapter.js";

interface DiscordConfig extends ChannelConfig {
  botToken: string;
  allowedUsers: string[];
}

export class DiscordAdapter implements ChannelAdapter {
  readonly name = "discord";
  private client: Client | null = null;
  private handler: ((msg: InboundMessage) => void) | null = null;
  private healthy = false;

  async connect(config: ChannelConfig): Promise<void> {
    const cfg = config as DiscordConfig;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on("ready", () => {
      this.healthy = true;
    });

    this.client.on("messageCreate", (message) => {
      if (message.author.bot) return;
      if (!cfg.allowedUsers.includes(message.author.id)) return;

      const msg: InboundMessage = {
        channelName: "discord",
        senderId: message.author.id,
        senderName: message.author.username,
        conversationId: message.channel.isDMBased()
          ? `dm:${message.author.id}`
          : `channel:${message.channelId}`,
        text: message.content,
        timestamp: message.createdTimestamp,
      };

      this.handler?.(msg);
    });

    // Don't await -- login starts the websocket in the background
    this.client.login(cfg.botToken).catch(() => {
      this.healthy = false;
    });
  }

  async disconnect(): Promise<void> {
    this.healthy = false;
    await this.client?.destroy();
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handler = handler;
  }

  async send(conversationId: string, content: OutboundMessage): Promise<void> {
    if (!this.client) throw new Error("Discord not connected");
    const [_type, id] = conversationId.split(":");
    const channel = await this.client.channels.fetch(id);
    if (channel?.isTextBased() && "send" in channel) {
      // Discord's limit is 2000 chars -- chunk if needed
      await channel.send(content.text.slice(0, 2000));
    }
  }

  capabilities(): ChannelCapabilities {
    return {
      markdown: true,
      html: false,
      threads: true,
      reactions: true,
      voice: true,
      maxMessageLength: 2000,
    };
  }
}
```

## Registering Your Adapter

Add your adapter to `Gateway.startChannels()` in `src/gateway.ts`:

```typescript
private async startChannels(): Promise<void> {
  // Existing Telegram adapter
  if (this.config.channels.telegram?.enabled) {
    const telegram = new TelegramAdapter();
    telegram.onMessage((msg) => void this.handleMessage(msg));
    await telegram.connect(this.config.channels.telegram);
    this.channels.push(telegram);
  }

  // Add your new adapter
  if (this.config.channels.discord?.enabled) {
    const discord = new DiscordAdapter();
    discord.onMessage((msg) => void this.handleMessage(msg));
    await discord.connect(this.config.channels.discord);
    this.channels.push(discord);
  }
}
```

Then add the config type to `MaxOSConfig` in `src/config.ts`:

```typescript
channels: {
  telegram?: { /* ... */ };
  discord?: {
    enabled: boolean;
    botToken: string;
    allowedUsers: string[];
  };
};
```

And add config to `maxos.json`:

```jsonc
{
  "channels": {
    "discord": {
      "enabled": true,
      "botToken": "${DISCORD_BOT_TOKEN}",
      "allowedUsers": ["123456789"]
    }
  }
}
```

## Conventions

- **conversationId format**: Use `type:id` (e.g., `dm:123`, `topic:456`, `channel:789`). The session manager splits on `:` and uses this for routing.
- **Error handling**: Swallow non-critical errors (typing indicators, reactions). Throw on send failures so the gateway can log them.
- **Media downloads**: Download to `~/.maxos/inbox/YYYY-MM-DD/` to keep things organized and cleanable.
- **Auth**: Enforce allowlists in your adapter before dispatching to the gateway. Don't let unauthorized messages reach the engine.
