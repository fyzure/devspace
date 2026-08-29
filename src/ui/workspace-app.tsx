import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isEditTool,
  isExpandableCard,
  isInitiallyExpandedCard,
  isPatchTool,
  isReadTool,
  isReviewTool,
  isToolName,
  isToolResultCard,
  isWriteTool,
  payloadText,
  type HostContext,
  type ToolName,
  type ToolResultCard,
} from "./card-types.js";
import {
  cardInvocationFromHostContext,
  cardReferenceFromOpenAIHost,
  persistedCardFromOpenAIHost,
  type OpenAIWidgetStateBridge,
} from "./card-persistence.js";
import {
  getProviderLogo,
  renderIcon,
  toolIcons,
  type ProviderLogo,
  type ToolIcon,
} from "./icons.js";
import {
  getToolDisplay,
  getToolHeaderSummary,
  type ToolDisplay,
} from "./tool-display.js";
import { FilteredPostMessageTransport } from "./post-message-transport.js";
import "./workspace-app.css";

interface MountedPayload {
  update(options: {
    card: ToolResultCard;
    hostContext?: HostContext;
    errorMessage?: string | null;
    visibleFileCount?: number;
  }): void;
  unmount(): void;
}

let app: App | null = null;
let connected = false;
let connectionError: string | null = null;
let hostContext: HostContext | undefined;
let card: ToolResultCard | null = null;
type CardOrigin = "host" | "tool-result" | "store";
let cardOrigin: CardOrigin | null = null;
let expanded = false;
let reviewFilesExpanded = false;
let errorMessage: string | null = null;
let currentPayload: MountedPayload | null = null;
let currentPayloadContainer: HTMLElement | null = null;
let openWorkspaceInstructionKey: string | null = null;
let showAvailableWorkspaceInstructions = false;
type StoredCardRestoreOutcome = "restored" | "missing" | "waiting" | "failed";
interface StoredCardRestoreFlight {
  key: string;
  token: symbol;
  promise: Promise<StoredCardRestoreOutcome>;
}
let storedCardRestoreInFlight: StoredCardRestoreFlight | null = null;

const maybeAppRoot = document.querySelector<HTMLElement>("#app");

if (!maybeAppRoot) {
  throw new Error("Missing #app root element.");
}

const appRoot = maybeAppRoot;

const CARD_PROBE_PREFIX = "[DevSpace card-probe]";
const CARD_PROBE_BUILD = "card-race-v7";

void boot();

async function boot(): Promise<void> {
  const mode = widgetMode();
  logCardProbe("boot", { widgetMode: mode });
  render();

  const restoreFromOpenAIGlobals = () => {
    logCardProbe("openai:set_globals", { cardAlreadyPresent: Boolean(card) });
    if (!connected || card) return;
    if (mode === "openai-legacy") {
      if (restoreHostCard()) render();
      return;
    }
    void recoverMissingCard("openai:set_globals");
  };
  const onVisibilityChange = () => {
    logCardProbe("visibility-change");
  };
  const onPageHide = (event: PageTransitionEvent) => {
    logCardProbe("pagehide", { persisted: event.persisted });
  };
  const onPageShow = (event: PageTransitionEvent) => {
    logCardProbe("pageshow", { persisted: event.persisted });
  };
  window.addEventListener("openai:set_globals", restoreFromOpenAIGlobals, { passive: true });
  document.addEventListener("visibilitychange", onVisibilityChange, { passive: true });
  window.addEventListener("pagehide", onPageHide, { passive: true });
  window.addEventListener("pageshow", onPageShow, { passive: true });

  if (mode === "openai-legacy") {
    connected = true;
    const restored = restoreHostCard();
    logCardProbe("openai-legacy-ready", { restored });
    if (!restored) scheduleOpenAILegacyRestore();
    render();
    return;
  }

  app = new App(
    { name: "devspace-tool-cards", version: "0.7.0-hybrid-host" },
    {},
  );

  app.ontoolresult = (result) => {
    const structuredContent = getStructuredContent<Partial<ToolResultCard>>(result);
    const metaCard = cardFromMeta(result);
    const structured = metaCard
      ? { ...structuredContent, ...metaCard }
      : structuredContent;
    const tool = toolNameFromMeta(result);

    logCardProbe("tool-result", {
      resultKeys: probeKeys(result),
      structuredContentKeys: probeKeys(structuredContent),
      parsedTool: tool,
      cardId: structured?.cardId,
      mergedCardValid: isToolResultCard(structured),
    });

    if (!tool || !isToolResultCard(structured)) {
      void recoverMissingCard("tool-result");
      return;
    }

    const nextCard = { ...structured, tool };
    card = nextCard;
    cardOrigin = "tool-result";
    expanded = isInitiallyExpandedCard(nextCard);
    reviewFilesExpanded = false;
    openWorkspaceInstructionKey = null;
    showAvailableWorkspaceInstructions = false;
    errorMessage = null;
    render();
  };

  app.onhostcontextchanged = (ctx) => {
    const previousInvocationKey = currentInvocationKey();
    hostContext = {
      ...hostContext,
      ...ctx,
    };
    const nextInvocationKey = currentInvocationKey();
    applyHostContext();

    if (
      previousInvocationKey
      && nextInvocationKey
      && previousInvocationKey !== nextInvocationKey
    ) {
      clearCardForRestore();
      render();
      void recoverMissingCard("host-context-invocation-change");
      return;
    }

    if (
      !previousInvocationKey
      && nextInvocationKey
      && card
      && cardOrigin !== "tool-result"
    ) {
      void reconcileHostCard("host-context-invocation-ready");
    }
    // Workspace details inherit host variables directly. Rebuilding their DOM on
    // iframe resize would reset an in-progress instruction preview interaction.
    if (card?.tool !== "open_workspace") renderPayloadIfNeeded();
  };

  app.onteardown = async () => {
    logCardProbe("teardown");
    window.removeEventListener("openai:set_globals", restoreFromOpenAIGlobals);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    unmountPayload();
    return {};
  };

  try {
    await app.connect(new FilteredPostMessageTransport(window.parent, window.parent));
    const initialContext = app.getHostContext();
    if (initialContext) hostContext = initialContext;
    applyHostContext();
    connected = true;
    logCardProbe("connected");
    if (!card) restoreHostCard();
    if (card && cardOrigin === "host" && currentInvocationKey()) {
      await reconcileHostCard("post-connect");
    } else if (!card) {
      await recoverMissingCard("post-connect");
    }
  } catch (connectError) {
    connectionError = connectError instanceof Error
      ? connectError.message
      : String(connectError);
    logCardProbe("connect-failed", { error: connectionError });
  }

  render();
}

