/**
 * Renders a Google Docs export as a clean page. Two docs use this:
 * home-unit-information.html (`/doc`) and prospect-management-workflow.html
 * (`/workflow`).
 *
 * The export is machine-generated: every element carries a generated class, bold/italic
 * live in the stylesheet rather than in tags, list nesting is flattened into sibling
 * <ol> elements whose depth is encoded in a `lst-kix_<id>-<depth>` class, and links are
 * wrapped in Google redirect URLs. This module reads that structure back out and emits
 * semantic HTML, so re-exporting a doc over its file keeps the page current.
 *
 * The two exports don't agree on heading levels — one puts its title in an <h1>
 * and its sections in <h2>, the other has no <h2> at all and uses <h1> for
 * sections — so the section level is detected per document rather than assumed.
 */

export type Section = { id: string; title: string; subtitle: string; html: string };

const decode = (s: string) =>
  s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const slug = (s: string) =>
  s.toLowerCase().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/**
 * Classes the export uses for bold / italic runs, and for the boxed callouts a
 * doc draws with a shaded, bordered paragraph — the workflow doc uses one for
 * the message you actually send a prospect, which deserves to stay a box rather
 * than flatten into another paragraph.
 */
function styleClasses(css: string) {
  const bold = new Set<string>(), italic = new Set<string>(), callout = new Set<string>();
  for (const m of css.matchAll(/\.(c\d+)\{([^}]*)\}/g)) {
    if (/font-weight:\s*700/.test(m[2])) bold.add(m[1]);
    if (/font-style:\s*italic/.test(m[2])) italic.add(m[1]);
    if (/background-color:#(?!ffffff)[0-9a-f]{6}/i.test(m[2]) && /border-\w+-style:\s*solid/.test(m[2])) {
      callout.add(m[1]);
    }
  }
  return { bold, italic, callout };
}

/** Finds the block element starting at or after `pos`, returning its full source. */
function nextBlock(html: string, pos: number) {
  const open = /<(h1|h2|h3|p|ol|ul|table)\b[^>]*>/gi;
  open.lastIndex = pos;
  const start = open.exec(html);
  if (!start) return null;
  const tag = start[1].toLowerCase();
  // Walk forward counting same-tag opens so nested elements don't end the block early.
  const scan = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, "gi");
  scan.lastIndex = start.index;
  let depth = 0, end = html.length;
  for (let m = scan.exec(html); m; m = scan.exec(html)) {
    depth += m[0][1] === "/" ? -1 : 1;
    if (depth === 0) { end = m.index + m[0].length; break; }
  }
  return { tag, attrs: start[0], inner: html.slice(start.index + start[0].length, end).replace(/<\/\w+>$/, ""), source: html.slice(start.index, end), end };
}

/** Unwraps spans into <strong>/<em>, unwraps Google's link redirector, drops classes. */
function inline(html: string, styles: ReturnType<typeof styleClasses>): string {
  let out = html
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>/gi, (_m, href: string) => {
      let url = decode(href);
      const redirect = url.match(/^https:\/\/www\.google\.com\/url\?q=([^&]+)/);
      if (redirect) url = decodeURIComponent(redirect[1]);
      const external = /^https?:/.test(url);
      return `<a href="${escapeHtml(url)}"${external ? ' target="_blank" rel="noopener"' : ""}>`;
    })
    .replace(/<span class="([^"]*)">([\s\S]*?)<\/span>/gi, (_m, cls: string, body: string) => {
      const classes = cls.split(/\s+/);
      if (classes.some((c) => styles.bold.has(c))) return `<strong>${body}</strong>`;
      if (classes.some((c) => styles.italic.has(c))) return `<em>${body}</em>`;
      return body;
    })
    .replace(/<span[^>]*>|<\/span>/gi, "")
    .replace(/\s(class|id|style)="[^"]*"/gi, "");
  // Bare URLs read better as their domain + path than as a wall of query string.
  out = out.replace(/>(https?:\/\/[^<]+)</g, (_m, url: string) => {
    const pretty = url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
    return `>${pretty.length > 60 ? pretty.slice(0, 57) + "…" : pretty}<`;
  });
  return out.replace(/\s+/g, " ").trim();
}

const textOf = (html: string) => decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/**
 * Rebuilds the flattened `<ol class="lst-kix_x-N">` runs into real nested lists.
 * Items arrive in document order tagged with their depth; we grow a tree, then
 * serialize it, which keeps the markup balanced however the depths jump around.
 */
type Node = { html: string; children: Node[] };

