'use strict';
/* A small in-memory stand-in for the parts of the Obsidian API TrueBrain uses, so the plugin can be
 * tested with plain Node. Links are parsed the way Obsidian does for [[wikilinks]], ![[embeds]] and
 * links inside frontmatter properties. */
const enc = new TextEncoder(), dec = new TextDecoder();

class TAbstractFile { constructor(vault, path) { this.vault = vault; this.path = path; } get name() { return this.path.replace(/^.*\//, ''); } get parent() { return this.vault.folderObj(this.path.includes('/') ? this.path.replace(/\/[^/]*$/, '') : '/'); } }
class TFile extends TAbstractFile {
  get basename() { return this.name.replace(/\.[^.]*$/, ''); }
  get extension() { return (this.name.match(/\.([^.]*)$/) || [])[1] || ''; }
  get stat() { const r = this.vault.store.get(this.path); return { mtime: r.mtime, ctime: r.ctime, size: r.bytes.length }; }
}
class TFolder extends TAbstractFile { get children() { return [...this.vault.store.keys()].filter((p) => p.startsWith(this.path + '/') && !p.slice(this.path.length + 1).includes('/')).map((p) => this.vault.fileObj(p)); } }

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { fm: null, end: 0, links: [] };
  const e = text.indexOf('\n---', 3); if (e < 0) return { fm: null, end: 0, links: [] };
  const fm = {}, links = [];
  for (const line of text.slice(4, e).split('\n')) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line); if (!m) continue;
    let v = m[2].trim();
    if (/^\[.*\]$/.test(v) && !/^\[\[/.test(v)) v = v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
    else v = v.replace(/^"(.*)"$/, '$1');
    fm[m[1]] = v;
    for (const lm of String(m[2]).matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g)) links.push({ key: m[1], link: lm[1], original: lm[0], displayText: lm[2] || lm[1] });
  }
  return { fm, end: e + 4, links };
}

class Vault {
  constructor(files, name) { this.store = new Map(); this.objs = new Map(); this.trashed = []; this.vname = name || 'Test Vault'; this.t = Date.parse('2026-01-01T00:00:00');
    for (const [p, c] of Object.entries(files || {})) this._put(p, typeof c === 'string' ? enc.encode(c) : c, c.mtime);
    const self = this;
    this.adapter = { data: new Map(),
      async exists(p) { return self.adapter.data.has(p) || [...self.adapter.data.keys()].some((k) => k.startsWith(p + '/')) || p === '.truebrain'; },
      async read(p) { return self.adapter.data.get(p) || ''; }, async write(p, t) { self.adapter.data.set(p, t); },
      async append(p, t) { self.adapter.data.set(p, (self.adapter.data.get(p) || '') + t); }, async mkdir() {} };
  }
  _put(p, bytes) { this.t += 1000; const old = this.store.get(p); this.store.set(p, { bytes, mtime: this.t, ctime: old ? old.ctime : this.t }); this.metadataCache && this.metadataCache._dirty(); }
  fileObj(p) { if (!this.objs.has(p)) this.objs.set(p, new TFile(this, p)); return this.objs.get(p); }
  folderObj(p) { return new TFolder(this, p); }
  getName() { return this.vname; }
  getFiles() { return [...this.store.keys()].map((p) => this.fileObj(p)); }
  getMarkdownFiles() { return this.getFiles().filter((f) => f.extension === 'md'); }
  getAbstractFileByPath(p) { if (this.store.has(p)) return this.fileObj(p); if ([...this.store.keys()].some((k) => k.startsWith(p + '/'))) return this.folderObj(p); return null; }
  async read(f) { return dec.decode(this.store.get(f.path).bytes); }
  async cachedRead(f) { return this.read(f); }
  async readBinary(f) { const b = this.store.get(f.path).bytes; return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
  async create(p, text) { if (this.store.has(p)) throw new Error('exists: ' + p); this._put(p, enc.encode(text)); return this.fileObj(p); }
  async createBinary(p, buf) { if (this.store.has(p)) throw new Error('exists: ' + p); this._put(p, new Uint8Array(buf)); return this.fileObj(p); }
  async modify(f, text) { this._put(f.path, enc.encode(text)); }
  async process(f, fn) { const t = fn(await this.read(f)); this._put(f.path, enc.encode(t)); return t; }
  async delete(f) { this.store.delete(f.path); this.metadataCache._dirty(); }
  async trash(f) { if (f instanceof TFolder) return; this.trashed.push(f.path); await this.delete(f); }
  async createFolder() {}
}

class MetadataCache {
  constructor(vault) { this.vault = vault; vault.metadataCache = this; this.cache = null; }
  _dirty() { this.cache = null; }
  dest(link) { const k = link.replace(/\.md$/, '').toLowerCase(); return this.vault.getFiles().find((f) => f.path.replace(/\.md$/, '').toLowerCase() === k || (f.extension === 'md' ? f.basename : f.name).toLowerCase() === k.replace(/^.*\//, '')) || null; }
  build() {
    if (this.cache) return this.cache;
    const c = new Map(), resolved = {}, unresolved = {};
    for (const f of this.vault.getMarkdownFiles()) {
      const t = dec.decode(this.vault.store.get(f.path).bytes); const p = parseFrontmatter(t);
      const links = [], embeds = [];
      for (const m of t.slice(p.end).matchAll(/(!?)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g)) {
        const o = { link: m[2], original: m[0], displayText: m[3] || m[2], position: { start: { offset: p.end + m.index }, end: { offset: p.end + m.index + m[0].length } } };
        (m[1] ? embeds : links).push(o);
      }
      const tags = [...t.slice(p.end).matchAll(/(^|\s)#([\w/-]+)/g)].map((m) => ({ tag: '#' + m[2] }));
      c.set(f.path, { frontmatter: p.fm || undefined, frontmatterPosition: p.fm ? { end: { offset: p.end } } : undefined, links, embeds, frontmatterLinks: p.links, tags });
      for (const l of [].concat(links, embeds, p.links)) {
        const d = this.dest(l.link);
        const bucket = d ? resolved : unresolved; const key = d ? d.path : l.link;
        bucket[f.path] = bucket[f.path] || {}; bucket[f.path][key] = (bucket[f.path][key] || 0) + 1;
      }
    }
    this.cache = { c, resolved, unresolved }; return this.cache;
  }
  getFileCache(f) { return this.build().c.get(f.path) || null; }
  get resolvedLinks() { return this.build().resolved; }
  get unresolvedLinks() { return this.build().unresolved; }
  getFirstLinkpathDest(link) { return this.dest(link); }
  fileToLinktext(f) { return f.extension === 'md' ? f.basename : f.name; }
  on() { return {}; }
}

function makeApp(files) {
  const vault = new Vault(files); const metadataCache = new MetadataCache(vault);
  const app = { vault, metadataCache,
    fileManager: { async processFrontMatter(f, fn) {
      const t = await vault.read(f); const p = parseFrontmatter(t); const fm = Object.assign({}, p.fm || {}); fn(fm);
      const head = '---\n' + Object.entries(fm).map(([k, v]) => k + ': ' + (Array.isArray(v) ? '[' + v.join(', ') + ']' : v)).join('\n') + '\n---';
      await vault.modify(f, head + t.slice(p.end ? p.end : 0)); },
      async trashFile(f) { return vault.trash(f); } },
    workspace: { getActiveFile: () => null, on() { return {}; }, getLeavesOfType: () => [], onLayoutReady() {}, getLeaf: () => ({ openFile() {} }) } };
  return app;
}

/* the module that stands in for require('obsidian') */
const notices = [];
class Notice { constructor(m) { notices.push(String(m)); } }
class Modal { constructor(app) { this.app = app; this.titleEl = { setText() {} }; this.contentEl = { createEl() { return {}; }, createDiv() { return {}; }, empty() {} }; } open() { Modal.opened.push(this); } close() {} }
Modal.opened = [];
const obsidianStub = {
  TFile, TFolder, Notice, Modal, notices,
  Plugin: class { constructor(app, manifest) { this.app = app; this.manifest = manifest; } }, ItemView: class {}, PluginSettingTab: class {},
  Setting: class { constructor() { const s = this; ['setName', 'setDesc', 'setHeading', 'addText', 'addToggle', 'addButton'].forEach((k) => { s[k] = () => s; }); } },
  SuggestModal: class extends Modal { setPlaceholder() {} },
  normalizePath: (p) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, ''),
  arrayBufferToBase64: (buf) => Buffer.from(buf).toString('base64'),
  base64ToArrayBuffer: (s) => { const b = Buffer.from(s, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
};

module.exports = { makeApp, obsidianStub, Modal, notices, TFile, TFolder };