function openAIWidgetBridge(): OpenAIWidgetStateBridge | undefined {
  return (window as Window & { openai?: OpenAIWidgetStateBridge }).openai;
}

function widgetMode(): "mcp-app" | "openai-legacy" {
  const configured = document
    .querySelector<HTMLMetaElement>('meta[name="devspace-widget-mode"]')
    ?.content;
  if (configured === "openai-legacy") return "openai-legacy";

  // The legacy ChatGPT bridge exposes window.openai. Prefer it before
  // initiating an MCP Apps handshake so a partially initialized ChatGPT host
  // cannot tear the iframe down during ui/initialize.
  if (openAIWidgetBridge()) return "openai-legacy";

  try {
    const referrerHost = new URL(document.referrer).hostname.toLowerCase();
    if (referrerHost === "chatgpt.com" || referrerHost.endsWith(".chatgpt.com")) {
      return "openai-legacy";
    }
  } catch {
    // Empty or non-URL referrers are normal in sandboxed MCP hosts.
  }

  return "mcp-app";
}

function scheduleOpenAILegacyRestore(attempt = 0): void {
  if (card || attempt >= 40) return;
  window.setTimeout(() => {
    if (card) return;
    if (restoreHostCard()) {
      render();
      return;
    }
    scheduleOpenAILegacyRestore(attempt + 1);
  }, 50);
}

function restoreHostCard(): boolean {
  const bridge = openAIWidgetBridge();
  const restored = persistedCardFromOpenAIHost(bridge);
  if (!restored) {
    logCardProbe("host-restore-miss");
    return false;
  }

  card = restored;
  cardOrigin = "host";
  expanded = isInitiallyExpandedCard(restored);
  reviewFilesExpanded = false;
  openWorkspaceInstructionKey = null;
  showAvailableWorkspaceInstructions = false;
  errorMessage = null;
  logCardProbe("host-restore-hit", {
    tool: restored.tool,
    cardId: restored.cardId,
    cardKeys: probeKeys(restored),
  });
  return true;
}

async function recoverMissingCard(trigger: string): Promise<boolean> {
  if (card) return true;
  if (restoreHostCard()) {
    if (currentInvocationKey()) {
      await reconcileHostCard(`${trigger}:host-card`);
    }
    render();
    return true;
  }

  const outcome = await restoreStoredCard(trigger);
  if (outcome === "restored") return true;

  if (outcome === "waiting" || outcome === "failed") {
    errorMessage = null;
    logCardProbe("restore-deferred", { trigger, outcome });
    render();
    return false;
  }

  card = null;
  cardOrigin = null;
  expanded = false;
  reviewFilesExpanded = false;
  openWorkspaceInstructionKey = null;
  showAvailableWorkspaceInstructions = false;
  errorMessage = "No result card is available for this tool result.";
  logCardProbe("restore-exhausted", { trigger });
  render();
  return false;
}

async function reconcileHostCard(trigger: string): Promise<boolean> {
  if (!card || cardOrigin === "tool-result" || !currentInvocationKey()) return Boolean(card);
  const previousCardId = card.cardId;
  const outcome = await restoreStoredCard(trigger, { replaceExisting: true });
  if (outcome === "restored") return true;

  logCardProbe("host-card-reconcile-deferred", {
    trigger,
    cardId: previousCardId,
    outcome,
  });
  return true;
}