class ListBuilder {
  private roots: Node[] = [];
  private path: Node[] = [];   // path[i] = the node currently open at depth i

  push(level: number, items: string[]) {
    for (const html of items) {
      const depth = Math.min(level, this.path.length);   // a skipped level just nests one deeper
      const node: Node = { html, children: [] };
      const siblings = depth === 0 ? this.roots : this.path[depth - 1].children;
      siblings.push(node);
      this.path.length = depth;
      this.path.push(node);
    }
  }

  private static serialize(nodes: Node[]): string {
    return `<ul>${nodes
      .map((n) => `<li>${n.html}${n.children.length ? ListBuilder.serialize(n.children) : ""}</li>`)
      .join("")}</ul>`;
  }

  flush(): string {
    if (!this.roots.length) return "";
    const html = ListBuilder.serialize(this.roots);
    this.roots = [];
    this.path = [];
    return html;
  }
}

function renderTable(source: string, styles: ReturnType<typeof styleClasses>): string {
  const rows = [...source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
    [...r[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => textOf(c[1]))
  );
  if (!rows.length) return "";
  const [head, ...body] = rows;
  const cell = (v: string) => {
    if (!v) return "";
    if (/^vacant$/i.test(v)) return `<span class="pill vacant">Vacant</span>`;
    if (/@/.test(v)) return `<a href="mailto:${escapeHtml(v)}">${escapeHtml(v)}</a>`;
    if (/^\d{10}$/.test(v)) return `<a href="tel:${v}">(${v.slice(0, 3)}) ${v.slice(3, 6)}-${v.slice(6)}</a>`;
    return escapeHtml(v);
  };
  return `<div class="table-wrap"><table class="units">
    <thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
    <tbody>${body
      .map((r) => `<tr>${head.map((_, i) => `<td>${cell(r[i] || "")}</td>`).join("")}</tr>`)
      .join("")}</tbody></table></div>`;
}

/** Splits the document body into sections, one per heading of `sectionTag`. */
function parseSections(
  body: string,
  styles: ReturnType<typeof styleClasses>,
  sectionTag: "h1" | "h2"
): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  const list = new ListBuilder();
  const parts: string[] = [];

  const commit = () => {
    const tail = list.flush();
    if (tail) parts.push(tail);
    if (current) { current.html = parts.join("\n"); sections.push(current); }
    parts.length = 0;
  };

  let pos = 0;
  for (let block = nextBlock(body, pos); block; block = nextBlock(body, pos)) {
    pos = block.end;
    const { tag, inner, source, attrs } = block;

    if (tag === sectionTag) {
      commit();
      const raw = textOf(inner);
      const match = raw.match(/^(.*?)\s*\((.*)\)\s*$/);
      current = {
        id: slug(raw),
        title: match ? match[1] : raw,
        subtitle: match ? match[2] : "",
        html: "",
      };
      continue;
    }
    if (tag === "h1") continue;                       // the doc title, when sections are <h2>
    if (!current) continue;                           // skip the doc's own title / contents block

    if (tag === "ol" || tag === "ul") {
      const level = Number(attrs.match(/lst-kix_[\w-]+?-(\d+)\b/)?.[1] ?? 0);
      const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
        .map((m) => inline(m[1], styles))
        .filter((t) => textOf(t) !== "");
      if (items.length) list.push(level, items);
      continue;
    }

    const tail = list.flush();
    if (tail) parts.push(tail);
    if (tag === "table") parts.push(renderTable(source, styles));
    else {
      const text = inline(inner, styles);
      if (!textOf(text)) continue;
      const boxed = (attrs.match(/class="([^"]*)"/)?.[1] ?? "")
        .split(/\s+/)
        .some((c) => styles.callout.has(c));
      parts.push(boxed ? `<blockquote class="callout">${text}</blockquote>` : `<p>${text}</p>`);
    }
  }
  commit();
  return sections;
}

