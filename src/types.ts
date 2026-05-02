export type BridgeConfig = {
  eclawApiBase: string;
  eclawApiKey: string;
  eclawApiSecret?: string;
  eclawWebhookUrl: string;
  eclawWebhookPort: number;
  eclawBotName: string;
  eclawEntityId?: number;
  eclawCallbackToken?: string;
  eclawCallbackUsername?: string;
  eclawCallbackPassword?: string;
  codexBin: string;
  codexWorkspace: string;
  codexModel?: string;
  codexSandbox: string;
  codexApprovalPolicy: string;
  codexAppServerListen: string;
  codexReasoningEffort?: string;
  bridgeStatePath: string;
  bridgeReplyTimeoutMs: number;
  bridgeApprovalTimeoutMs: number;
  bridgeSendBusyUpdates: boolean;
  bridgeRequireCallbackAuth: boolean;
  bridgeStatusHeartbeatEnabled: boolean;
  bridgeStatusHeartbeatMs: number;
  bridgeWatchdogEnabled: boolean;
  bridgeWatchdogStallMs: number;
};

export type BridgeState = {
  deviceId?: string;
  entityId?: number;
  botSecret?: string;
  accountId?: number;
  publicCode?: string;
  threadId?: string;
  model?: string;
  reasoningEffort?: string;
  activeTurnId?: string;
  startedAt?: string;
  updatedAt?: string;
};

export type EClawInboundPayload = {
  event?: string;
  deviceId: string;
  entityId: number;
  conversationId?: string;
  from?: string;
  text?: string;
  card?: unknown;
  ask_id?: string | null;
  action_id?: string | null;
  mediaType?: string | null;
  mediaUrl?: string | null;
  timestamp?: number;
  isBroadcast?: boolean;
  fromEntityId?: number;
  fromCharacter?: string;
  fromPublicCode?: string;
  eclaw_context?: {
    expectsReply?: boolean;
    silentToken?: string;
    missionHints?: string;
    b2bRemaining?: number;
    b2bMax?: number;
    [key: string]: unknown;
  };
  contextInlined?: boolean;
  e2ee?: boolean;
};

export type ChannelRegisterResponse = {
  success: boolean;
  message?: string;
  deviceId?: string;
  accountId?: number;
  entities?: Array<{
    entityId: number;
    isBound: boolean;
    name?: string | null;
    character?: string;
    bindingType?: string | null;
    boundToThisAccount?: boolean;
  }>;
};

export type ChannelBindResponse = {
  success: boolean;
  message?: string;
  deviceId?: string;
  entityId?: number;
  botSecret?: string;
  publicCode?: string;
  bindingType?: string;
  entities?: unknown[];
};

export type ChannelMessageResponse = {
  success: boolean;
  message?: string;
  delivered?: boolean;
  warnings?: string[];
  [key: string]: unknown;
};

export type ChannelPromptPolicyResponse = {
  success: boolean;
  policy?: {
    version?: number;
    channel?: string;
    taskProtocol?: {
      requireTestPlan?: boolean;
      requireMilestoneUpdates?: boolean;
      statusHeartbeatMs?: number;
      [key: string]: unknown;
    };
    sections?: Array<{
      scope: string;
      title: string;
      content: string;
    }>;
    compiledPrompt?: string;
    [key: string]: unknown;
  };
  devicePolicy?: unknown;
  entityPolicy?: unknown;
  message?: string;
};

export type EClawCard = {
  ask_id: string;
  title: string;
  body: string;
  buttons: Array<{
    id: string;
    label: string;
    style?: "primary" | "danger" | "secondary";
  }>;
};

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type JsonRpcNotification = {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
};

export type ServerRequestMessage = JsonRpcRequest;
export type ServerNotificationMessage = JsonRpcNotification;

export type ApprovalRequest = {
  rpcId: number | string;
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  title: string;
  body: string;
  availableDecisions: string[];
  rawParams: unknown;
};

export type PendingTurn = {
  turnId: string;
  finalText: string;
};
