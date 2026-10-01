'use strict';
/* Cold storage ("packing"): a note or folder becomes ONE visible note holding a readable card, a defanged
 * browse copy and the exact sealed bytes; links into it from live notes become plain text with a marker,
 * so the live graph forgets it. Unpacking restores every file and every link exactly. */
const { Modal, Notice, Setting, TFile, TFolder, normalizePath, arrayBufferToBase64, base64ToArrayBuffer } = require('obsidian');
const C = require('./core');

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = async (bytes) => arrayBufferToBase64((await C.gzip(bytes)).buffer);
const unb64 = async (s) => C.gunzip(new Uint8Array(base64ToArrayBuffer(s)));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pack';

class ConfirmModal extends Modal {
  constructor(app, title, text, label, run, field) { super(app); this.t = title; this.text = text; this.label = label; this.run = run; this.field = field; }
  onOpen() {
    this.titleEl.setText(this.t);
    let val = this.field ? this.field.value : null;
    if (this.field) new Setting(this.contentEl).setName(this.field.label).addText((x) => x.setValue(val).onChange((v) => { val = v; }));
    this.contentEl.createEl('div', { cls: 'truebrain-output', text: this.text });
    new Setting(this.contentEl).addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) => b.setButtonText(this.label).setWarning().onClick(() => { this.close(); this.run(val); }));
  }
  onClose() { this.contentEl.empty(); }
}

function listPacks(P) {
  const folder = normalizePath(P.settings.packFolder || '');
  return P.app.vault.getMarkdownFiles().filter((f) => (!folder || C.inFolders(f.path, [folder])) && P.fm(f).truebrain_pack);
}

/* what packing `target` would do, without changing anything */
function plan(P, target) {
  const V = P.app.vault, MC = P.app.metadataCache;
  let files = target instanceof TFolder ? V.getFiles().filter((f) => C.inFolders(f.path, [target.path])) : [target];
  const inPack = new Set(files.map((f) => f.path));
  // attachments used only by notes in the pack come along
  const users = new Map();
  for (const f of V.getMarkdownFiles()) {
    const c = MC.getFileCache(f) || {};
    for (const l of [].concat(c.embeds || [], c.links || [])) {
      const d = MC.getFirstLinkpathDest(l.link, f.path);
      if (d && d.extension !== 'md') { if (!users.has(d.path)) users.set(d.path, new Set()); users.get(d.path).add(f.path); }
    }
  }
  for (const [att, who] of users) if (!inPack.has(att) && [...who].every((w) => inPack.has(w))) { inPack.add(att); files.push(V.getAbstractFileByPath(att)); }
  files = files.filter((f) => f instanceof TFile);
  // links from live notes into the pack (body, embeds and properties) and from the pack out
  const inbound = [], outgoing = [];
  for (const f of V.getMarkdownFiles()) {
    const c = MC.getFileCache(f) || {};
    const all = [].concat((c.links || []).map((l) => ({ l, fmKey: null })), (c.embeds || []).map((l) => ({ l, fmKey: null })), (c.frontmatterLinks || []).map((l) => ({ l, fmKey: l.key })));
    for (const { l, fmKey } of all) {
      const d = MC.getFirstLinkpathDest(l.link, f.path); if (!d) continue;
      if (inPack.has(f.path) && !inPack.has(d.path)) outgoing.push({ from: f.path, target: d.path, raw: l.original });
      if (!inPack.has(f.path) && inPack.has(d.path)) inbound.push({ file: f.path, original: l.original, display: l.displayText || C.baseName(d.path), offset: l.position ? l.position.start.offset : null, fmKey, target: d.path });
    }
  }
  return { files, inbound, outgoing };
}

