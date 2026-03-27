export interface ChannelConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface InboundMessage {
  channelName: string;
  senderId: string;
  senderName: string;
  conversationId: string;
  text: string;
  replyToId?: string;
  timestamp: number;
}

export interface OutboundMessage {
  text: string;
  format?: "text" | "markdown" | "html";
  replyToId?: string;
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
  capabilities(): ChannelCapabilities;
}
