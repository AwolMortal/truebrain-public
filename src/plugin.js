'use strict';
/* TrueBrain Public: the Obsidian side. Pure logic lives in ./core (tested with plain Node). */
const obsidian = require('obsidian');
const { Plugin, ItemView, Modal, Notice, PluginSettingTab, Setting, SuggestModal, TFile, TFolder, normalizePath } = obsidian;
const C = require('./core');
const { packFlow, unpackFlow, usedBy, listPacks } = require('./packs');
const { makeProposals, applyProposals } = require('./proposals');

const VIEW = 'truebrain-public-panel';
const DATA = '.truebrain';                     // vault-root dot-folder: Obsidian does not index it; AI tools can read it
const KEEP_DAYS = 400;                         // heat reads this far back; the usage log is trimmed to it once a day
const DEFAULTS = {
  inboxFolder: 'Inbox', packFolder: 'Archive', reportFolder: 'TrueBrain', excludeFolders: '',
  summaryProperty: 'summary', requireSummary: true, parentProperty: '',
  coldDays: 90, hotTop: 15, logOpens: true, liveHeat: true, explorerMarks: true,
  weeklyProposals: true, maxAdd: 15, maxCut: 10, maxArchive: 15, archiveProperty: 'status', archiveValue: 'paused',
  processFolders: '', projectFolders: '', keepStatuses: 'evergreen', aiIndex: true, stormThreshold: 40,
  lastProposals: '', lastReport: '',
};

// ---------------------------------------------------------------- small modals
class PromptModal extends Modal {
  constructor(app, title, fields, onSubmit) { super(app); this.t = title; this.fields = fields; this.cb = onSubmit; }
  onOpen() {
    this.titleEl.setText(this.t);
    const vals = {};
    for (const f of this.fields) {
      vals[f.key] = f.value || '';
      new Setting(this.contentEl).setName(f.label).setDesc(f.desc || '')
        .addText((x) => { x.setValue(vals[f.key]).onChange((v) => { vals[f.key] = v; }); if (f === this.fields[0]) window.setTimeout(() => x.inputEl.focus(), 30); });
    }
    new Setting(this.contentEl).addButton((b) => b.setButtonText('Continue').setCta().onClick(() => { this.close(); this.cb(vals); }));
  }
  onClose() { this.contentEl.empty(); }
}

class ChoiceModal extends SuggestModal {
  constructor(app, items, label, onChoose, hint) { super(app); this.items = items; this.label = label; this.onChoose = onChoose; this.setPlaceholder(hint || 'Choose'); }
  getSuggestions(q) { return this.items.filter((i) => this.label(i).toLowerCase().includes(q.toLowerCase())); }
  renderSuggestion(i, el) { el.setText(this.label(i)); }
  onChooseSuggestion(i) { this.onChoose(i); }
}

class ReportModal extends Modal {
  constructor(app, title, text, actions) { super(app); this.t = title; this.text = text; this.actions = actions || []; }
  onOpen() {
    this.titleEl.setText(this.t);
    this.contentEl.createEl('div', { cls: 'truebrain-output', text: this.text || '(nothing)' });
    if (this.actions.length) {
      const row = this.contentEl.createDiv({ cls: 'truebrain-buttons' });
      for (const a of this.actions) { const b = row.createEl('button', { text: a.label, cls: a.warn ? 'mod-warning' : 'mod-cta' }); b.onclick = () => { this.close(); a.run(); }; }
    }
  }
  onClose() { this.contentEl.empty(); }
}

class FindModal extends SuggestModal {
  constructor(plugin) { super(plugin.app); this.p = plugin; this.setPlaceholder('Find by name, summary or tag (all words must match)'); this.entries = plugin.entries(); }
  getSuggestions(q) { return C.rankNotes(this.entries, q, { limit: 40 }).map((h) => h.entry); }
  renderSuggestion(e, el) {
    el.createDiv({ cls: 'truebrain-find-name', text: e.name });
    if (e.summary) el.createDiv({ cls: 'truebrain-find-summary', text: e.summary });
    el.createDiv({ cls: 'truebrain-find-path', text: e.path });
  }
  onChooseSuggestion(e) { this.p.openPath(e.path); }
}

