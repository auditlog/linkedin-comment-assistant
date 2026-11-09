// LinkedIn structure probe for fixing selectors (run in the DevTools console of the
// LinkedIn tab, with the cursor in the comment or message box that does not work).
// Output is an anonymized skeleton: tags, ids, classes, roles, data-* attribute NAMES and
// data-testid values (component ids, not personal data). Text is replaced by its length,
// links and other attribute values are dropped, so no message content or names leave
// the page. Iframes: their address without query string, and the probe follows the
// cursor into same-origin iframes (LinkedIn messaging runs in one, 2026-11).
// The result is copied to the clipboard with the DevTools copy() helper.
// See also: README, "Gdy wtyczka źle odczytuje stronę"; src/content/linkedin-messaging.js.
(() => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'SVG', 'PATH', 'IMG', 'VIDEO', 'NOSCRIPT', 'TEMPLATE']);
  const ATTRS = ['role', 'contenteditable', 'aria-multiline', 'type'];
  const MAX_LINES = 1500;
  const out = [];

  // Path with id-like segments (containing digits, 8+ chars) masked; words stay readable.
  const maskPath = (path) => path.split('/').map((seg) => (seg.length >= 8 && /\d/.test(seg) ? '…' : seg)).join('/');

  // Address of an iframe without query string or hash; ids masked.
  const frameAddress = (frame) => {
    const raw = frame.getAttribute('src');
    if (!raw) return frame.hasAttribute('srcdoc') ? 'srcdoc' : 'none';
    try {
      const url = new URL(raw, location.href);
      return `${url.origin}${maskPath(url.pathname)}`;
    } catch {
      return 'unparsable';
    }
  };

  const describe = (el) => {
    if (!el || el.nodeType !== 1) return String(el && el.nodeName);
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    if (el.classList.length) s += `.${[...el.classList].join('.')}`;
    for (const name of ATTRS) if (el.hasAttribute(name)) s += `[${name}="${el.getAttribute(name)}"]`;
    const dataNames = [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('data-'));
    if (dataNames.length) s += ` data:{${dataNames.join(',')}}`;
    if (el.hasAttribute('data-testid')) s += ` testid="${el.getAttribute('data-testid')}"`;
    if (el.hasAttribute('href')) s += ' [href]';
    if (el.shadowRoot) s += ' {shadow-root}';
    if (el.tagName === 'IFRAME') s += ` {iframe src=${frameAddress(el)}}`;
    return s;
  };

  out.push(`frame: ${window === window.top ? 'top' : 'IFRAME'}`);
  out.push(`path: ${maskPath(location.pathname)}`);

  // Focused element, descending into open shadow roots and same-origin iframes.
  let el = document.activeElement;
  for (let guard = 0; el && guard < 10; guard++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) {
      out.push(`shadow host: ${describe(el)}`);
      el = el.shadowRoot.activeElement;
      continue;
    }
    if (el.tagName === 'IFRAME') {
      let inner = null;
      try {
        inner = el.contentDocument;
      } catch {
        inner = null;
      }
      if (!inner) {
        out.push(`iframe is cross-origin: ${describe(el)}. Select it in the console context menu ("top") and run again.`);
        break;
      }
      out.push(`enter iframe: ${describe(el)}`);
      el = inner.activeElement;
      continue;
    }
    break;
  }
  out.push(`focused: ${describe(el)}`);
  out.push('ancestors (focused -> body):');
  const body = el && el.ownerDocument ? el.ownerDocument.body : document.body;
  for (let n = el; n; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) {
    out.push(`  ${describe(n)}`);
    if (n === body) break;
  }

  // Skeleton of the nearest ancestor that holds a list (the message list or the post),
  // limited to 8 levels above the focused element.
  let pane = el;
  for (let i = 0; pane && pane !== body && i < 8; i++) {
    if (pane.querySelectorAll('li').length >= 3) break;
    pane = pane.parentElement;
  }
  out.push(`pane: ${describe(pane)}`);
  const walk = (node, depth) => {
    if (depth > 16 || out.length > MAX_LINES) return;
    for (const child of node.children) {
      if (SKIP.has(child.tagName)) continue;
      const lengths = [...child.childNodes]
        .filter((t) => t.nodeType === 3 && t.textContent.trim())
        .map((t) => t.textContent.trim().length);
      out.push(`${'  '.repeat(depth)}${describe(child)}${lengths.length ? `  «text ${lengths.join('+')} chars»` : ''}`);
      walk(child.shadowRoot || child, depth + 1);
    }
  };
  if (pane) walk(pane, 1);
  if (out.length > MAX_LINES) out.push('… (truncated)');

  const result = out.join('\n');
  if (typeof copy === 'function') copy(result);
  console.log(`LinkedIn probe: ${out.length} lines${typeof copy === 'function' ? ' copied to the clipboard' : ''}.`);
  return result;
})();
