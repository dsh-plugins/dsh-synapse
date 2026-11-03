import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);

async function factory(file) {
  let loaded;
  const browser = globalThis.window ?? {};
  browser.__ModuleLoader__ = { load: (module) => { loaded = module.factory; } };
  const sandbox = { window: browser, document: browser.document, navigator: browser.navigator,
    console, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, AbortSignal,
    HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, SVGElement: browser.SVGElement,
    Document: browser.Document, ShadowRoot: browser.ShadowRoot, HTMLInputElement: browser.HTMLInputElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement, Event: browser.Event, MouseEvent: browser.MouseEvent,
    HTMLIFrameElement: browser.HTMLIFrameElement,
    KeyboardEvent: browser.KeyboardEvent, FocusEvent: browser.FocusEvent, performance: globalThis.performance,
    MutationObserver: browser.MutationObserver, ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: browser.requestAnimationFrame?.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame?.bind(browser),
    getComputedStyle: browser.getComputedStyle?.bind(browser), URL, URLSearchParams,
  };
  vm.runInNewContext(await readFile(file, "utf8"), sandbox);
  return loaded;
}

export async function loadClient({ realFacade = false } = {}) {
  const facade = realFacade
    ? (await factory(new URL("../../node_modules/@dsh-plugin/dsh-loader/lib/client.js", import.meta.url)))(name => name === "@deepseek-ai/dsh-client-ui-primitives" ? { Menu: () => null } : require(name))
    : { Arco: {} };
  const plugin = (await factory(new URL("../../lib/client.js", import.meta.url)))(name => name === "@dsh-plugin/dsh-loader/client" ? facade : require(name));
  const dialogs = [], panels = [];
  plugin.apply({ dshLoaderUi: { config: {
    registerDialog: (_owner, options) => dialogs.push(options),
    registerPanel: (_owner, options) => panels.push(options),
  } } });
  return { dialogs, panels, facade };
}
