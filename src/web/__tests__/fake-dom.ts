// Minimal DOM stand-in for running the page's own inline scripts in node:vm (no DOM library dependency).
// Implements only what those scripts use: elements with children, textContent, className, dataset, disabled,
// append/prepend/remove, value/hidden/title, event listeners; document events, createElement, getElementById and
// registered selectors.
import * as vm from "node:vm";
export interface FakeEvent {
  type: string;
  detail?: unknown;
}
type Listener = (event: FakeEvent) => void;

export class FakeElement {
  className = "";
  readonly dataset: Record<string, string> = {};
  disabled = false;
  hidden = false;
  title = "";
  value = "";
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  id = "";
  private text = "";
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.children.length > 0 ? this.text + this.children.map((c) => c.textContent).join("") : this.text;
  }
  set textContent(value: string) {
    for (const c of this.children) c.parent = null;
    this.children.length = 0;
    this.text = String(value);
  }
  private adopt(node: FakeElement | string): FakeElement {
    const el = typeof node === "string" ? Object.assign(new FakeElement("#text"), { text: node }) : node;
    if (el.parent !== null) el.remove();
    el.parent = this;
    return el;
  }
  append(...nodes: Array<FakeElement | string>): void {
    for (const n of nodes) this.children.push(this.adopt(n));
  }
  prepend(...nodes: Array<FakeElement | string>): void {
    this.children.unshift(...nodes.map((n) => this.adopt(n)));
  }
  remove(): void {
    if (this.parent === null) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  /** Fires `type` on this element (for input/change events the page listens to). */
  dispatch(type: string, detail?: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, detail });
  }
  /** Like a user click: ignored while disabled, as in a real browser. */
  click(): void {
    if (this.disabled) return;
    for (const fn of this.listeners.get("click") ?? []) fn({ type: "click" });
  }
}

export class FakeDocument {
  private readonly byId = new Map<string, FakeElement>();
  /** Results for querySelectorAll, keyed by the exact selector string the script uses. */
  readonly selectors = new Map<string, FakeElement[]>();
  private readonly listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  dispatchEvent(event: FakeEvent): boolean {
    for (const fn of this.listeners.get(event.type) ?? []) fn(event);
    return true;
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
  /** Creates an element registered under `id`. */
  element(tag: string, id: string): FakeElement {
    const el = new FakeElement(tag);
    el.id = id;
    this.byId.set(id, el);
    return el;
  }
  getElementById(id: string): FakeElement | null {
    return this.byId.get(id) ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.selectors.get(selector) ?? [];
  }
}

/** Runs an inline page script in a fresh vm context with the given globals; returns the script's completion value. */
export function runInlineScript(source: string, globals: Record<string, unknown>): unknown {
  const context = vm.createContext({
    AbortController,
    DOMException,
    TextDecoder,
    TextEncoder,
    Date,
    Math,
    JSON,
    String,
    Number,
    Array,
    Object,
    Promise,
    Error,
    TypeError,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ...globals,
  });
  return new vm.Script(source, { filename: "inline-page-script.js" }).runInContext(context);
}