const PAGE_CSS = `
  :root { --ink:#1f2933; --muted:#6b7280; --line:#e5e7eb; --accent:#1a56db; --bg:#f6f7f9; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif; -webkit-font-smoothing:antialiased; }
  a { color:var(--accent); }
  .layout { display:grid; grid-template-columns:236px minmax(0,1fr); gap:2.5rem;
    max-width:1180px; margin:0 auto; padding:2rem 1.5rem 4rem; align-items:start; }

  .doc-head { max-width:1180px; margin:0 auto; padding:2.25rem 1.5rem 0; }
  .doc-head h1 { font-size:1.9rem; letter-spacing:-0.02em; margin:0 0 0.35rem; }
  .doc-head p { margin:0; color:var(--muted); font-size:0.9rem; }

  .toc { position:sticky; top:1.5rem; font-size:0.86rem; }
  .toc h2 { font-size:0.72rem; text-transform:uppercase; letter-spacing:0.08em;
    color:var(--muted); margin:0 0 0.6rem; }
  .toc a { display:block; padding:0.32rem 0.6rem; border-radius:6px; color:#374151;
    text-decoration:none; border-left:2px solid transparent; }
  .toc a:hover { background:#eceff3; color:var(--ink); }
  .toc a.active { background:#e8effc; color:var(--accent); border-left-color:var(--accent); font-weight:600; }

  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr));
    gap:0.75rem; margin-bottom:2rem; }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:0.85rem 1rem;
    text-decoration:none; color:inherit; transition:border-color .15s, transform .15s, box-shadow .15s; }
  .card:hover { border-color:#c7d2e5; transform:translateY(-1px); box-shadow:0 4px 14px rgba(16,24,40,.07); }
  .card .name { font-weight:600; font-size:0.95rem; }
  .card .desc { color:var(--muted); font-size:0.8rem; margin-top:0.15rem; }

  section.doc-section { background:#fff; border:1px solid var(--line); border-radius:12px;
    padding:1.6rem 1.9rem 1.4rem; margin-bottom:1.25rem; scroll-margin-top:1.5rem; }
  section.doc-section > h2 { font-size:1.22rem; letter-spacing:-0.01em; margin:0 0 0.15rem; }
  section.doc-section > .subtitle { color:var(--muted); font-size:0.88rem; margin:0 0 1rem; }
  section.doc-section > hr { border:0; border-top:1px solid var(--line); margin:0 0 1.15rem; }
  section p { margin:0.6rem 0; }

  section ul { margin:0.3rem 0; padding-left:1.15rem; list-style:none; }
  section > ul { padding-left:0; }
  section li { position:relative; padding-left:1.05rem; margin:0.22rem 0; }
  section li::before { content:""; position:absolute; left:0.15rem; top:0.72em;
    width:5px; height:5px; border-radius:50%; background:#9aa5b4; }
  section > ul > li { margin:0.9rem 0 0.35rem; font-weight:600; font-size:1rem; }
  section > ul > li::before { width:7px; height:7px; background:var(--accent); top:0.66em; }
  section > ul > li > ul li { font-weight:400; }
  section > ul > li > ul > li::before { background:#b6c0cf; }
  section > ul > li > ul > li > ul li::before { width:4px; height:4px; background:#cbd3de; }
  section ul ul { border-left:1px solid #eef0f4; margin-left:0.2rem; }

  section blockquote.callout { margin:0.9rem 0; padding:0.85rem 1.05rem; background:#f7f9fc;
    border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:8px;
    color:#374151; font-size:0.95rem; }
  section blockquote.callout em { font-style:normal; }

  .table-wrap { overflow-x:auto; margin:1rem 0 0.5rem; border:1px solid var(--line); border-radius:8px; }
  table.units { border-collapse:collapse; width:100%; font-size:0.87rem; }
  table.units th, table.units td { text-align:left; padding:0.5rem 0.8rem; border-bottom:1px solid var(--line); white-space:nowrap; }
  table.units thead th { background:#f8fafc; font-size:0.74rem; text-transform:uppercase;
    letter-spacing:0.05em; color:var(--muted); }
  table.units tbody tr:last-child td { border-bottom:0; }
  table.units tbody tr:hover td { background:#f9fbff; }
  .pill { display:inline-block; padding:0.1rem 0.5rem; border-radius:999px; font-size:0.75rem; font-weight:600; }
  .pill.vacant { background:#fff4e0; color:#a15c00; }

  @media (max-width:860px) {
    .layout { grid-template-columns:1fr; gap:1rem; padding-top:1.25rem; }
    .toc { position:static; order:-1; background:#fff; border:1px solid var(--line);
      border-radius:10px; padding:0.75rem 0.9rem; }
    .toc .links { display:flex; flex-wrap:wrap; gap:0.25rem; }
    .toc a { border-left:0; }
    section.doc-section { padding:1.2rem 1.1rem; }
  }
  @media print {
    .app-nav, .toc, .cards { display:none; }
    .layout { display:block; padding:0; }
    section.doc-section { border:0; padding:0 0 1rem; break-inside:avoid; }
  }`;

