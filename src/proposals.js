'use strict';
/* Weekly strengthening pass: proposals in one inbox note; only ticked items are applied. */
const { Notice, TFile, normalizePath } = require('obsidian');
const C = require('./core');

const PREFIX = 'TrueBrain Proposals ';
const fmEndOf = (t) => { if (!t.startsWith('---')) return 0; const e = t.indexOf('\n---', 3); return e < 0 ? 0 : e + 4; };

async function loadJson(P, name, dflt) { try { const t = await P.readData('proposals/' + name); return t ? JSON.parse(t) : dflt; } catch (e) { return dflt; } }
async function saveJson(P, name, obj) { await P.ensureData(); const a = P.app.vault.adapter; if (!(await a.exists('.truebrain/proposals'))) await a.mkdir('.truebrain/proposals'); await P.writeData('proposals/' + name, JSON.stringify(obj, null, 1)); }

function proposalNotes(P) { return P.app.vault.getMarkdownFiles().filter((f) => f.basename.startsWith(PREFIX)).sort((a, b) => a.basename.localeCompare(b.basename)); }

/* a line deleted from a proposals note = "no": never propose it again */
async function harvest(P) {
  const rejected = await loadJson(P, 'rejected.json', {});
  for (const f of proposalNotes(P)) {
    const data = await loadJson(P, f.basename + '.json', null); if (!data) continue;
    const ids = new Set(C.parseProposalLines(await P.app.vault.cachedRead(f)).map((x) => x.id));
    for (const [id, item] of Object.entries(data.items || {})) if (!ids.has(id) && !item.applied && !rejected[id]) rejected[id] = C.isoDate(new Date());
  }
  await saveJson(P, 'rejected.json', rejected);
  return rejected;
}

async function makeProposals(P) {
  const S = P.settings, MC = P.app.metadataCache, RL = MC.resolvedLinks;
  const rejected = await harvest(P);
  // one note per day: if today's exists, keep what was ticked and do none of the work below
  const today = C.isoDate(new Date()), name = PREFIX + today;
  const path = normalizePath((S.inboxFolder ? S.inboxFolder + '/' : '') + name + '.md');
  if (P.app.vault.getAbstractFileByPath(path)) return { path, total: 0, existing: true };
  const heat = await P.getHeat(true);
  const proc = C.csv(S.processFolders), proj = C.csv(S.projectFolders);
  const forbidden = (a, b) => proc.length && proj.length && C.inFolders(a, proc) && C.inFolders(b, proj);   // a how-to never links a project
  const linked = (a, b) => !!(RL[a] && RL[a][b]);
  const notes = P.notes().filter((f) => !f.basename.startsWith(PREFIX));
  const out = { add: [], cut: [], archive: [] };

  // ADD 1: unlinked mentions (a note names another note in plain text without linking it)
  const byFirst = new Map();
  for (const f of notes) {
    const n = f.basename.toLowerCase();
    if (n.length < 10 || !n.includes(' ') || P.isHub(f)) continue;
    const w = n.split(/[^a-z0-9]+/).filter(Boolean)[0]; if (!w) continue;
    if (!byFirst.has(w)) byFirst.set(w, []); byFirst.get(w).push(f);
  }
  for (const a of notes) {
    if (P.isHub(a)) continue;
    const text = await P.app.vault.cachedRead(a);
    const plain = C.blankPlain(text, fmEndOf(text)).toLowerCase();
    const words = new Set(plain.split(/[^a-z0-9]+/).filter(Boolean));
    let per = 0;
    for (const w of words) for (const b of byFirst.get(w) || []) {
      if (per >= 3 || b === a || linked(a.path, b.path) || forbidden(a.path, b.path)) continue;
      const i = C.findMention(plain, b.basename.toLowerCase()); if (i < 0) continue;
      per++;
      out.add.push({ id: C.hash('mention|' + a.path + '|' + b.path), kind: 'mention', a: a.path, b: b.path, words: text.substr(i, b.basename.length),
        why: 'mentions "' + text.substr(i, b.basename.length) + '" without a link', strength: b.basename.length });
    }
  }
  // ADD 2: used together in 2+ sessions, not linked either way
  for (const p of heat.pairs) {
    let [a, b] = [p.a, p.b];
    if (linked(a, b) || linked(b, a)) continue;
    if (forbidden(a, b)) [a, b] = [b, a];
    if (forbidden(a, b)) continue;
    out.add.push({ id: C.hash('pair|' + [a, b].sort().join('|')), kind: 'pair', a, b, why: 'used together in ' + p.sessions + ' sessions, not linked', strength: 100 + p.sessions });
  }
  // CUT: a link never followed although its note was read often
  for (const n of heat.never) out.cut.push({ id: C.hash('cut|' + n.a + '|' + n.b), kind: 'cut', a: n.a, b: n.b, why: C.baseName(n.a) + ' read ' + n.reads + ' times, this link never followed', strength: n.reads });
  // ARCHIVE: cold notes
  for (const n of heat.notes) {
    if (!n.cold) continue;
    const f = P.app.vault.getAbstractFileByPath(n.note);
    if (!(f instanceof TFile) || C.fmString(P.fm(f)[S.archiveProperty]) === S.archiveValue) continue;
    out.archive.push({ id: C.hash('archive|' + n.note), kind: 'archive', a: n.note, why: 'idle ' + n.idle + ' days, ' + n.back + ' links in', strength: n.idle });
  }
  const max = { add: S.maxAdd, cut: S.maxCut, archive: S.maxArchive };
  for (const k of Object.keys(out)) out[k] = out[k].filter((x) => !rejected[x.id]).sort((x, y) => y.strength - x.strength).slice(0, max[k]);

  const total = out.add.length + out.cut.length + out.archive.length;
  await P.ensureFolder(S.inboxFolder);
  const L = (p) => '[' + C.baseName(p) + '](' + P.uri(p) + ')';
  const md = ['---', 'type: proposals', S.summaryProperty + ': "TrueBrain link proposals for ' + today + ': ' + total + ' to review."', 'created: ' + today, '---', '# ' + name, '',
    'Tick what should happen, then run **TrueBrain: Apply ticked proposals**. Unticked = undecided. **Delete a line** = no, never suggest it again.',
    'Nothing changes without a tick. Links here are obsidian:// links, so this note adds no backlinks.', ''];
  const sec = { add: '## Add links', cut: '## Cut links (never followed)', archive: '## Archive (cold notes)' };
  for (const k of ['add', 'cut', 'archive']) {
    md.push(sec[k]);
    if (!out[k].length) md.push('(nothing this week)');
    for (const x of out[k]) {
      const txt = k === 'add' ? '**' + L(x.a) + '** -> link ' + L(x.b) + ': ' + x.why : k === 'cut' ? '**' + L(x.a) + '** -/-> ' + L(x.b) + ': ' + x.why : '**' + L(x.a) + '**: ' + x.why;
      md.push('- [ ] ' + txt + ' %%tb:' + x.id + '%%');
    }
    md.push('');
  }
  await P.app.vault.create(path, md.join('\n'));
  const items = {}; for (const k of Object.keys(out)) for (const x of out[k]) items[x.id] = x;
  await saveJson(P, name + '.json', { made: today, items });
  return { path, total };
}