// ---------------------------------------------------------------- the panel
class Panel extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.p = plugin; }
  getViewType() { return VIEW; }
  getDisplayText() { return 'TrueBrain'; }
  getIcon() { return 'flame'; }
  async onOpen() { await this.render(); }
  async render() {
    const P = this.p, el = this.contentEl; el.empty(); el.addClass('truebrain-panel');
    const btns = el.createDiv({ cls: 'truebrain-buttons' });
    const mk = (t, fn) => { const b = btns.createEl('button', { text: t }); b.onclick = fn; };
    mk('Find', () => new FindModal(P).open());
    mk('Capture', () => P.captureFlow());
    mk('Proposals', () => P.runProposals(true));
    mk('Report', () => P.writeReport(true));
    const H = await P.getHeat();
    el.createDiv({ cls: 'truebrain-muted', text: 'Heat ' + H.generated + ' | ' + H.notes.length + ' notes' });
    const section = (title, rows, name, num, path) => {
      el.createEl('h4', { text: title });
      if (!rows.length) { el.createDiv({ cls: 'truebrain-empty', text: 'none yet' }); return; }
      for (const r of rows) {
        const row = el.createDiv({ cls: 'truebrain-row' });
        row.createSpan({ cls: 'truebrain-name', text: name(r) }); row.createSpan({ cls: 'truebrain-num', text: num(r) });
        row.onclick = () => P.openPath(path(r));
      }
    };
    section('Hot: strengthen these', H.notes.filter((n) => n.score > 0).slice(0, 12), (n) => C.baseName(n.note), (n) => n.score + (n.reads30 ? ' | ' + n.reads30 + ' reads' : ''), (n) => n.note);
    section('Possibly irrelevant: review', H.notes.filter((n) => n.cold).slice(0, 12), (n) => C.baseName(n.note), (n) => n.idle + ' d idle', (n) => n.note);
    section('Links followed', H.follows.slice(0, 10), (f) => C.baseName(f.a) + ' > ' + C.baseName(f.b), (f) => f.n + 'x', (f) => f.b);
    section('Used together', H.pairs.slice(0, 8), (f) => C.baseName(f.a) + ' + ' + C.baseName(f.b), (f) => f.sessions + ' sessions', (f) => f.a);
    el.createEl('h4', { text: 'Packed (cold storage)' });
    const packs = listPacks(P);
    if (!packs.length) el.createDiv({ cls: 'truebrain-empty', text: 'nothing packed' });
    for (const f of packs) {
      const row = el.createDiv({ cls: 'truebrain-row' });
      const n = row.createSpan({ cls: 'truebrain-name', text: f.basename }); n.onclick = () => P.openPath(f.path);
      const b = row.createEl('button', { text: 'Unpack...', cls: 'truebrain-small' }); b.onclick = (e) => { e.stopPropagation(); unpackFlow(P, f); };
    }
  }
}