function restoreStoredCard(
  trigger: string,
  options: { replaceExisting?: boolean } = {},
): Promise<StoredCardRestoreOutcome> {
  if (card && !options.replaceExisting) return Promise.resolve("restored");

  const bridge = openAIWidgetBridge();
  const reference = cardReferenceFromOpenAIHost(bridge);
  const invocation = cardInvocationFromHostContext(hostContext ?? app?.getHostContext());
  // Prefer the concrete card id whenever ChatGPT has surfaced one. Its
  // stateless MCP transport can reuse JSON-RPC request ids (for example `0`)
  // across distinct tool calls, so an invocation id is only a fallback hint.
  const restoreKey = reference
    ? cardRestoreKey(reference.cardId)
    : invocation
      ? invocationRestoreKey(invocation.requestId)
      : undefined;

  if (!restoreKey) {
    logCardProbe("store-restore-no-reference", { trigger });
    return Promise.resolve("waiting");
  }

  if (storedCardRestoreInFlight?.key === restoreKey) {
    logCardProbe("store-restore-joined", { trigger });
    return storedCardRestoreInFlight.promise;
  }

  if (!app || !connected) {
    logCardProbe("store-restore-not-connected", {
      trigger,
      cardId: reference?.cardId,
      requestId: invocation?.requestId,
      referenceSource: reference?.source ?? "hostContext.toolInfo",
    });
    return Promise.resolve("waiting");
  }

  logCardProbe("store-restore-start", {
    trigger,
    cardId: reference?.cardId,
    requestId: invocation?.requestId,
    referenceSource: reference?.source ?? "hostContext.toolInfo",
  });

  const restoreToken = Symbol(restoreKey);
  const restorePromise = (async () => {
    try {
      const result = reference
        ? await app!.callServerTool({
            name: "get_card_snapshot",
            arguments: { cardId: reference!.cardId },
          })
        : await app!.callServerTool({
            name: "get_card_snapshot_by_invocation",
            arguments: { requestId: invocation!.requestId },
          });
      const structured = getStructuredContent<{
        hit?: boolean;
        cardId?: string;
        tool?: string;
        card?: unknown;
      }>(result);
      const candidate = probeRecord(structured?.card);
      const candidateTool = candidate?.tool;

      if (currentRestoreKey() !== restoreKey) {
        logCardProbe("store-restore-stale-discard", {
          trigger,
          restoreKey,
          currentRestoreKey: currentRestoreKey(),
          cardId: structured?.cardId,
          requestId: invocation?.requestId,
        });
        return "waiting";
      }

      if (
        result.isError
        || structured?.hit === false
        || !candidate
        || !isToolName(candidateTool)
        || !isToolResultCard(candidate)
        || (invocation?.tool && candidateTool !== invocation.tool)
      ) {
        logCardProbe("store-restore-miss", {
          trigger,
          cardId: reference?.cardId,
          requestId: invocation?.requestId,
          expectedTool: invocation?.tool,
          actualTool: candidateTool,
          isError: result.isError === true,
          structuredKeys: probeKeys(structured),
        });
        return result.isError ? "missing" : "failed";
      }

      const restored = candidate as unknown as ToolResultCard;
      if (invocation && reference && reference.cardId !== restored.cardId) {
        logCardProbe("store-restore-reference-mismatch", {
          trigger,
          requestId: invocation.requestId,
          staleCardId: reference.cardId,
          authoritativeCardId: restored.cardId,
          referenceSource: reference.source,
        });
      }
      card = restored;
      cardOrigin = "store";
      expanded = isInitiallyExpandedCard(restored);
      reviewFilesExpanded = false;
      openWorkspaceInstructionKey = null;
      showAvailableWorkspaceInstructions = false;
      errorMessage = null;
      logCardProbe("store-restore-hit", {
        trigger,
        tool: restored.tool,
        cardId: restored.cardId,
        requestId: invocation?.requestId,
        referenceSource: reference?.source ?? "hostContext.toolInfo",
        cardKeys: probeKeys(restored),
      });
      render();
      return "restored";
    } catch (restoreError) {
      logCardProbe("store-restore-failed", {
        trigger,
        cardId: reference?.cardId,
        requestId: invocation?.requestId,
        error: restoreError instanceof Error ? restoreError.message : String(restoreError),
      });
      return "failed";
    } finally {
      if (storedCardRestoreInFlight?.token === restoreToken) {
        storedCardRestoreInFlight = null;
      }
    }
  })();

  storedCardRestoreInFlight = {
    key: restoreKey,
    token: restoreToken,
    promise: restorePromise,
  };
  return restorePromise;
}

function currentInvocationKey(): string | undefined {
  const invocation = cardInvocationFromHostContext(hostContext ?? app?.getHostContext());
  return invocation ? invocationRestoreKey(invocation.requestId) : undefined;
}

function currentRestoreKey(): string | undefined {
  const reference = cardReferenceFromOpenAIHost(openAIWidgetBridge());
  if (reference) return cardRestoreKey(reference.cardId);

  return currentInvocationKey();
}

function invocationRestoreKey(requestId: string | number): string {
  return `invocation:${typeof requestId}:${String(requestId)}`;
}

function cardRestoreKey(cardId: string): string {
  return `card:${cardId}`;
}

