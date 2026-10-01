import type {
  ExtensionAPI,
  ExtensionContext,
  ModelSelectEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

type ExtensionEvent = SessionStartEvent | ModelSelectEvent;
type ExtensionHandler = (
  event: ExtensionEvent,
  ctx: ExtensionContext,
) => Promise<unknown> | unknown;
type ExtensionFactory = (pi: ExtensionAPI) => Promise<void> | void;
type FactoryImporter = () => Promise<ExtensionFactory>;

type CapturedRegistrations = {
  handlers: Map<string, ExtensionHandler[]>;
  shortcuts: Map<
    string,
    { handler: (ctx: ExtensionContext) => Promise<void> | void }
  >;
};

const codexExtensionUrl = new URL(
  "../npm/node_modules/@howaboua/pi-codex-conversion/dist/index.js",
  import.meta.url,
).href;

async function importCodexFactory() {
  const extensionModule = await import(codexExtensionUrl);
  if (typeof extensionModule.default !== "function") {
    throw new Error("Codex conversion package has no default extension factory");
  }
  return extensionModule.default as ExtensionFactory;
}

export function isCodexLikeModel(
  model: { provider?: string; api?: string; id?: string } | undefined,
) {
  if (!model) return false;
  const provider = (model.provider ?? "").toLowerCase();
  const api = (model.api ?? "").toLowerCase();
  const id = (model.id ?? "").toLowerCase();
  const copilotGpt =
    (provider.includes("copilot") || api.includes("copilot")) &&
    id.includes("gpt");
  return (
    provider.includes("codex") ||
    api.includes("codex") ||
    id.includes("codex") ||
    (provider.includes("openai") && id.includes("gpt")) ||
    copilotGpt
  );
}

function captureRegistrations(pi: ExtensionAPI) {
  const handlers = new Map<string, ExtensionHandler[]>();
  const shortcuts = new Map<
    string,
    { handler: (ctx: ExtensionContext) => Promise<void> | void }
  >();
  const proxy = new Proxy(pi, {
    get(target, property) {
      if (property === "on") {
        return (event: string, handler: ExtensionHandler) => {
          const eventHandlers = handlers.get(event) ?? [];
          eventHandlers.push(handler);
          handlers.set(event, eventHandlers);
          return pi.on(event as never, handler as never);
        };
      }
      if (property === "registerShortcut") {
        return (
          shortcut: string,
          options: { handler: (ctx: ExtensionContext) => Promise<void> | void },
        ) => {
          shortcuts.set(shortcut, options);
          pi.registerShortcut(shortcut as never, options);
        };
      }
      return Reflect.get(target, property, target);
    },
  });
  return { handlers, shortcuts, proxy };
}

async function replayHandlers(
  registrations: CapturedRegistrations,
  event: ExtensionEvent,
  ctx: ExtensionContext,
) {
  for (const handler of registrations.handlers.get(event.type) ?? []) {
    await handler(event, ctx);
  }
}

export function createConditionalCodexExtension(
  importFactory: FactoryImporter = importCodexFactory,
) {
  return function conditionalCodexExtension(pi: ExtensionAPI) {
    let loaded = false;
    let loading: Promise<CapturedRegistrations> | undefined;
    let currentSessionStart: SessionStartEvent | undefined;
    let bridgeShortcuts = false;
    let removeShortcutBridge: (() => void) | undefined;

    const installShortcutBridge = async (
      registrations: CapturedRegistrations,
      ctx: ExtensionContext,
    ) => {
      if (!bridgeShortcuts || ctx.mode !== "tui") return;
      const { matchesKey } = await import("@earendil-works/pi-tui");
      removeShortcutBridge?.();
      removeShortcutBridge = ctx.ui.onTerminalInput((data) => {
        for (const [shortcut, options] of registrations.shortcuts) {
          if (!matchesKey(data, shortcut as never)) continue;
          void Promise.resolve(options.handler(ctx)).catch((error) => {
            ctx.ui.notify(
              `Codex shortcut failed: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          });
          return { consume: true };
        }
        return undefined;
      });
    };

    const load = () => {
      loading ??= (async () => {
        const factory = await importFactory();
        const { handlers, shortcuts, proxy } = captureRegistrations(pi);
        await factory(proxy);
        loaded = true;
        return { handlers, shortcuts };
      })().catch((error) => {
        loading = undefined;
        throw error;
      });
      return loading;
    };

    pi.on("session_start", async (event, ctx) => {
      currentSessionStart = event;
      if (loaded) {
        if (loading) await installShortcutBridge(await loading, ctx);
        return;
      }
      if (!isCodexLikeModel(ctx.model)) return;
      const registrations = await load();
      await replayHandlers(registrations, event, ctx);
    });

    pi.on("model_select", async (event, ctx) => {
      if (loaded || !isCodexLikeModel(event.model)) return;
      const registrations = await load();
      bridgeShortcuts = true;
      await installShortcutBridge(registrations, ctx);
      await replayHandlers(
        registrations,
        currentSessionStart ?? { type: "session_start", reason: "startup" },
        ctx,
      );
      await replayHandlers(registrations, event, ctx);
    });

    pi.on("session_shutdown", () => {
      removeShortcutBridge?.();
      removeShortcutBridge = undefined;
    });
  };
}

export default createConditionalCodexExtension();