// ---------------------------------------------------------------- the plugin
class TrueBrainPublic extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.session = 'obs-' + C.isoStamp(new Date()).replace(/\D/g, '');
    this.heat = null; this.heatAt = 0; this.byPath = new Map();
    this.registerView(VIEW, (leaf) => new Panel(leaf, this));
    this.addRibbonIcon('flame', 'TrueBrain', () => this.openPanel());
    this.status = this.addStatusBarItem(); this.status.addClass('truebrain-status'); this.status.onclick = () => this.openPanel();

    const cmd = (id, name, cb) => this.addCommand({ id, name, callback: cb });
    cmd('open-panel', 'Open the panel', () => this.openPanel());
    cmd('find', 'Find notes by name, summary or tag', () => new FindModal(this).open());
    cmd('capture', 'Capture a decision, finding or process', () => this.captureFlow());
    cmd('proposals', 'Make link proposals now', () => this.runProposals(true));
    cmd('apply-proposals', 'Apply ticked proposals', () => { const f = this.app.workspace.getActiveFile(); applyProposals(this, f && /^TrueBrain Proposals /.test(f.basename) ? f : null); });
    cmd('report', 'Write the maintenance report', () => this.writeReport(true));
    cmd('ai-index', 'Write the AI index now (.truebrain/index.tsv)', () => this.writeIndex(true));
    cmd('pack-note', 'Pack the current note into cold storage', () => { const f = this.app.workspace.getActiveFile(); if (f) packFlow(this, f); });
    cmd('pack-folder', "Pack the current note's folder into cold storage", () => { const f = this.app.workspace.getActiveFile(); if (f && f.parent && f.parent.path !== '/') packFlow(this, f.parent); });
    cmd('unpack', 'Unpack a pack...', () => { const ps = listPacks(this); if (!ps.length) return new Notice('TrueBrain: nothing is packed'); new ChoiceModal(this.app, ps, (f) => f.basename, (f) => unpackFlow(this, f), 'Pick a pack to unpack').open(); });
    cmd('used-by', 'Which packed notes linked to this note', () => { const f = this.app.workspace.getActiveFile(); if (f) usedBy(this, f); });

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      menu.addItem((i) => i.setTitle('TrueBrain: pack into cold storage...').setIcon('archive').onClick(() => packFlow(this, file)));
    }));
    this.registerEvent(this.app.workspace.on('file-open', (f) => this.onOpenFile(f)));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateStatus()));
    this.registerEvent(this.app.metadataCache.on('changed', (f) => { if (f === this.app.workspace.getActiveFile()) this.updateStatus(); this.queueIndex(); }));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.scheduleMarks()));
    for (const ev of ['create', 'modify', 'delete', 'rename']) this.registerEvent(this.app.vault.on(ev, () => this.noteEvent()));

    // automation: anything can create a capture through obsidian://truebrain?action=capture&kind=...&title=...&summary=...&body=...
    this.registerObsidianProtocolHandler('truebrain', async (q) => {
      if (q.action === 'capture') { const f = await this.capture(q.kind || 'note', q.title, q.summary, q.body || '', q.project); if (f) this.openPath(f.path); }
      else if (q.action === 'find') new FindModal(this).open();
    });

    this.addSettingTab(new Settings(this.app, this));
    this.app.workspace.onLayoutReady(async () => {
      await this.ensureData();
      this.updateStatus(); this.scheduleMarks(); this.queueIndex();
      // upkeep that would be a scheduled job elsewhere: once a day / once a week, when Obsidian is open
      window.setTimeout(() => this.dailyUpkeep(), 15000);
      this.registerInterval(window.setInterval(() => this.dailyUpkeep(), 3600000));
    });
  }

  onunload() {
    // pending one-shot timers would otherwise fire after the plugin is gone (an index write, a storm "calm" refresh)
    for (const k of ['_calm', '_mt', '_ix']) { window.clearTimeout(this[k]); this[k] = null; }
    this.unloaded = true;
    if (this.obs) this.obs.disconnect();
    document.querySelectorAll('.truebrain-hot,.truebrain-cold').forEach((e) => e.classList.remove('truebrain-hot', 'truebrain-cold'));
  }
  async saveSettings() { await this.saveData(this.settings); }

  // ---------------------------------------------------------------- shared helpers
  excluded() {
    const S = this.settings;
    return C.csv(S.excludeFolders).concat([S.packFolder, S.reportFolder].filter(Boolean)).map((x) => normalizePath(x));
  }
  isExcluded(path) { return C.inFolders(path, this.excluded()); }
  fm(file) { return ((this.app.metadataCache.getFileCache(file) || {}).frontmatter) || {}; }
  notes() { return this.app.vault.getMarkdownFiles().filter((f) => !this.isExcluded(f.path)); }
  entries() {
    const heat = this.heat ? new Map(this.heat.notes.map((n) => [n.note, n.score])) : new Map();
    return this.notes().map((f) => {
      const c = this.app.metadataCache.getFileCache(f) || {}, fm = c.frontmatter || {};
      const tags = [...new Set([].concat(fm.tags || [], (c.tags || []).map((t) => t.tag.replace(/^#/, ''))))].join(' ');
      return { path: f.path, name: f.basename, summary: C.fmString(fm[this.settings.summaryProperty]), tags, type: C.fmString(fm.type), heat: heat.get(f.path) || 0 };
    });
  }
  openPath(p) { const f = this.app.vault.getAbstractFileByPath(p); if (f instanceof TFile) this.app.workspace.getLeaf(false).openFile(f); }
  isHub(f) {
    const c = this.app.metadataCache.getFileCache(f) || {}, fm = c.frontmatter || {};
    return /\b(MOC|Index|Hub)$/i.test(f.basename) || /^(moc|index|hub)$/i.test(C.fmString(fm.type)) || (c.links || []).length > 30;
  }
  async ensureData() { const a = this.app.vault.adapter; if (!(await a.exists(DATA))) await a.mkdir(DATA); }
  async readData(name) { const a = this.app.vault.adapter, p = DATA + '/' + name; return (await a.exists(p)) ? a.read(p) : null; }
  async writeData(name, text) { await this.ensureData(); await this.app.vault.adapter.write(DATA + '/' + name, text); }
  async ensureFolder(path) { const p = normalizePath(path); if (p && !this.app.vault.getAbstractFileByPath(p)) await this.app.vault.createFolder(p).catch(() => {}); }

  // ---------------------------------------------------------------- storm mode: hold still during bulk changes
  noteEvent() {
    const now = Date.now(), q = this._ev || (this._ev = []);
    q.push(now); while (q.length && now - q[0] > 10000) q.shift();
    if (!this.storm && q.length > this.settings.stormThreshold) this.storm = true;
    if (this.storm) {
      window.clearTimeout(this._calm);
      this._calm = window.setTimeout(() => { this.storm = false; this._ev = []; this.heat = null; this.refreshAll(); this.queueIndex(); }, 20000);
    }
  }

  // ---------------------------------------------------------------- heat
  async onOpenFile(f) {
    this.updateStatus();
    if (!f || f.extension !== 'md' || !this.settings.logOpens || this.isExcluded(f.path)) return;
    const now = Date.now();
    if (this._last && this._last.p === f.path && now - this._last.t < 3000) return;
    this._last = { p: f.path, t: now };
    try { await this.ensureData(); await this.app.vault.adapter.append(DATA + '/usage.jsonl', JSON.stringify({ t: C.isoStamp(new Date()), note: f.path, tool: 'open', session: this.session }) + '\n'); }
    catch (e) { console.warn('truebrain: could not log', e); }
    if (this.settings.liveHeat && now - this.heatAt > 60000) { this.heat = null; this.refreshAll(); }
  }
  async getHeat(force) {
    if (this.heat && !force && Date.now() - this.heatAt < 60000) return this.heat;
    const since = Date.now() - KEEP_DAYS * C.DAY;
    const events = C.parseEvents(await this.readData('usage.jsonl'), since);
    const RL = this.app.metadataCache.resolvedLinks, back = new Map(), links = {};
    for (const [src, dsts] of Object.entries(RL)) for (const d of Object.keys(dsts)) back.set(d, (back.get(d) || 0) + 1);
    const keep = C.csv(this.settings.keepStatuses).map((s) => s.toLowerCase());
    const notes = this.notes().map((f) => {
      const c = this.app.metadataCache.getFileCache(f) || {};
      const body = (c.links || []).map((l) => this.app.metadataCache.getFirstLinkpathDest(l.link, f.path)).filter((t) => t && t.extension === 'md').map((t) => t.path);
      if (body.length) links[f.path] = [...new Set(body)];
      return { path: f.path, mtime: f.stat.mtime, ctime: f.stat.ctime, back: back.get(f.path) || 0, out: body.length,
        hub: this.isHub(f), keep: keep.includes(C.fmString((c.frontmatter || {}).status).toLowerCase()) };
    });
    this.heat = C.computeHeat(events, notes, links, Date.now(), { coldDays: this.settings.coldDays });
    this.heatAt = Date.now();
    this.byPath = new Map(this.heat.notes.map((n) => [n.note, n]));
    const hot = this.heat.notes.filter((n) => n.score > 0).slice(0, this.settings.hotTop);
    this.hotSet = new Set(hot.map((n) => n.note)); this.coldSet = new Set(this.heat.notes.filter((n) => n.cold).map((n) => n.note));
    return this.heat;
  }
  async refreshAll() {
    if (this.storm) return;
    await this.getHeat(); this.updateStatus(); this.scheduleMarks();
    for (const l of this.app.workspace.getLeavesOfType(VIEW)) l.view.render();
  }
  updateStatus() {
    const f = this.app.workspace.getActiveFile(), el = this.status; if (!el) return;
    if (!f || f.extension !== 'md') { el.setText(''); return; }
    const h = this.byPath.get(f.path), fm = this.fm(f);
    const has = !!C.fmString(fm[this.settings.summaryProperty]).trim();
    const bits = [h ? 'heat ' + h.score + (h.cold ? ' (cold)' : '') : 'heat -'];
    if (h) bits.push(h.back + ' links in');
    if (this.settings.requireSummary) bits.push(has ? 'summary ok' : 'NO SUMMARY');
    el.setText(bits.join(' | '));
    el.toggleClass('truebrain-warn', this.settings.requireSummary && !has && !this.isExcluded(f.path));
  }
  scheduleMarks() { if (this.storm) return; window.clearTimeout(this._mt); this._mt = window.setTimeout(() => this.applyMarks(), 300); }
  applyMarks() {
    const leaf = this.app.workspace.getLeavesOfType('file-explorer')[0]; if (!leaf) return;
    const root = leaf.view.containerEl;
    if (!this.obs) this.obs = new MutationObserver(() => this.scheduleMarks());
    this.obs.disconnect();
    const on = this.settings.explorerMarks && this.heat;
    root.querySelectorAll('.nav-file-title[data-path]').forEach((el) => {
      const p = el.getAttribute('data-path');
      el.classList.toggle('truebrain-hot', !!(on && this.hotSet.has(p))); el.classList.toggle('truebrain-cold', !!(on && this.coldSet.has(p)));
    });
    this.obs.observe(root, { childList: true, subtree: true });
  }
  async openPanel() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false); await leaf.setViewState({ type: VIEW, active: true }); }
    const right = this.app.workspace.rightSplit; if (right && right.collapsed) right.expand();
    await this.app.workspace.revealLeaf(leaf);
    await this.getHeat(true); if (leaf.view.render) await leaf.view.render();
    new Notice('TrueBrain: panel open in the right sidebar', 2000);
  }

  // ---------------------------------------------------------------- capture
  captureFlow() {
    const kinds = ['decision', 'finding', 'process', 'note'];
    new ChoiceModal(this.app, kinds, (k) => k, (kind) => {
      new PromptModal(this.app, 'Capture a ' + kind, [
        { key: 'title', label: 'Title' },
        { key: 'summary', label: 'One-line summary', desc: 'What it is and when to use it' },
        { key: 'project', label: 'Project (optional)', desc: kind === 'process' ? 'Leave empty: a process should not name a project' : '' },
      ], async (v) => { const f = await this.capture(kind, v.title, v.summary, '', v.project); if (f) this.openPath(f.path); }).open();
    }, 'What are you capturing?').open();
  }
  async capture(kind, title, summary, body, project) {
    title = C.safeName(title); summary = String(summary || '').replace(/\s+/g, ' ').trim();
    if (!title) { new Notice('TrueBrain: a title is needed'); return null; }
    const dup = this.app.vault.getMarkdownFiles().find((f) => f.basename.toLowerCase() === title.toLowerCase());
    if (dup) { new Notice('TrueBrain: "' + title + '" already exists; opened it'); this.openPath(dup.path); return null; }
    const today = C.isoDate(new Date());
    const name = kind === 'decision' && !/^\d{4}-\d{2}-\d{2}/.test(title) ? today + ' ' + title : title;
    const skel = { decision: '## Decision\n\n## Why\n\n## Alternatives\n', finding: '## What\n\n## Evidence\n\n## So what\n', process: '## When to use\n\n## Steps\n\n## Traps\n' }[kind] || '';
    const fm = ['---', 'type: ' + kind, this.settings.summaryProperty + ': "' + summary.replace(/"/g, "'") + '"', 'created: ' + today, 'tags: [capture/' + kind + ']'];
    if (project) fm.push('project: ' + C.safeName(project));
    fm.push('---', '# ' + name, '', String(body || '').trim() || skel);
    await this.ensureFolder(this.settings.inboxFolder);
    const path = normalizePath((this.settings.inboxFolder ? this.settings.inboxFolder + '/' : '') + name + '.md');
    return this.app.vault.create(path, fm.join('\n') + '\n');
  }

  // ---------------------------------------------------------------- AI index: one grep-able line per note
  queueIndex() { if (!this.settings.aiIndex || this.storm) return; window.clearTimeout(this._ix); this._ix = window.setTimeout(() => this.writeIndex(false), 60000); }
  async writeIndex(show) {
    if (this.unloaded) return;
    if (!this.heat) await this.getHeat();          // otherwise the first index after startup says heat 0 everywhere
    const rows = ['path\tname\ttype\tsummary\ttags\theat'];
    for (const e of this.entries()) rows.push([e.path, e.name, e.type, e.summary, e.tags, e.heat].map((x) => String(x).replace(/[\t\n]/g, ' ')).join('\t'));
    await this.writeData('index.tsv', rows.join('\n') + '\n');
    await this.writeData('README.md', AI_README);
    if (show) new Notice('TrueBrain: index written (' + (rows.length - 1) + ' notes)');
  }

  // ---------------------------------------------------------------- upkeep: daily report, weekly proposals
  async dailyUpkeep() {
    if (this.storm || this.unloaded) return;
    const today = C.isoDate(new Date());
    if (this.settings.lastReport !== today) { await this.compactUsage(); await this.writeReport(false); }
    if (this.settings.weeklyProposals && (!this.settings.lastProposals || Date.now() - Date.parse(this.settings.lastProposals) >= 7 * C.DAY)) await this.runProposals(false);
  }
  /* the usage log only grows, and heat re-reads all of it; once a day drop what heat can no longer use
   * (older than KEEP_DAYS) and any unreadable line. Nothing is rewritten when nothing would change. */
  async compactUsage() {
    const text = await this.readData('usage.jsonl'); if (!text) return { dropped: 0 };
    const r = C.compactEvents(text, Date.now() - KEEP_DAYS * C.DAY);
    if (r.dropped) await this.writeData('usage.jsonl', r.text);
    return r;
  }
  async runProposals(show) {
    const r = await makeProposals(this);
    this.settings.lastProposals = C.isoDate(new Date()); await this.saveSettings();
    if (show && r) { new Notice(r.existing ? "TrueBrain: today's proposals are already made; opened them" : 'TrueBrain: ' + r.total + ' proposals'); this.openPath(r.path); }
  }
  async writeReport(show) {
    const S = this.settings, notes = this.notes(), MC = this.app.metadataCache;
    const noSummary = S.requireSummary ? notes.filter((f) => !this.isHub(f) && !C.fmString(this.fm(f)[S.summaryProperty]).trim()) : [];
    const noParent = S.parentProperty ? notes.filter((f) => !C.fmString(this.fm(f)[S.parentProperty]).trim()) : [];
    const unresolved = [];
    for (const [src, m] of Object.entries(MC.unresolvedLinks)) if (!this.isExcluded(src)) for (const [t, n] of Object.entries(m)) unresolved.push([src, t, n]);
    const names = new Map(); for (const f of this.app.vault.getMarkdownFiles()) { const k = f.basename.toLowerCase(); names.set(k, (names.get(k) || []).concat(f.path)); }
    const dups = [...names.values()].filter((v) => v.length > 1);
    const empty = notes.filter((f) => f.stat.size < 5);
    const inbox = S.inboxFolder ? notes.filter((f) => C.inFolders(f.path, [normalizePath(S.inboxFolder)]) && Date.now() - f.stat.ctime > 14 * C.DAY) : [];
    const link = (p) => '[' + C.baseName(p) + '](' + this.uri(p) + ')';
    const list = (arr, fmt) => (arr.length ? arr.slice(0, 60).map(fmt) : ['- none']).concat(arr.length > 60 ? ['- ... and ' + (arr.length - 60) + ' more'] : []);
    const md = ['---', 'type: report', S.summaryProperty + ': "TrueBrain maintenance report: missing summaries, broken links, duplicates, stale inbox."', '---',
      '# TrueBrain Report', '', 'Written ' + C.isoStamp(new Date()) + ' by TrueBrain (daily while Obsidian is open). Links here are obsidian:// links, so this report adds no backlinks.', '',
      '| Notes | No summary | No parent | Broken links | Duplicate names | Empty | Old inbox items |', '|---|---|---|---|---|---|---|',
      '| ' + [notes.length, S.requireSummary ? noSummary.length : 'off', S.parentProperty ? noParent.length : 'off', unresolved.length, dups.length, empty.length, inbox.length].join(' | ') + ' |', '',
      '## Notes without a summary', ...list(noSummary, (f) => '- ' + link(f.path)), '',
      ...(S.parentProperty ? ['## Notes without a ' + S.parentProperty, ...list(noParent, (f) => '- ' + link(f.path)), ''] : []),
      '## Broken links (target note does not exist)', ...list(unresolved, ([s, t, n]) => '- ' + link(s) + ' -> `' + t + '`' + (n > 1 ? ' (' + n + 'x)' : '')), '',
      '## Duplicate note names', ...list(dups, (v) => '- ' + v.map((p) => '`' + p + '`').join(', ')), '',
      '## Empty notes', ...list(empty, (f) => '- ' + link(f.path)), '',
      '## Inbox items older than 14 days', ...list(inbox, (f) => '- ' + link(f.path)), ''];
    await this.ensureFolder(S.reportFolder);
    const p = normalizePath((S.reportFolder ? S.reportFolder + '/' : '') + 'TrueBrain Report.md');
    const ex = this.app.vault.getAbstractFileByPath(p);
    if (ex instanceof TFile) await this.app.vault.modify(ex, md.join('\n')); else await this.app.vault.create(p, md.join('\n'));
    S.lastReport = C.isoDate(new Date()); await this.saveSettings();
    if (show) this.openPath(p);
  }
  uri(path) { return 'obsidian://open?vault=' + encodeURIComponent(this.app.vault.getName()) + '&file=' + encodeURIComponent(path.replace(/\.md$/i, '')); }
}

const AI_README = `# TrueBrain data folder (for AI assistants and scripts)

This folder is written by the TrueBrain Obsidian plugin. Obsidian does not index it.

- index.tsv: one line per note: path, name, type, summary, tags, heat. Search this first (grep), then
  read only the notes that matter. It is rewritten about a minute after notes change.
- usage.jsonl: one JSON object per line: {"t": "2026-10-01T09:30:00", "note": "<vault path>", "tool": "open", "session": "<id>"}.
  Tools may append their own reads (tool: "read") so heat counts them too.
- proposals/: the weekly link proposals (the note itself is in the inbox folder).

To save something into the vault, write a note into the inbox folder with frontmatter
(type: decision|finding|process|note, summary: "<one line>"), or open
obsidian://truebrain?action=capture&kind=finding&title=<title>&summary=<summary>&body=<text>
`;

// ---------------------------------------------------------------- settings
class Settings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.p = plugin; }
  display() {
    const c = this.containerEl, S = this.p.settings, save = () => this.p.saveSettings(); c.empty();
    const text = (name, key, desc) => new Setting(c).setName(name).setDesc(desc || '').addText((t) => t.setValue(String(S[key])).onChange(async (v) => { S[key] = v.trim(); await save(); }));
    const num = (name, key, desc, min) => new Setting(c).setName(name).setDesc(desc || '').addText((t) => t.setValue(String(S[key])).onChange(async (v) => { const n = parseInt(v, 10); if (n >= (min == null ? 1 : min)) { S[key] = n; await save(); } }));
    const tog = (name, key, desc, after) => new Setting(c).setName(name).setDesc(desc || '').addToggle((t) => t.setValue(!!S[key]).onChange(async (v) => { S[key] = v; await save(); if (after) after(v); }));
    new Setting(c).setName('Folders').setHeading();
    text('Inbox folder', 'inboxFolder', 'Where captures and the weekly proposals go.');
    text('Cold-storage folder', 'packFolder', 'Where packed notes go (one note per pack).');
    text('Report folder', 'reportFolder', 'Where the daily maintenance report is written.');
    text('Folders to leave out', 'excludeFolders', 'Comma-separated. Not searched, not scored, not proposed (templates, attachments...).');
    new Setting(c).setName('Notes').setHeading();
    text('Summary property', 'summaryProperty', 'The frontmatter property that holds a one-line summary.');
    tog('Warn when a note has no summary', 'requireSummary', 'Status bar shows NO SUMMARY; the report lists them.');
    text('Parent property (optional)', 'parentProperty', 'If you keep a tree with a property like "parent", the report lists notes without one.');
    text('Statuses that never count as cold', 'keepStatuses', 'Comma-separated values of the "status" property, e.g. evergreen.');
    new Setting(c).setName('Heat').setHeading();
    tog('Record the notes I open', 'logOpens', 'Written to .truebrain/usage.jsonl in this vault only.');
    tog('Live heat', 'liveHeat', 'Recompute heat at most once a minute while you work.');
    tog('Mark hot and cold notes in the file list', 'explorerMarks', '', () => this.p.scheduleMarks());
    num('Days before a note counts as cold', 'coldDays');
    num('How many hot notes to mark', 'hotTop');
    new Setting(c).setName('Weekly proposals').setHeading();
    tog('Make link proposals once a week', 'weeklyProposals', 'One note in the inbox to tick. Nothing changes without a tick.');
    num('Max "add link" proposals', 'maxAdd', '0 turns this section off.', 0);
    num('Max "cut link" proposals', 'maxCut', '0 turns this section off.', 0);
    num('Max "archive" proposals', 'maxArchive', '0 turns this section off.', 0);
    text('Archive sets this property', 'archiveProperty'); text('... to this value', 'archiveValue');
    text('How-to folders (optional)', 'processFolders', 'Comma-separated. Notes here are never proposed links into the project folders below.');
    text('Project folders (optional)', 'projectFolders', 'Comma-separated.');
    new Setting(c).setName('Other').setHeading();
    tog('Write the AI index (.truebrain/index.tsv)', 'aiIndex', 'One line per note for AI assistants and scripts.');
    num('Storm threshold (changes in 10 s)', 'stormThreshold', 'Above this, TrueBrain pauses its live work until changes settle.');
  }
}

// reachable for tests of the built bundle (test/run.js); not used by the plugin itself
TrueBrainPublic.internals = { packFlow, unpackFlow, usedBy, listPacks, makeProposals, applyProposals, core: C };
module.exports = TrueBrainPublic;