type DocPageOptions = {
  /** Browser title and the page's <h1>. */
  title: string;
  /** The line under the title. */
  summary: (sections: Section[]) => string;
  /** Which sections get a card at the top of the page. */
  carded: (s: Section) => boolean;
  /** The small print on a card. */
  describe: (s: Section) => string;
};

/**
 * A document export, read into its sections. Exported because the Tenants &
 * Access page shows the Home/Unit sections inline beneath its table rather
 * than on a page of their own — it needs the sections, not a whole document.
 */
export function docSections(exportHtml: string): Section[] {
  const css = exportHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/i)?.[1] ?? "";
  const body = exportHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? exportHtml;
  const styles = styleClasses(css);
  // One export uses <h2> for its sections, the other <h1>; go with whichever
  // this document actually has.
  return parseSections(body, styles, /<h2\b/i.test(body) ? "h2" : "h1");
}

/**
 * One section, as the card list and the contents links both link to it.
 *
 * `lead` is rendered between the rule and the document's own text — the door
 * codes go there, so the thing someone opened the page for is above the
 * description rather than below it.
 */
export function sectionHtml(s: Section, lead = ""): string {
  return `<section class="doc-section" id="${s.id}">
        <h2>${escapeHtml(s.title)}</h2>
        ${s.subtitle ? `<p class="subtitle">${escapeHtml(s.subtitle)}</p>` : ""}
        <hr />
        ${lead}
        ${s.html}
      </section>`;
}

/** A section is one of the properties when its title carries a street number. */
export const isProperty = (s: Section) => /\d/.test(s.title);

/** The small print under a property's name in the shortcut cards. */
export const describeProperty = (s: Section) =>
  s.subtitle || textOf(s.html).match(/\d+\s*bed\b[\w\s]*?(bath\b[\w\s]*?sqft|bath)/i)?.[0] || "Property";

/** The document styling, for a page that hosts these sections. */
export const DOC_CSS = PAGE_CSS;

function renderPage(exportHtml: string, nav: string, navCss: string, options: DocPageOptions): string {
  const sections = docSections(exportHtml);

  const toc = sections
    .map((s) => `<a href="#${s.id}">${escapeHtml(s.title)}</a>`)
    .join("");

  const cards = sections
    .filter(options.carded)
    .map(
      (s) => `<a class="card" href="#${s.id}">
        <div class="name">${escapeHtml(s.title)}</div>
        <div class="desc">${escapeHtml(options.describe(s))}</div></a>`
    )
    .join("");

  const content = sections.map(sectionHtml).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(options.title)}</title>
<!-- Same tab icon as the rest of the app; this module stays free of imports,
     so the line is written out rather than shared from auth.ts. -->
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<style>${navCss}${PAGE_CSS}</style>
</head>
<body>
${nav}
<header class="doc-head">
  <h1>${escapeHtml(options.title)}</h1>
  <p>${escapeHtml(options.summary(sections))}</p>
</header>
<div class="layout">
  <nav class="toc"><h2>Contents</h2><div class="links">${toc}</div></nav>
  <main>
    <div class="cards">${cards}</div>
    ${content}
  </main>
</div>
<script>
  // Highlight the section currently in view in the sidebar.
  const links = new Map([...document.querySelectorAll(".toc a")].map((a) => [a.getAttribute("href").slice(1), a]));
  const seen = new Set();
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) e.isIntersecting ? seen.add(e.target.id) : seen.delete(e.target.id);
    const first = [...document.querySelectorAll("section.doc-section")].find((s) => seen.has(s.id));
    for (const [id, a] of links) a.classList.toggle("active", !!first && id === first.id);
  }, { rootMargin: "-10% 0px -70% 0px" });
  document.querySelectorAll("section.doc-section").forEach((s) => observer.observe(s));
</script>
</body>
</html>`;
}

/* Home / Unit Information had a page here too. It now lives under the access
   table on the Tenants & Access page, built from the exports above — see
   docSections and renderHomes in server.ts. */

/** Prospect Management Workflow — one section per phase, carded by its Goal. */
export function renderWorkflowPage(exportHtml: string, nav: string, navCss: string): string {
  return renderPage(exportHtml, nav, navCss, {
    title: "Prospect Management Workflow",
    carded: () => true,
    // Every phase states a Goal; that sentence is what the card is for.
    describe: (s) =>
      textOf(s.html).match(/Goal:\s*([^.]+\.)/i)?.[1]?.trim() ||
      textOf(s.html).match(/Situation:\s*([^.]+\.)/i)?.[1]?.trim() ||
      "",
    summary: (sections) =>
      `${sections.length} phases · from first enquiry to a submitted application`,
  });
}
