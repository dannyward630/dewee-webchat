// Wire contract shared by the browser widget and every backend (Node/Workers/PHP).
// Keep in sync with php/dewee-webchat.php and docs/http-contract.md.

/** Server-Sent Events emitted by `POST {basePath}/chat`. */
export type ChatStreamEvent =
  | { type: "start"; runId?: string; conversationId: string; agent: string; actionsHash?: string }
  | { type: "thinking"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments?: unknown }
  | { type: "tool_result"; id: string; name: string; isError: boolean; result?: string }
  | { type: "done"; content: string; usage?: Record<string, number> }
  | { type: "error"; message: string; code?: string };

export interface AgentInfo {
  id: string;
  name?: string;
  description?: string;
}

/** Response of `GET {basePath}/config` — safe to expose publicly. */
export interface PublicConfig {
  agents: AgentInfo[];
  defaultAgent: string;
  allowAgentSwitch: boolean;
  allowClientCredentials: boolean;
  turnstileSiteKey?: string;
  maxMessageLength: number;
  version: string;
}

/** Response of `POST {basePath}/session`. */
export interface SessionResponse {
  visitorId: string;
  token: string;
  expiresAt: number;
}

export interface ToolCallView {
  id: string;
  name: string;
  arguments?: unknown;
  result?: string;
  isError?: boolean;
  status: "running" | "done" | "error";
}

/** A transcript message as returned by `GET {basePath}/history`. */
export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls?: ToolCallView[];
  createdAt?: string;
}

/** How much an agent-invoked page action can change. `mutate`/`destructive` always need user approval. */
export type ActionSensitivity = "read" | "navigate" | "mutate" | "destructive";

/** What the backend (and the agent) learns about a page action. Handlers never leave the browser. */
export interface ActionManifestEntry {
  name: string;
  description: string;
  /** JSON Schema subset describing `args` (object). */
  parameters: Record<string, unknown>;
  sensitivity: ActionSensitivity;
}

/** Body of `POST {basePath}/chat`. `actions`/`actionsHash`/`pageContext` are optional (page actions). */
export interface ChatRequestBody {
  message: string;
  agent?: string;
  conversationId?: string;
  actions?: ActionManifestEntry[];
  /** Hash from the `start` event of the last completed turn; the manifest is re-sent to the agent only when it differs. */
  actionsHash?: string;
  pageContext?: unknown;
}

export const HEADER_GATEWAY_URL = "x-dewee-gateway-url";
export const HEADER_GATEWAY_TOKEN = "x-dewee-gateway-token";
export const VERSION = "__DEWEE_WEBCHAT_VERSION__";
