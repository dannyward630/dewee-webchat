// Small, safe Markdown renderer: builds DOM nodes directly (never innerHTML), so agent
// output cannot inject markup. Supports headings, paragraphs, lists, blockquotes, fenced
// code, tables, hr, bold/italic/strike, inline code, links and autolinks.

type Doc = Document;

function el<K extends keyof HTMLElementTagNameMap>(doc: Doc, tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:|mailto:|tel:)/i.test(u)) return u;
  if (/^[/#?]/.test(u) && !u.startsWith("//")) return u;
  return null;
}

const INLINE_SRC = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/;

export function renderInline(doc: Doc, text: string, parent: Node): void {
  // fresh regex per call: renderInline recurses, and a shared /g lastIndex would loop forever
  const re = new RegExp(INLINE_SRC.source, "g");
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (m.index > last) parent.appendChild(doc.createTextNode(text.slice(last, m.index)));
    last = m.index + m[0].length;
    if (m[2] !== undefined) {
      const c = el(doc, "code");
      c.textContent = m[2];
      parent.appendChild(c);
    } else if (m[3] !== undefined || m[4] !== undefined) {
      const s = el(doc, "strong");
      renderInline(doc, m[3] ?? m[4], s);
      parent.appendChild(s);
    } else if (m[5] !== undefined) {
      const s = el(doc, "del");
      renderInline(doc, m[5], s);
      parent.appendChild(s);
    } else if (m[6] !== undefined || m[7] !== undefined) {
      const s = el(doc, "em");
      renderInline(doc, m[6] ?? m[7], s);
      parent.appendChild(s);
    } else if (m[8] !== undefined) {
      const href = safeHref(m[9]);
      if (href) {
        const a = el(doc, "a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
        renderInline(doc, m[8], a);
        parent.appendChild(a);
      } else parent.appendChild(doc.createTextNode(m[8]));
    } else if (m[10] !== undefined) {
      const a = el(doc, "a");
      a.href = m[10];
      a.target = "_blank";
      a.rel = "noopener noreferrer nofollow";
      a.textContent = m[10];
      parent.appendChild(a);
    }
  }
  if (last < text.length) parent.appendChild(doc.createTextNode(text.slice(last)));
}

const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const splitRow = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export function renderMarkdown(doc: Doc, src: string): DocumentFragment {
  const frag = doc.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      const pre = el(doc, "pre");
      const code = el(doc, "code");
      if (fence[2]) code.dataset.lang = fence[2];
      code.textContent = body.join("\n");
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const tag = (`h${Math.min(6, h[1].length + 2)}`) as "h3";
      const e = el(doc, tag);
      renderInline(doc, h[2], e);
      frag.appendChild(e);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { frag.appendChild(el(doc, "hr")); i++; continue; }

    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const wrap = el(doc, "div", "table");
      const table = el(doc, "table");
      const thead = el(doc, "thead");
      const tr = el(doc, "tr");
      for (const c of splitRow(line)) { const th = el(doc, "th"); renderInline(doc, c, th); tr.appendChild(th); }
      thead.appendChild(tr);
      table.appendChild(thead);
      const tbody = el(doc, "tbody");
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        const r = el(doc, "tr");
        for (const c of splitRow(lines[i])) { const td = el(doc, "td"); renderInline(doc, c, td); r.appendChild(td); }
        tbody.appendChild(r);
        i++;
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      frag.appendChild(wrap);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      const q = el(doc, "blockquote");
      q.appendChild(renderMarkdown(doc, body.join("\n")));
      frag.appendChild(q);
      continue;
    }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const list = el(doc, ordered ? "ol" : "ul");
      if (ordered && parseInt(li[2], 10) !== 1) list.setAttribute("start", String(parseInt(li[2], 10)));
      const baseIndent = li[1].length;
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m || m[1].length < baseIndent || /\d/.test(m[2]) !== ordered) break;
        if (m[1].length > baseIndent) {
          // nested list: collect deeper lines and render recursively into the last item
          const sub: string[] = [];
          while (i < lines.length && (/^\s+/.test(lines[i]) && (lines[i].match(/^(\s*)/)![1].length > baseIndent))) sub.push(lines[i++].slice(baseIndent + 2));
          list.lastElementChild?.appendChild(renderMarkdown(doc, sub.join("\n")));
          continue;
        }
        const item = el(doc, "li");
        renderInline(doc, m[3], item);
        list.appendChild(item);
        i++;
      }
      frag.appendChild(list);
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]); // always advance, even on odd lines
    const p = el(doc, "p");
    para.forEach((l, idx) => {
      if (idx) p.appendChild(el(doc, "br"));
      renderInline(doc, l, p);
    });
    frag.appendChild(p);
  }
  return frag;
}
