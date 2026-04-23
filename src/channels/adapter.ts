export interface ChannelConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface Attachment {
  /** Local file path after download */
  path: string;
  /** Media type: image, voice, audio, document, video */
  type: "image" | "voice" | "audio" | "document" | "video";
  /** MIME type if known */
  mimeType?: string;
  /** Original filename if available */
  filename?: string;
  /** File size in bytes */
  size?: number;
}

export interface InboundMessage {
  channelName: string;
  senderId: string;
  senderName: string;
  conversationId: string;
  text: string;
  attachments?: Attachment[];
  replyToId?: string;
  timestamp: number;
}

export interface OutboundMessage {
  text: string;
  format?: "text" | "markdown" | "html";
  replyToId?: string;
  /** Optional task name — set when delivering a scheduled task result so the channel can record the outbound message_id. */
  taskName?: string;
}

export interface ChannelCapabilities {
  markdown: boolean;
  html: boolean;
  threads: boolean;
  reactions: boolean;
  voice: boolean;
  maxMessageLength: number;
}

export interface ChannelAdapter {
  readonly name: string;
  connect(config: ChannelConfig): Promise<void>;
  disconnect(): Promise<void>;
  isHealthy(): boolean;
  onMessage(handler: (msg: InboundMessage) => void): void;
  send(conversationId: string, content: OutboundMessage): Promise<void>;
  sendTyping?(conversationId: string): Promise<void>;
  capabilities(): ChannelCapabilities;
}
