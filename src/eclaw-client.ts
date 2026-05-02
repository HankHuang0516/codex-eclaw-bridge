import type {
  BridgeConfig,
  BridgeState,
  ChannelBindResponse,
  ChannelMessageResponse,
  ChannelPromptPolicyResponse,
  ChannelRegisterResponse,
  EClawCard,
  SenderHint,
} from "./types.js";

export class EClawClient {
  constructor(private readonly config: BridgeConfig) {}

  async registerCallback(): Promise<ChannelRegisterResponse> {
    const body = {
      channel_api_key: this.config.eclawApiKey,
      ...(this.config.eclawApiSecret && { channel_api_secret: this.config.eclawApiSecret }),
      callback_url: `${this.config.eclawWebhookUrl}/eclaw-webhook`,
      ...(this.config.eclawCallbackToken && { callback_token: this.config.eclawCallbackToken }),
      ...(this.config.eclawCallbackUsername && { callback_username: this.config.eclawCallbackUsername }),
      ...(this.config.eclawCallbackPassword && { callback_password: this.config.eclawCallbackPassword }),
      e2ee_capable: false,
    };
    return this.post<ChannelRegisterResponse>("/api/channel/register", body);
  }

  async bindEntity(): Promise<ChannelBindResponse> {
    const body = {
      channel_api_key: this.config.eclawApiKey,
      ...(this.config.eclawApiSecret && { channel_api_secret: this.config.eclawApiSecret }),
      ...(this.config.eclawEntityId !== undefined && { entityId: this.config.eclawEntityId }),
      name: this.config.eclawBotName,
    };
    return this.post<ChannelBindResponse>("/api/channel/bind", body);
  }

  async sendMessage(
    state: BridgeState,
    message: string,
    options: { card?: EClawCard; busy?: boolean; senderHint?: SenderHint } = {},
  ): Promise<ChannelMessageResponse> {
    if (!state.deviceId || state.entityId === undefined || !state.botSecret) {
      throw new Error("EClaw entity is not bound yet.");
    }

    const body = {
      channel_api_key: this.config.eclawApiKey,
      deviceId: state.deviceId,
      entityId: state.entityId,
      botSecret: state.botSecret,
      state: options.busy ? "BUSY" : "IDLE",
      message,
      ...(options.card && { card: options.card }),
      ...(options.senderHint && { senderHint: options.senderHint }),
    };
    return this.post<ChannelMessageResponse>("/api/channel/message", body);
  }

  /**
   * Fetch the EClaw smart-routing system prompt (issue EClaw#2285 Phase 1).
   * Returns "" on any failure so callers can fail-open: an older server or a
   * temporary outage shouldn't break message delivery.
   *
   * The policy is static across messages, so callers should cache the result
   * for the lifetime of the bridge process.
   */
  async getRoutingPolicy(channel = "codex", lang = "en"): Promise<string> {
    try {
      const params = new URLSearchParams({ channel, lang });
      const url = `${this.config.eclawApiBase}/api/channel/routing-policy?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) return "";
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; policy?: string };
      if (data.success === false || typeof data.policy !== "string") return "";
      return data.policy.trim();
    } catch {
      return "";
    }
  }

  async getPromptPolicy(state: BridgeState, channel = "codex"): Promise<ChannelPromptPolicyResponse | null> {
    if (!state.deviceId || state.entityId === undefined || !state.botSecret) return null;
    const params = new URLSearchParams({
      deviceId: state.deviceId,
      entityId: String(state.entityId),
      botSecret: state.botSecret,
      channel,
    });
    return this.request<ChannelPromptPolicyResponse>(`/api/channel/prompt-policy?${params.toString()}`, {
      method: "GET",
    });
  }

  async unregisterCallback(): Promise<void> {
    await this.request("/api/channel/register", {
      method: "DELETE",
      body: {
        channel_api_key: this.config.eclawApiKey,
        ...(this.config.eclawApiSecret && { channel_api_secret: this.config.eclawApiSecret }),
      },
    });
  }

  private async post<T>(pathname: string, body: unknown): Promise<T> {
    return this.request<T>(pathname, { method: "POST", body });
  }

  private async request<T = unknown>(pathname: string, options: { method: string; body?: unknown }): Promise<T> {
    const res = await fetch(`${this.config.eclawApiBase}${pathname}`, {
      method: options.method,
      headers: { "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const data = (await res.json().catch(() => ({}))) as T & { success?: boolean; message?: string };
    if (!res.ok || data.success === false) {
      throw new Error(data.message || `EClaw API ${options.method} ${pathname} failed with HTTP ${res.status}`);
    }
    return data;
  }
}
