import type {
  BridgeConfig,
  BridgeState,
  ChannelBindResponse,
  ChannelMessageResponse,
  ChannelPromptPolicyResponse,
  ChannelRegisterResponse,
  EClawCard,
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

  async sendMessage(state: BridgeState, message: string, options: { card?: EClawCard; busy?: boolean; suppressA2A?: boolean } = {}): Promise<ChannelMessageResponse> {
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
      ...(options.suppressA2A && { suppressA2A: true }),
    };
    return this.post<ChannelMessageResponse>("/api/channel/message", body);
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
