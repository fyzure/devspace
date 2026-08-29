import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isToolName,
  isToolResultCard,
  type ToolResultCard,
} from "./card-types.js";

const PERSISTED_CARD_KEY = "devspaceCard";
const PERSISTED_CARD_VERSION = 1;

export interface OpenAIWidgetStateBridge {
  theme?: "light" | "dark";
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
  widgetState?: unknown;
  callTool?: (name: string, arguments_: Record<string, unknown>) => Promise<CallToolResult>;
  // Kept for host capability diagnostics only. DevSpace deliberately treats
  // ChatGPT widget state as read-only: authoritative card persistence lives in
  // the server-side card store, avoiding host-side widget_state write races.
  setWidgetState?: (state: unknown) => Promise<void> | void;
}

export interface OpenAICardReference {
  cardId: string;
  source: "widgetState" | "toolOutput" | "toolResponseMetadata";
}

export interface HostInvocationReference {
  requestId: string | number;
  tool?: string;
}

interface PersistedCardEnvelope {
  version: number;
  card: ToolResultCard;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function persistedCardFromWidgetState(widgetState: unknown): ToolResultCard | undefined {
  const state = asRecord(widgetState);
  const privateContent = asRecord(state?.privateContent);
  const envelope = asRecord(privateContent?.[PERSISTED_CARD_KEY]);

  if (envelope?.version !== PERSISTED_CARD_VERSION) return undefined;

  const candidate = asRecord(envelope.card);
  if (!candidate || !isToolName(candidate.tool) || !isToolResultCard(candidate)) {
    return undefined;
  }

  return candidate as unknown as ToolResultCard;
}

export function cardFromOpenAIToolGlobals(
  toolOutput: unknown,
  toolResponseMetadata: unknown,
): ToolResultCard | undefined {
  const responseMetadata = asRecord(toolResponseMetadata);
  const result = asRecord(responseMetadata?.mcp_tool_result)
    ?? asRecord(responseMetadata?.call_tool_result);
  const resultMeta = asRecord(result?._meta);
  const metaCard = asRecord(resultMeta?.card);
  const structuredContent = asRecord(toolOutput)
    ?? asRecord(result?.structuredContent)
    ?? {};
  const tool = resultMeta?.tool;

  if (!isToolName(tool)) return undefined;

  const candidate = {
    ...structuredContent,
    ...(metaCard ?? {}),
    tool,
  };
  if (!isToolResultCard(candidate)) return undefined;

  return candidate as unknown as ToolResultCard;
}

export function persistedCardFromOpenAIHost(
  bridge: OpenAIWidgetStateBridge | undefined,
): ToolResultCard | undefined {
  if (!bridge) return undefined;

  return persistedCardFromWidgetState(bridge.widgetState)
    ?? cardFromOpenAIToolGlobals(bridge.toolOutput, bridge.toolResponseMetadata);
}

export function cardReferenceFromOpenAIHost(
  bridge: OpenAIWidgetStateBridge | undefined,
): OpenAICardReference | undefined {
  if (!bridge) return undefined;

  const persisted = persistedCardFromWidgetState(bridge.widgetState);
  if (typeof persisted?.cardId === "string" && persisted.cardId.length > 0) {
    return { cardId: persisted.cardId, source: "widgetState" };
  }

  const output = asRecord(bridge.toolOutput);
  if (typeof output?.cardId === "string" && output.cardId.length > 0) {
    return { cardId: output.cardId, source: "toolOutput" };
  }

  const responseMetadata = asRecord(bridge.toolResponseMetadata);
  const result = asRecord(responseMetadata?.mcp_tool_result)
    ?? asRecord(responseMetadata?.call_tool_result);
  const structuredContent = asRecord(result?.structuredContent);
  const resultMeta = asRecord(result?._meta);
  const metaCard = asRecord(resultMeta?.card);
  const cardId = typeof metaCard?.cardId === "string"
    ? metaCard.cardId
    : typeof structuredContent?.cardId === "string"
      ? structuredContent.cardId
      : undefined;

  return cardId && cardId.length > 0
    ? { cardId, source: "toolResponseMetadata" }
    : undefined;
}

export function cardInvocationFromHostContext(
  hostContext: unknown,
): HostInvocationReference | undefined {
  const context = asRecord(hostContext);
  const toolInfo = asRecord(context?.toolInfo);
  const requestId = toolInfo?.id;
  if (typeof requestId !== "string" && typeof requestId !== "number") {
    return undefined;
  }

  const tool = asRecord(toolInfo?.tool);
  const toolName = typeof tool?.name === "string" ? tool.name : undefined;
  return {
    requestId,
    ...(toolName ? { tool: toolName } : {}),
  };
}

export function widgetStateWithPersistedCard(
  widgetState: unknown,
  card: ToolResultCard,
): Record<string, unknown> {
  const currentState = asRecord(widgetState) ?? {};
  const currentPrivateContent = asRecord(currentState.privateContent) ?? {};
  const persisted: PersistedCardEnvelope = {
    version: PERSISTED_CARD_VERSION,
    card,
  };

  return {
    ...currentState,
    privateContent: {
      ...currentPrivateContent,
      [PERSISTED_CARD_KEY]: persisted,
    },
  };
}