function clearCardForRestore(): void {
  card = null;
  cardOrigin = null;
  expanded = false;
  reviewFilesExpanded = false;
  openWorkspaceInstructionKey = null;
  showAvailableWorkspaceInstructions = false;
  errorMessage = null;
}

function probeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function probeKeys(value: unknown): string[] {
  return Object.keys(probeRecord(value) ?? {}).sort();
}

function bridgeProbe(): Record<string, unknown> {
  const bridge = openAIWidgetBridge();
  const widgetState = probeRecord(bridge?.widgetState);
  const privateContent = probeRecord(widgetState?.privateContent);
  const envelope = probeRecord(privateContent?.devspaceCard);
  const persistedCard = probeRecord(envelope?.card);
  const toolOutput = probeRecord(bridge?.toolOutput);
  const responseMetadata = probeRecord(bridge?.toolResponseMetadata);
  const mcpResult = probeRecord(responseMetadata?.mcp_tool_result)
    ?? probeRecord(responseMetadata?.call_tool_result);
  const mcpResultMeta = probeRecord(mcpResult?._meta);
  const mcpResultCard = probeRecord(mcpResultMeta?.card);
  const reference = cardReferenceFromOpenAIHost(bridge);
  const invocation = cardInvocationFromHostContext(hostContext ?? app?.getHostContext());

  return {
    bridgePresent: Boolean(bridge),
    setWidgetState: typeof bridge?.setWidgetState === "function",
    widgetStateKeys: probeKeys(widgetState),
    privateContentKeys: probeKeys(privateContent),
    persistedEnvelopeVersion: envelope?.version,
    persistedCardId: persistedCard?.cardId,
    persistedCardKeys: probeKeys(persistedCard),
    toolOutputKeys: probeKeys(toolOutput),
    toolOutputCardId: toolOutput?.cardId,
    toolResponseMetadataKeys: probeKeys(responseMetadata),
    mcpResultKeys: probeKeys(mcpResult),
    mcpResultMetaKeys: probeKeys(mcpResultMeta),
    mcpResultTool: mcpResultMeta?.tool,
    mcpResultCardId: mcpResultCard?.cardId,
    mcpResultCardKeys: probeKeys(mcpResultCard),
    cardReference: reference,
    hostInvocation: invocation,
  };
}

function logCardProbe(
  event: string,
  fields: Record<string, unknown> = {},
): void {
  console.info(CARD_PROBE_PREFIX, event, {
    build: CARD_PROBE_BUILD,
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    currentTool: card?.tool,
    currentCardId: card?.cardId,
    ...fields,
    bridge: bridgeProbe(),
  });
}

function applyHostContext(): void {
  if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
  if (hostContext?.styles?.variables) {
    applyHostStyleVariables(hostContext.styles.variables);
  }
  if (hostContext?.styles?.css?.fonts) {
    applyHostFonts(hostContext.styles.css.fonts);
  }

  const insets = hostContext?.safeAreaInsets;
  if (!insets) return;

  document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
}