function packFlow(P, target) {
  const p = plan(P, target);
  if (!p.files.length) return new Notice('TrueBrain: nothing to pack');
  const lines = ['Packing ' + target.path + ':', '  ' + p.files.length + ' files go into one note in "' + (P.settings.packFolder || '/') + '":'];
  for (const f of p.files.slice(0, 40)) lines.push('     ' + f.path);
  if (p.files.length > 40) lines.push('     ... ' + (p.files.length - 40) + ' more');
  lines.push('  ' + p.inbound.length + ' links from live notes become plain text with a marker (restored on unpack)');
  for (const e of p.inbound.slice(0, 12)) lines.push('     ' + e.file + ': ' + e.original);
  lines.push('  ' + p.outgoing.length + ' links out of the pack are recorded (for "used by")', '', 'The originals then go to the trash. Nothing has changed yet.');
  new ConfirmModal(P.app, 'Pack (dry run first)', lines.join('\n'), 'Pack it', (name) => doPack(P, target, p, slug(name || '')),
    { label: 'Pack name', value: slug(target instanceof TFolder ? target.name : target.basename) }).open();
}

async function doPack(P, target, p, name) {
  const V = P.app.vault, S = P.settings;
  await P.ensureFolder(S.packFolder);
  const packPath = normalizePath((S.packFolder ? S.packFolder + '/' : '') + name + '.md');
  if (V.getAbstractFileByPath(packPath)) return new Notice('TrueBrain: a pack called ' + name + ' already exists');
  const now = new Date(), files = [], previews = [], originals = new Map();
  for (const f of p.files) {
    const bytes = new Uint8Array(await V.readBinary(f)); originals.set(f.path, bytes);
    files.push({ path: f.path, b64: await b64(bytes) });
    if (f.extension === 'md') previews.push({ path: f.path, text: dec.decode(bytes) });
  }
  const seedNote = target instanceof TFile ? target : p.files.find((f) => f.extension === 'md');
  const summary = seedNote ? C.fmString(P.fm(seedNote)[S.summaryProperty]) : '';
  const inbound = p.inbound.map((e, i) => Object.assign({}, e, { id: name + ':' + (i + 1), replacement: e.display + '%%tb-pack:' + name + ':' + (i + 1) + '%%' }));
  const manifest = { schema: 1, pack: name, seed: target.path, packed: C.isoStamp(now), summary, files: p.files.map((f) => ({ path: f.path, size: f.stat.size })), inbound, outgoing: p.outgoing };
  const names = new Set(p.outgoing.map((o) => C.baseName(o.target)));
  const card = ['---', 'truebrain_pack: ' + name, 'status: packed', 'packed: ' + C.isoDate(now), S.summaryProperty + ': "' + ('Packed: ' + (summary || target.path)).replace(/"/g, "'").slice(0, 200) + '"', '---',
    '# Pack: ' + name, '', '> ' + C.defang(summary || '(no summary)', names), '',
    'Packed ' + C.isoDate(now) + ' from `' + C.defang(target.path, names) + '`: ' + p.files.length + ' files, ' + inbound.length + ' live links disconnected. Unpack with **TrueBrain: Unpack** (or the panel).', '',
    '## Contents', ...p.files.map((f) => '- `' + C.defang(f.path, names) + '`'), '',
    '## It used (names disabled on purpose)', ...[...new Set(p.outgoing.map((o) => o.target))].map((t) => '- `' + C.defang(t, names) + '`'), ''];
  const text = C.buildPackText(card, await b64(enc.encode(JSON.stringify(manifest))), files, previews, names);
  const packFile = await V.create(packPath, text);
  // verify every file round-trips before anything is removed
  const back = C.parsePackText(await V.read(packFile));
  for (const f of p.files) {
    const ok = back && back.files[f.path] && C.sameBytes(await unb64(back.files[f.path]), originals.get(f.path));
    if (!ok) { await V.delete(packFile); return new Notice('TrueBrain: pack verification failed; nothing was changed'); }
  }
  // links from live notes -> plain text + marker
  const byFile = new Map(); for (const e of inbound) { if (!byFile.has(e.file)) byFile.set(e.file, []); byFile.get(e.file).push(e); }
  for (const [path, list] of byFile) {
    const f = V.getAbstractFileByPath(path); if (!(f instanceof TFile)) continue;
    await V.process(f, (t) => {
      for (const e of list.slice().sort((a, b) => (b.offset || 0) - (a.offset || 0))) {
        let s = e.offset != null && t.substr(e.offset, e.original.length) === e.original ? e.offset : t.indexOf(e.original);
        if (s >= 0) t = t.slice(0, s) + e.replacement + t.slice(s + e.original.length);
      }
      return t;
    });
  }
  const trash = (f) => (P.app.fileManager.trashFile ? P.app.fileManager.trashFile(f) : V.trash(f, true));
  for (const f of p.files) await trash(f);
  if (target instanceof TFolder && target.children && !target.children.length) await trash(target);
  new Notice('TrueBrain: packed ' + p.files.length + ' files into ' + name);
  P.refreshAll();
}

async function readManifest(P, packFile) {
  const parsed = C.parsePackText(await P.app.vault.read(packFile));
  if (!parsed) throw new Error('not a TrueBrain pack');
  return { parsed, manifest: JSON.parse(dec.decode(await unb64(parsed.manifestB64))) };
}

async function unpackFlow(P, packFile) {
  let m; try { m = await readManifest(P, packFile); } catch (e) { return new Notice('TrueBrain: ' + e.message); }
  const V = P.app.vault, man = m.manifest;
  const targets = man.files.map((f) => {
    let path = f.path;
    if (V.getAbstractFileByPath(path)) { const dot = path.lastIndexOf('.'); path = path.slice(0, dot) + ' (unpacked)' + path.slice(dot); }
    return { from: f.path, to: path };
  });
  let found = 0;
  for (const e of man.inbound) { const f = V.getAbstractFileByPath(e.file); if (f instanceof TFile && (await V.cachedRead(f)).includes(e.replacement)) found++; }
  const lines = ['Unpacking ' + man.pack + ' (packed ' + man.packed + '):', '  ' + targets.length + ' files come back:'];
  for (const t of targets.slice(0, 40)) lines.push('     ' + t.to + (t.to !== t.from ? '   (name taken: restored beside it)' : ''));
  lines.push('  ' + found + ' of ' + man.inbound.length + ' disconnected links can be restored', '', 'The pack note then goes to the trash. Nothing has changed yet.');
  new ConfirmModal(P.app, 'Unpack (dry run first)', lines.join('\n'), 'Unpack it', () => doUnpack(P, packFile, m, targets)).open();
}

async function doUnpack(P, packFile, m, targets) {
  const V = P.app.vault, man = m.manifest;
  for (const t of targets) {
    const dir = C.folderOf(t.to); if (dir) await P.ensureFolder(dir);
    const bytes = await unb64(m.parsed.files[t.from]);
    await V.createBinary(t.to, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  let restored = 0;
  for (const e of man.inbound) {
    const f = V.getAbstractFileByPath(e.file); if (!(f instanceof TFile)) continue;
    await V.process(f, (t) => { const i = t.indexOf(e.replacement); if (i < 0) return t; restored++; return t.slice(0, i) + e.original + t.slice(i + e.replacement.length); });
  }
  await (P.app.fileManager.trashFile ? P.app.fileManager.trashFile(packFile) : V.trash(packFile, true));
  new Notice('TrueBrain: unpacked ' + targets.length + ' files, ' + restored + ' links restored');
  P.refreshAll();
}

async function usedBy(P, file) {
  const out = [];
  for (const pf of listPacks(P)) {
    try { const { manifest } = await readManifest(P, pf); for (const o of manifest.outgoing) if (o.target === file.path) out.push(manifest.pack + ': ' + o.from); }
    catch (e) { /* not a readable pack */ }
  }
  new Notice(out.length ? 'Used by packed notes:\n' + out.slice(0, 15).join('\n') : 'TrueBrain: no packed note links to ' + file.basename, 8000);
}

module.exports = { packFlow, unpackFlow, usedBy, listPacks, plan };
