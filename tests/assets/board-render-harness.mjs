// Render a built bearings board's shipped inline script under a minimal DOM
// shim and print what the renderer actually produced, so board behavior is
// asserted through the real template rather than by reading its source.
//
// Usage: node board-render-harness.mjs <built-board.html>
// Prints one JSON document:
//   { stats:[{n,label}], underway:[{title,sub,badges,ref}],
//     landed:[{title,sub,badges,ref}], charted:[{title,sub,badges,pickable,ref}],
//     copied, copyMethods, empty, more, error }
import { readFileSync } from "node:fs";

const html = readFileSync(process.argv[2], "utf8");
let selectedCopyField = null;

class Node {
  constructor(tag) {
    this.tagName = tag;
    this.className = "";
    this.children = [];
    this.attributes = {};
    this._text = "";
    this.hidden = false;
    this.disabled = false;
    this.innerHTML = "";
    this.parentNode = null;
    this.type = "";
    this.value = "";
    this.checked = false;
    this.style = {};
    this.listeners = {};
    this.classList = {
      add: (c) => { this.className = (this.className + " " + c).trim(); },
      contains: (c) => this.className.split(/\s+/).includes(c),
    };
  }
  get textContent() {
    return this.children.length
      ? this.children.map((c) => c.textContent).join("")
      : this._text;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(n) { n.parentNode = this; this.children.push(n); return n; }
  removeChild(n) { this.children = this.children.filter((c) => c !== n); n.parentNode = null; return n; }
  setAttribute(k, v) { this.attributes[k] = v; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { (this.listeners.click || []).forEach((fn) => fn({ preventDefault() {} })); }
  select() { selectedCopyField = this; }
  querySelectorAll(sel) {
    const want = sel.replace(/^\./, "").replace(/:checked$/, "");
    const checkedOnly = sel.endsWith(":checked");
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.className.split(/\s+/).includes(want) && (!checkedOnly || c.checked)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

const byId = new Map();
const body = new Node("body");
const copied = [];
const copyMethods = [];
const dataNode = new Node("script");
dataNode.textContent = html
  .split('<script id="bearings-data" type="application/json">')[1]
  .split("</script>")[0];
byId.set("bearings-data", dataNode);

globalThis.document = {
  body,
  createElement: (tag) => new Node(tag),
  execCommand: (command) => {
    if (command !== "copy" || !selectedCopyField) return false;
    copied.push(selectedCopyField.value);
    copyMethods.push("fallback");
    return true;
  },
  // Lazily mint any element the page asks for: the shim tracks whatever ids
  // the shipped template actually uses instead of pinning a fixed list.
  getElementById: (id) => {
    if (!byId.has(id)) {
      const n = new Node("div");
      new Node("div").appendChild(n);
      byId.set(id, n);
    }
    return byId.get(id);
  },
  querySelector: (sel) => {
    const id = "sel:" + sel;
    if (!byId.has(id)) byId.set(id, new Node("div"));
    return byId.get(id);
  },
};
globalThis.window = {};
globalThis.TextEncoder = TextEncoder;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { clipboard: { writeText: (text) => {
    // Force the Windows-path row through the legacy branch that keeps copy
    // working when the HTTP origin does not expose the Clipboard API.
    if (text.startsWith("fm-reports\\")) return Promise.reject(new Error("clipboard unavailable"));
    copied.push(text);
    copyMethods.push("clipboard");
    return Promise.resolve();
  } } },
});

const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
new Function(script)();

const badgesOf = (row) =>
  row.children
    .filter((c) => c.className.includes("fm-badge"))
    .map((c) => ({ tone: c.className.replace(/.*fm-badge--/, "").trim(), text: c.textContent }));

const strip = byId.get("bb-stats") || new Node("div");
const stats = strip.children.map((t) => ({
  n: Number(t.children.find((c) => c.className.includes("bb-stat__num"))?.textContent),
  label: t.children.find((c) => c.className.includes("bb-stat__label"))?.textContent,
}));

const rowsOf = (container) =>
  container.children
    .filter((r) => r.className.split(/\s+/).includes("bb-row"))
    .map((row) => {
      const main = row.children.find((c) => c.className.includes("bb-row__main"));
      return {
        title: main?.children.find((c) => c.className.includes("bb-row__title"))?.textContent ?? "",
        sub: main?.children.find((c) => c.className.includes("bb-row__sub"))?.textContent ?? "",
        badges: badgesOf(row),
        pickable: row.children.some((c) => c.className.includes("bb-pick") && !c.className.includes("spacer")),
        pr: (() => {
          const link = row.children.find((c) => c.className.includes("bb-row__pr"));
          return link ? { text: link.textContent, href: link.href } : null;
        })(),
        ref: (() => {
          const control = row.children.find((c) => c.className.includes("bb-row__ref"));
          if (!control) return null;
          const text = control.children.find((c) => c.className.includes("bb-row__ref-text"));
          const button = control.children.find((c) => c.className.includes("bb-row__copy"));
          return { text: text?.textContent ?? "", title: text?.title ?? "", button: button?.textContent ?? "" };
        })(),
      };
    });

const uw = byId.get("bb-underway") || new Node("div");
const underway = rowsOf(uw);

const ld = byId.get("bb-landed") || new Node("div");
const landed = rowsOf(ld);

const ch = byId.get("bb-charted") || new Node("div");
const charted = rowsOf(ch);
for (const container of [uw, ld, ch]) {
  for (const row of container.children) {
    row.children
      .flatMap((child) => child.className.includes("bb-row__ref") ? child.children : [])
      .filter((child) => child.className.includes("bb-row__copy"))
      .forEach((button) => button.click());
  }
}
await Promise.resolve();
await Promise.resolve();
// A fail-closed render replaces the page body instead of the board sections, so
// surface it rather than reporting an empty board as a successful render.
const errorText = [...byId.entries()]
  .filter(([k]) => k.startsWith("sel:"))
  .flatMap(([, n]) => n.children.map((c) => c.textContent))
  .join(" ");
const empty = ch.children.filter((c) => c.className.includes("bb-empty")).map((c) => c.textContent);
const more = ch.children.filter((c) => c.className.includes("bb-morechip")).map((c) => c.textContent);

process.stdout.write(
  JSON.stringify({ stats, underway, landed, charted, copied, copyMethods, empty, more, error: errorText }) + "\n");