function render(): void {
  unmountPayload();

  if (connectionError) {
    renderEmpty(connectionError, "error");
    return;
  }

  if (!connected) {
    renderEmpty("Connecting to host...");
    return;
  }

  if (!card) {
    if (errorMessage) {
      renderEmpty(errorMessage, "error");
      return;
    }

    // ChatGPT can transiently mount an output-template iframe that has neither
    // tool invocation context nor a persisted card reference. That iframe is
    // not capable of identifying which result it belongs to, so rendering a
    // permanent "Waiting for a tool result" card is misleading. Keep the
    // orphan placeholder collapsed; a later tool-result or set_globals event
    // will render the real card as soon as the host supplies an identity.
    if (!currentRestoreKey()) {
      renderUnidentifiedPlaceholder();
      return;
    }

    renderEmpty("Waiting for a tool result.", "muted");
    return;
  }

  const display = getToolDisplay(card);
  if (isReviewTool(card.tool)) {
    renderReviewCard(card, display);
    return;
  }

  const expandable = isExpandableCard(card);
  const main = element("main", { className: "shell" });
  const section = element("section", {
    className: toolCardClassName(display),
  });
  const button = element("button", {
    className: "tool-header",
    type: "button",
    ariaExpanded: String(expanded),
    disabled: !expandable,
  });

  if (expandable) {
    button.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
  }

  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.append(renderIcon(display.icon));

  const toolMain = element("span", { className: "tool-main" });
  const title = element("span", { className: "tool-title", text: display.title });
  toolMain.append(title);
  if (display.label) {
    toolMain.append(element("span", {
      className: "tool-label",
      text: display.label,
      title: display.label,
    }));
  }

  button.append(
    icon,
    toolMain,
    renderHeaderSummary(card),
    renderChevron(expanded, expandable),
  );
  section.append(button);

  if (expanded) {
    const body = element("div", { className: "tool-body" });
    currentPayloadContainer = body;
    section.append(body);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
}

function renderEmpty(message: string, tone: "muted" | "error" = "muted"): void {
  const main = element("main", { className: "shell" });
  main.append(element("section", { className: `empty ${tone}`, text: message }));
  appRoot.replaceChildren(main);
}

function renderUnidentifiedPlaceholder(): void {
  appRoot.replaceChildren();
}

async function renderPayloadIfNeeded(): Promise<void> {
  if (!card || !currentPayloadContainer || !expanded) return;

  const target = currentPayloadContainer;

  if (errorMessage) {
    renderStatus(target, errorMessage, "error");
    return;
  }

  if (card.tool === "open_workspace") {
    renderWorkspacePayload(target, card);
    return;
  }

  if (shouldUseHeavyPayload(card)) {
    if (currentPayload) {
      currentPayload.update({ card, hostContext, errorMessage });
      return;
    }

    setPayloadLoading(target, true);

    try {
      const { mountHeavyPayload } = await import("./heavy-payload.js");
      if (target !== currentPayloadContainer || !expanded || !card) return;

      setPayloadLoading(target, false);
      currentPayload = mountHeavyPayload(target, {
        card,
        hostContext,
        errorMessage,
      });
    } catch (loadError) {
      if (target !== currentPayloadContainer || !expanded) return;

      setPayloadLoading(target, false);
      renderStatus(
        target,
        loadError instanceof Error ? loadError.message : "Unable to load details.",
        "error",
      );
    }
    return;
  }

  if (isReviewTool(card.tool) || isPatchTool(card.tool)) {
    const visibleFileCount = isReviewTool(card.tool) && !reviewFilesExpanded
      ? Math.max(3, (card.files ?? []).slice(0, 3).length)
      : undefined;

    if (currentPayload) {
      currentPayload.update({ card, hostContext, errorMessage, visibleFileCount });
      return;
    }

    renderStatus(target, isReviewTool(card.tool) ? "Loading review..." : "Loading diff...");

    const { mountReviewPayload } = await import("./review-payload.js");
    if (target !== currentPayloadContainer || !card) return;

    currentPayload = mountReviewPayload(target, {
      card,
      hostContext,
      errorMessage,
      visibleFileCount,
    });
    return;
  }

  const text = payloadText(card.payload);
  if (!text) {
    renderStatus(target, "No details available.");
    return;
  }

  renderPrePayload(target, text, card.tool);
}

function shouldUseHeavyPayload(card: ToolResultCard): boolean {
  return isReadTool(card.tool) || isEditTool(card.tool) || isWriteTool(card.tool);
}

function unmountPayload(): void {
  unmountCurrentPayload();
  currentPayload = null;
  currentPayloadContainer = null;
}

function unmountCurrentPayload(): void {
  currentPayload?.unmount();
  currentPayload = null;
}

function renderStatus(
  container: HTMLElement,
  message: string,
  tone: "muted" | "error" = "muted",
): void {
  unmountCurrentPayload();
  container.replaceChildren(element("div", { className: `status ${tone}`, text: message }));
}

function renderPrePayload(
  container: HTMLElement,
  text: string,
  tool: string,
): void {
  unmountCurrentPayload();
  container.replaceChildren(element("pre", {
    className: `text-payload pretty-scrollbar ${tool}`,
    text,
  }));
}

function renderHeaderSummary(card: ToolResultCard): HTMLElement {
  const summary = getToolHeaderSummary(card);

  if (summary.kind === "diff") {
    const stats = element("span", { className: "stats" });
    stats.setAttribute("aria-label", "Diff statistics");
    stats.append(
      element("span", { className: "add", text: `+${String(summary.additions)}` }),
      element("span", { className: "remove", text: `-${String(summary.removals)}` }),
    );
    return stats;
  }

  const meta = element("span", {
    className: `header-meta ${summary.kind === "empty" ? "empty" : ""}`,
    text: summary.kind === "text" ? summary.text : "",
  });
  if (summary.kind === "empty") meta.setAttribute("aria-hidden", "true");
  return meta;
}

function renderReviewCard(card: ToolResultCard, display: ToolDisplay): void {
  unmountPayload();

  const files = card.files ?? [];
  const visibleFiles = reviewFilesExpanded ? files : files.slice(0, 3);
  const hiddenCount = Math.max(0, files.length - visibleFiles.length);
  const expandable = isExpandableCard(card);
  const main = element("main", { className: "shell" });
  const section = element("section", { className: toolCardClassName(display) });
  const header = element("button", {
    className: "tool-header review-header",
    type: "button",
    ariaExpanded: String(expanded),
    disabled: !expandable,
  });

  if (expandable) {
    header.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
  }

  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.append(renderIcon(display.icon));
  const titleGroup = element("span", { className: "tool-main review-title-group" });

  titleGroup.append(element("span", { className: "tool-title", text: display.title }));
  if (display.label) {
    titleGroup.append(element("span", {
      className: "tool-label",
      text: display.label,
      title: display.label,
    }));
  }
  header.append(
    icon,
    titleGroup,
    renderHeaderSummary(card),
    renderChevron(expanded, expandable),
  );

  section.append(header);
  if (expanded) {
    const body = element("div", { className: "review-summary" });
    const payload = element("div", { className: "review-payload" });
    currentPayloadContainer = payload;
    body.append(payload);

    if (hiddenCount > 0) {
      const showMore = element("button", {
        className: "review-more",
        type: "button",
        text: `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`,
      });
      showMore.addEventListener("click", () => {
        reviewFilesExpanded = true;
        render();
      });
      body.append(showMore);
    }

    section.append(body);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
}

function renderChevron(isExpanded: boolean, visible: boolean): HTMLElement {
  const chevron = element("span", {
    className: visible ? `chevron ${isExpanded ? "expanded" : ""}` : "chevron",
    ariaHidden: "true",
  });

  if (visible) {
    chevron.append(renderIcon(toolIcons.chevronDown));
  }

  return chevron;
}

function toolCardClassName(display: ToolDisplay): string {
  return ["tool-card", display.tone, display.state ? `state-${display.state}` : undefined]
    .filter(Boolean)
    .join(" ");
}

function setPayloadLoading(container: HTMLElement, loading: boolean): void {
  const header = container.previousElementSibling;
  const chevron = header?.querySelector<HTMLElement>(".chevron");
  if (!chevron) return;

  chevron.classList.toggle("loading", loading);
  chevron.replaceChildren(
    renderIcon(loading ? toolIcons.loading : toolIcons.chevronDown),
  );

  const button = header instanceof HTMLButtonElement ? header : null;
  if (button) button.setAttribute("aria-busy", String(loading));
}

function renderWorkspacePayload(container: HTMLElement, card: ToolResultCard): void {
  unmountCurrentPayload();

  const details = element("div", {
    className: "workspace-details pretty-scrollbar",
  });
  const rows = element("div", { className: "workspace-rows" });
  const worktree = card.worktree;

  if (worktree) {
    const base = [
      worktree.baseRef,
      worktree.baseSha?.slice(0, 8),
    ].filter((value): value is string => Boolean(value));
    const baseLabel = base.join(" · ") || "Worktree";
    const baseContent = element("span", { className: "workspace-base-value" });
    baseContent.append(element("span", {
      className: "workspace-value",
      text: baseLabel,
      title: baseLabel,
    }));

    if (worktree.dirtySource) {
      const warning = element("span", {
        className: "workspace-base-warning",
        title: "The source checkout had uncommitted changes when this worktree was created. Those changes are not included here.",
        ariaLabel: "Source checkout changes are not included in this worktree",
      });
      warning.append(renderIcon(toolIcons.warning, "workspace-base-warning-svg"));
      baseContent.append(warning);
    }

    appendWorkspaceRow(rows, "Base", baseContent, toolIcons.base);
  }

  if (card.sourceRoot && card.sourceRoot !== card.root) {
    appendWorkspaceTextRow(
      rows,
      "Source checkout",
      card.sourceRoot,
      toolIcons.sourceCheckout,
      true,
    );
  }

  appendWorkspaceInstructions(
    rows,
    card.agentsFiles ?? [],
    card.availableAgentsFiles ?? [],
  );

  const skills = card.skills ?? [];
  if (skills.length > 0) {
    appendWorkspaceSkills(rows, skills);
  }

  const providers = card.agentProviders ?? [];
  const agents = card.agents ?? [];
  const agentChips: WorkspaceChip[] = agents.map((agent) => {
    const name = agent.name ?? "Unnamed agent";
    const providerName = agent.provider?.trim();
    const title = [
      agent.description,
      providerName ? `Provider: ${providerName}` : undefined,
      agent.model ? `Model: ${agent.model}` : undefined,
      agent.effort ? `Effort: ${agent.effort}` : undefined,
    ].filter((value): value is string => Boolean(value)).join("\n");
    return {
      label: name,
      logo: providerName ? getProviderLogo(providerName) : undefined,
      profile: true,
      title: title || undefined,
    };
  });
  const providerChips: WorkspaceChip[] = providers.map((provider) => {
    const name = provider.id?.trim() || "Unknown provider";
    const logo = getProviderLogo(name);
    const title = [
      provider.model ? `Model: ${provider.model}` : undefined,
      provider.effort ? `Effort: ${provider.effort}` : undefined,
      provider.note,
    ].filter((value): value is string => Boolean(value)).join("\n");
    return {
      label: name,
      logo,
      bareLogo: Boolean(logo),
      ariaLabel: name,
      title: title || name,
    };
  });

  if (agentChips.length > 0) {
    const chipList = renderWorkspaceChips([...agentChips, ...providerChips]);
    chipList.classList.add("workspace-agents-list");
    appendWorkspaceRow(rows, "Agents", chipList, toolIcons.agents, "workspace-agents-row");
  } else if (providerChips.length > 0) {
    appendWorkspaceChipRow(rows, "Providers", providerChips, toolIcons.providers);
  }

  if (rows.childElementCount > 0) details.append(rows);

  if (details.childElementCount === 0) {
    details.append(element("div", { className: "status muted", text: "No workspace details available." }));
  }

  container.replaceChildren(details);
}

interface WorkspaceChip {
  label: string;
  logo?: ProviderLogo;
  profile?: boolean;
  bareLogo?: boolean;
  ariaLabel?: string;
  title?: string;
  tone?: "muted";
}

interface WorkspaceInstruction {
  key: string;
  path?: string;
  label: string;
  content?: string;
  status: "loaded" | "available";
}

function appendWorkspaceInstructions(
  container: HTMLElement,
  loadedFiles: NonNullable<ToolResultCard["agentsFiles"]>,
  availableFiles: NonNullable<ToolResultCard["availableAgentsFiles"]>,
): void {
  const loaded: WorkspaceInstruction[] = [];
  const loadedPaths = new Set<string>();
  for (const [index, file] of loadedFiles.entries()) {
    loaded.push({
      key: `loaded:${index}`,
      path: file.path,
      label: file.path ?? "Loaded instructions",
      content: file.content,
      status: "loaded",
    });
    if (file.path) loadedPaths.add(file.path);
  }

  const available: WorkspaceInstruction[] = [];
  for (const [index, file] of availableFiles.entries()) {
    if (file.path && loadedPaths.has(file.path)) continue;
    available.push({
      key: `available:${index}`,
      path: file.path,
      label: file.path ?? "Nested instructions",
      status: "available",
    });
  }
  if (loaded.length === 0 && available.length === 0) return;

  const instructions = showAvailableWorkspaceInstructions
    ? [...loaded, ...available]
    : loaded;
  const list = renderWorkspaceInstructionList(instructions);

  if (available.length > 0) {
    const showAll = showAvailableWorkspaceInstructions;
    const toggle = element("button", {
      className: "workspace-instructions-toggle",
      type: "button",
      text: showAll ? "Show less" : "View all",
      ariaLabel: showAll
        ? "Show only loaded instruction files"
        : `View all ${available.length} available instruction files`,
      ariaExpanded: String(showAll),
    });
    toggle.addEventListener("click", () => {
      showAvailableWorkspaceInstructions = !showAvailableWorkspaceInstructions;
      if (!showAvailableWorkspaceInstructions) openWorkspaceInstructionKey = null;
      render();
    });
    list.append(toggle);
  }

  const content = element("div", { className: "workspace-instructions-content" });
  content.append(list);

  appendWorkspaceRow(
    container,
    "Instructions",
    content,
    toolIcons.instructions,
    "workspace-instructions-row",
  );
}

function renderWorkspaceInstructionList(
  instructions: WorkspaceInstruction[],
): HTMLElement {
  const list = element("span", { className: "workspace-instruction-list" });

  for (const instruction of instructions) {
    const item = element("span", { className: "workspace-instruction-item" });
    item.dataset.instructionKey = instruction.key;
    const hasContent = instruction.status === "loaded" && instruction.content !== undefined;
    const header = element(hasContent ? "button" : "span", {
      className: `workspace-instruction-header${hasContent ? " interactive" : ""}`,
      type: hasContent ? "button" : undefined,
      ariaLabel: hasContent ? `View ${instruction.label}` : undefined,
      ariaExpanded: hasContent ? "false" : undefined,
    });
    const text = element("span", { className: "workspace-instruction-text" });
    const basename = workspacePathBasename(instruction.label);
    text.append(element("span", {
      className: "workspace-instruction-name",
      text: basename,
    }));
    if (instruction.path && instruction.path !== basename) {
      text.append(element("span", {
        className: "workspace-instruction-path",
        text: instruction.path,
        title: instruction.path,
      }));
    }

    header.append(
      renderWorkspaceInstructionStatus(instruction.status),
      text,
    );

    if (hasContent) {
      const chevron = element("span", {
        className: "workspace-instruction-chevron",
        ariaHidden: "true",
      });
      chevron.append(renderIcon(toolIcons.chevronDown, "workspace-instruction-chevron-svg"));
      header.append(chevron);
      header.addEventListener("click", () => {
        openWorkspaceInstructionKey = openWorkspaceInstructionKey === instruction.key
          ? null
          : instruction.key;
        syncWorkspaceInstructionPreviews(list);
      });

      const preview = element("pre", {
        className: "workspace-instruction-preview pretty-scrollbar",
        text: instruction.content,
      });
      preview.hidden = true;
      item.append(header, preview);
    } else {
      item.append(header);
    }

    list.append(item);
  }

  syncWorkspaceInstructionPreviews(list);
  return list;
}

function syncWorkspaceInstructionPreviews(list: HTMLElement): void {
  for (const item of list.querySelectorAll<HTMLElement>(".workspace-instruction-item")) {
    const isOpen = item.dataset.instructionKey === openWorkspaceInstructionKey;
    item.classList.toggle("expanded", isOpen);
    const header = item.querySelector<HTMLElement>(".workspace-instruction-header.interactive");
    header?.setAttribute("aria-expanded", String(isOpen));
    const preview = item.querySelector<HTMLElement>(".workspace-instruction-preview");
    if (preview) preview.hidden = !isOpen;
  }
}

function renderWorkspaceInstructionStatus(
  status: WorkspaceInstruction["status"],
): HTMLElement {
  const label = instructionStatusLabel(status);
  const wrapper = element("span", {
    className: `workspace-instruction-status ${status}`,
    title: label,
    ariaLabel: label,
  });
  wrapper.setAttribute("role", "img");
  wrapper.append(renderIcon(
    status === "loaded" ? toolIcons.instructionLoaded : toolIcons.instructionAvailable,
    "workspace-instruction-status-svg",
  ));
  return wrapper;
}

function instructionStatusLabel(status: WorkspaceInstruction["status"]): string {
  return status === "loaded"
    ? "Loaded into the current workspace context"
    : "Available for a nested directory";
}

function workspacePathBasename(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function appendWorkspaceTextRow(
  container: HTMLElement,
  label: string,
  value: string,
  icon: ToolIcon,
  mono = false,
): void {
  const content = element("span", {
    className: `workspace-value${mono ? " mono" : ""}`,
    text: value,
    title: value,
  });
  appendWorkspaceRow(container, label, content, icon);
}

function appendWorkspaceChipRow(
  container: HTMLElement,
  label: string,
  chips: WorkspaceChip[],
  icon: ToolIcon,
): void {
  appendWorkspaceRow(container, label, renderWorkspaceChips(chips), icon);
}

function appendWorkspaceRow(
  container: HTMLElement,
  label: string,
  content: HTMLElement,
  icon: ToolIcon,
  rowClassName?: string,
): void {
  const row = element("div", {
    className: ["workspace-row", rowClassName].filter(Boolean).join(" "),
  });
  row.append(
    renderWorkspaceRowIcon(icon),
    element("span", { className: "workspace-key", text: label }),
    content,
  );
  container.append(row);
}

function appendWorkspaceSkills(
  container: HTMLElement,
  skills: NonNullable<ToolResultCard["skills"]>,
): void {
  const skillChips = skills.map((skill) => ({
    label: skill.name ?? skill.path ?? "Unnamed skill",
    title: [skill.path, skill.description].filter(Boolean).join("\n\n") || undefined,
  }));

  const chipList = renderWorkspaceChips(skillChips);
  chipList.classList.add("workspace-skills-list");
  appendWorkspaceRow(container, "Skills", chipList, toolIcons.skills, "workspace-skills-row");
}

function renderWorkspaceRowIcon(icon: ToolIcon): HTMLElement {
  const wrapper = element("span", {
    className: "workspace-row-icon",
    ariaHidden: "true",
  });
  wrapper.append(renderIcon(icon, "workspace-row-icon-svg"));
  return wrapper;
}

function renderWorkspaceChips(chips: WorkspaceChip[]): HTMLElement {
  const list = element("span", { className: "workspace-chip-list" });
  for (const chip of chips) {
    const bareLogo = Boolean(chip.bareLogo && chip.logo);
    const item = element("span", {
      className: [
        bareLogo
          ? "workspace-provider-logo"
          : chip.profile
          ? "workspace-agent-profile"
          : "workspace-chip",
        chip.tone,
      ].filter(Boolean).join(" "),
      title: chip.title,
    });
    if (bareLogo) {
      item.setAttribute("role", "img");
      item.setAttribute("aria-label", chip.ariaLabel ?? chip.label);
    }
    if (chip.logo) {
      const baseClassName = bareLogo
        ? "workspace-provider-logo-image"
        : chip.profile
        ? "workspace-agent-profile-logo"
        : "workspace-chip-logo";
      const logoSources: Array<{ src: string; theme?: "light" | "dark" }> =
        chip.logo.light === chip.logo.dark
          ? [{ src: chip.logo.light }]
          : [
              { src: chip.logo.light, theme: "light" },
              { src: chip.logo.dark, theme: "dark" },
            ];
      for (const source of logoSources) {
        const logo = document.createElement("img");
        logo.className = [
          baseClassName,
          chip.logo.invertInLight
            ? "workspace-provider-logo-invert-in-light"
            : undefined,
          source.theme ? `workspace-provider-logo-theme-${source.theme}` : undefined,
        ].filter(Boolean).join(" ");
        logo.src = source.src;
        logo.alt = "";
        logo.setAttribute("aria-hidden", "true");
        item.append(logo);
      }
    }
    if (!bareLogo) {
      item.append(element("span", { className: "workspace-chip-label", text: chip.label }));
    }
    list.append(item);
  }
  return list;
}

function toolNameFromMeta(result: CallToolResult): ToolName | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const tool = meta?.tool;
  return isToolName(tool) ? tool : undefined;
}

function cardFromMeta(result: CallToolResult): Partial<ToolResultCard> | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const metaCard = meta?.card;
  return metaCard && typeof metaCard === "object" ? metaCard : undefined;
}

function getStructuredContent<T>(result: CallToolResult): T | undefined {
  return result.structuredContent as T | undefined;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    type?: string;
    title?: string;
    ariaHidden?: string;
    ariaLabel?: string;
    ariaExpanded?: string;
    disabled?: boolean;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type !== undefined && "type" in node) node.setAttribute("type", options.type);
  if (options.title !== undefined) node.title = options.title;
  if (options.ariaHidden !== undefined) node.setAttribute("aria-hidden", options.ariaHidden);
  if (options.ariaLabel !== undefined) node.setAttribute("aria-label", options.ariaLabel);
  if (options.ariaExpanded !== undefined) node.setAttribute("aria-expanded", options.ariaExpanded);
  if (options.disabled !== undefined && "disabled" in node) {
    (node as HTMLButtonElement).disabled = options.disabled;
  }
  return node;
}