async function applyOne(P, x) {
  const S = P.settings, MC = P.app.metadataCache, f = P.app.vault.getAbstractFileByPath(x.a);
  if (!(f instanceof TFile)) return 'skipped: the note is gone';
  const b = x.b ? P.app.vault.getAbstractFileByPath(x.b) : null;
  if (x.kind !== 'archive' && !(b instanceof TFile)) return 'skipped: the target is gone';
  let result = 'applied ' + C.isoDate(new Date());
  if (x.kind === 'archive') { await P.app.fileManager.processFrontMatter(f, (fm) => { fm[S.archiveProperty] = S.archiveValue; }); return result; }
  const linktext = MC.fileToLinktext(b, f.path, true);
  await P.app.vault.process(f, (t) => {
    if (x.kind === 'mention') {
      const i = C.findMention(C.blankPlain(t, fmEndOf(t)).toLowerCase(), x.words.toLowerCase());
      if (i < 0) { result = 'skipped: the mention is gone'; return t; }
      const w = t.substr(i, x.words.length);
      return t.slice(0, i) + (w === linktext ? '[[' + w + ']]' : '[[' + linktext + '|' + w + ']]') + t.slice(i + w.length);
    }
    if (x.kind === 'pair') {
      if ((MC.resolvedLinks[f.path] || {})[b.path]) { result = 'skipped: already linked'; return t; }
      return /^## Related\s*$/m.test(t) ? t.replace(/^(## Related\s*\n)/m, '$1- [[' + linktext + ']]\n') : t.replace(/\n*$/, '') + '\n\n## Related\n- [[' + linktext + ']]\n';
    }
    if (x.kind === 'cut') {   // body links only: frontmatter links (parent, etc.) are never cut
      const cache = MC.getFileCache(f) || {}; const end = fmEndOf(t);
      const hits = (cache.links || []).filter((l) => { const d = MC.getFirstLinkpathDest(l.link, f.path); return d && d.path === b.path; })
        .sort((p, q) => q.position.start.offset - p.position.start.offset);
      if (!hits.length) { result = 'skipped: the link is gone'; return t; }
      for (const l of hits) {
        let s = l.position.start.offset;
        if (t.substr(s, l.original.length) !== l.original) s = t.indexOf(l.original, end);
        if (s >= end && s >= 0) t = t.slice(0, s) + (l.displayText || C.baseName(b.path)) + t.slice(s + l.original.length);
      }
      return t;
    }
    return t;
  });
  return result;
}

async function applyProposals(P, file) {
  const notes = proposalNotes(P);
  file = file || notes[notes.length - 1];
  if (!file) return new Notice('TrueBrain: no proposals note yet');
  await harvest(P);
  const data = await loadJson(P, file.basename + '.json', null);
  if (!data) return new Notice('TrueBrain: no data for ' + file.basename);
  const lines = (await P.app.vault.read(file)).split('\n'); let done = 0;
  for (const it of C.parseProposalLines(lines.join('\n'))) {
    if (!it.ticked || /\((applied|skipped)/.test(it.text)) continue;
    const x = data.items[it.id]; if (!x) continue;
    let msg; try { msg = await applyOne(P, x); } catch (e) { msg = 'skipped: ' + e.message; }
    if (msg.startsWith('applied')) { x.applied = C.isoDate(new Date()); done++; }
    lines[it.index] = '- [x] ' + it.text + ' (' + msg + ') %%tb:' + it.id + '%%';
  }
  await P.app.vault.modify(file, lines.join('\n'));
  await saveJson(P, file.basename + '.json', data);
  new Notice('TrueBrain: applied ' + done + ' ticked proposals');
}

module.exports = { makeProposals, applyProposals };
