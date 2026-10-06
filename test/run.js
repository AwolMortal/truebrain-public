'use strict';
/* node test/run.js : tests TrueBrain Public against the in-memory Obsidian stand-in (test/mock.js).
 * It loads the BUILT main.js, so it tests exactly what ships. Prints one line: TESTS PASS n/n or the failures. */
const Module = require('module');
const path = require('path');
const M = require('./mock');
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'obsidian' ? M.obsidianStub : origLoad.call(this, req, ...rest); };
global.window = { setTimeout, clearTimeout, setInterval, clearInterval };
global.document = { querySelectorAll: () => [] };

const Plugin = require(path.join(__dirname, '..', 'main.js'));
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log('FAIL: ' + name); } };
const C = Plugin.internals.core;

async function newPlugin(files, settings) {
  const app = M.makeApp(files);
  const p = new Plugin(app, { id: 'truebrain-public', dir: '' });
  p.settings = Object.assign({}, {
    inboxFolder: 'Inbox', packFolder: 'Archive', reportFolder: 'TrueBrain', excludeFolders: 'Templates', summaryProperty: 'summary', requireSummary: true,
    parentProperty: '', coldDays: 90, hotTop: 15, logOpens: true, liveHeat: true, explorerMarks: true, weeklyProposals: true, maxAdd: 15, maxCut: 10, maxArchive: 15,
    archiveProperty: 'status', archiveValue: 'paused', processFolders: '', projectFolders: '', keepStatuses: 'evergreen', aiIndex: true, stormThreshold: 40 }, settings || {});
  p.saveSettings = async () => {}; p.refreshAll = async () => {}; p.status = null;
  return { p, app };
}
const lastModal = () => M.Modal.opened[M.Modal.opened.length - 1];

(async () => {
  // ---- core: find ranking
  const entries = [
    { path: 'Craft/Dark Canvas Lighting.md', name: 'Dark Canvas Lighting', summary: 'How to light dark rooms with pools of light', tags: 'lighting', type: 'process' },
    { path: 'Notes/Lighting budget.md', name: 'Lighting budget', summary: 'numbers', tags: '', type: 'note' },
    { path: 'Notes/Shopping.md', name: 'Shopping', summary: 'milk, light bulbs', tags: '', type: 'note' },
  ];
  const r = C.rankNotes(entries, 'lighting');
  ok(r.length === 2 && r[0].entry.name === 'Dark Canvas Lighting', 'find: name+summary+tag beats name only');
  ok(C.rankNotes(entries, 'dark pools').length === 1, 'find: all words must match');
  ok(C.rankNotes(entries, 'lighting', { type: 'process' }).length === 1, 'find: type filter');

  // ---- core: mention finder respects word edges and blanks code/links/headings
  const t = '---\nsummary: x\n---\n# Dark Canvas Lighting heading\nSee `dark canvas lighting` and [[Dark Canvas Lighting]]. Use dark canvas lighting here.\n';
  const plain = C.blankPlain(t, 18).toLowerCase();
  const i = C.findMention(plain, 'dark canvas lighting');
  ok(i > 0 && t.substr(i, 20) === 'dark canvas lighting' && t.slice(i - 4, i) === 'Use ', 'mention: skips heading, code and existing link; finds the plain one');
  ok(C.findMention('notdark canvas lightings', 'dark canvas lighting') === -1, 'mention: whole words only');

  // ---- core: heat (follows, pairs, cold)
  const now = Date.parse('2026-10-01T12:00:00');
  const ev = (min, note, s) => ({ t: C.isoStamp(new Date(now - 86400000 + min * 60000)), note, session: s });
  const events = [ev(0, 'A.md', 's1'), ev(2, 'B.md', 's1'), ev(0, 'A.md', 's2'), ev(3, 'B.md', 's2'), ev(5, 'A.md', 's3'), ev(6, 'A.md', 's3'), ev(7, 'A.md', 's3'), ev(8, 'A.md', 's3')];
  const H = C.computeHeat(events, [
    { path: 'A.md', mtime: now, ctime: now - 400 * 86400000, back: 1 }, { path: 'B.md', mtime: now, ctime: now - 400 * 86400000, back: 1 },
    { path: 'Old.md', mtime: now - 200 * 86400000, ctime: now - 400 * 86400000, back: 0 }, { path: 'Hub MOC.md', mtime: now - 200 * 86400000, ctime: now - 400 * 86400000, back: 0, hub: true }],
    { 'A.md': ['B.md', 'Old.md'] }, now, { coldDays: 90 });
  ok(H.follows.length === 1 && H.follows[0].n === 2, 'heat: A->B followed twice');
  ok(H.pairs.length === 1 && H.pairs[0].sessions === 2, 'heat: A and B used together in 2 sessions');
  ok(H.notes.find((n) => n.note === 'Old.md').cold && !H.notes.find((n) => n.note === 'Hub MOC.md').cold, 'heat: idle note is cold, hub never is');
  ok(H.never.some((x) => x.a === 'A.md' && x.b === 'Old.md'), 'heat: A read 6 times, A->Old never followed');

  // ---- plugin: capture, duplicate refusal
  {
    const { p, app } = await newPlugin({ 'Notes/Existing Idea.md': '---\nsummary: x\n---\nhi' });
    const f = await p.capture('decision', 'Use seeded RNG', 'Vendors draw from a seeded generator', '', 'Game');
    const text = await app.vault.read(f);
    ok(/^Inbox\/\d{4}-\d{2}-\d{2} Use seeded RNG\.md$/.test(f.path), 'capture: decision lands in Inbox with a date prefix');
    ok(text.includes('type: decision') && text.includes('summary: "Vendors draw') && text.includes('project: Game') && text.includes('## Why'), 'capture: frontmatter and skeleton');
    ok((await p.capture('finding', 'Existing Idea', 'dup', '')) === null, 'capture: refuses a duplicate name');
  }

  // ---- plugin: proposals -> tick -> apply
  {
    const { p, app } = await newPlugin({
      'Craft/Dark Canvas Lighting.md': '---\nsummary: lighting how-to\n---\nBody.',
      'Projects/Game Level One Plan.md': '---\nsummary: a project\n---\nPlan.',
      'Craft/Room Notes.md': '---\nsummary: notes\n---\nStart from dark canvas lighting. See the game level one plan too.',
    }, { processFolders: 'Craft', projectFolders: 'Projects' });
    await p.runProposals(false);
    const note = app.vault.getMarkdownFiles().find((f) => f.basename.startsWith('TrueBrain Proposals'));
    ok(!!note, 'proposals: note created in the inbox');
    let txt = await app.vault.read(note);
    ok(txt.includes('mentions "dark canvas lighting"'), 'proposals: unlinked mention found');
    ok(!txt.split('## Cut')[0].includes('Game Level One Plan'), 'proposals: a how-to is never proposed a link into a project');
    await app.vault.modify(note, txt.replace('- [ ] ', '- [x] '));
    await (async () => { const before = await app.vault.read(app.vault.getAbstractFileByPath('Craft/Room Notes.md')); ok(!before.includes('[['), 'apply: nothing changed before the tick is applied'); })();
    await runApply(p, note);
    const after = await app.vault.read(app.vault.getAbstractFileByPath('Craft/Room Notes.md'));
    ok(after.includes('[[Dark Canvas Lighting|dark canvas lighting]]'), 'apply: the ticked mention became a link, words kept');
    txt = await app.vault.read(note);
    ok(/\(applied \d{4}-\d{2}-\d{2}\)/.test(txt), 'apply: the line is marked applied');
  }

  // ---- the same vault with the rule switched off: the project link IS proposed (so the check above can fail)
  {
    const { p, app } = await newPlugin({
      'Craft/Room Notes.md': ['---', 'summary: notes', '---', 'See the game level one plan too.'].join('\n'),
      'Projects/Game Level One Plan.md': ['---', 'summary: a project', '---', 'Plan.'].join('\n') });
    await p.runProposals(false);
    const note = app.vault.getMarkdownFiles().find((f) => f.basename.startsWith('TrueBrain Proposals'));
    ok((await app.vault.read(note)).split('## Cut')[0].includes('Game Level One Plan'), 'proposals: with the rule off, the mention is proposed');
  }

  // ---- plugin: pack a folder, check, unpack, check bytes and links
  {
    const img = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 250, 0, 7]);
    const { p, app } = await newPlugin({
      'Old Game/Old Game.md': '---\nsummary: A finished game\n---\nUses [[Dark Canvas Lighting]]. ![[shot.png]]',
      'Old Game/Level.md': '---\nsummary: a level\n---\nPart of [[Old Game]].',
      'Old Game/shot.png': img,
      'Craft/Dark Canvas Lighting.md': '---\nsummary: lighting\n---\nUsed by nothing on purpose.',
      'Home.md': '---\nsummary: home\nparent: "[[Old Game]]"\n---\nProjects: [[Old Game|the old game]] and [[Level]].',
    });
    const folder = app.vault.getAbstractFileByPath('Old Game');
    const { packFlow, unpackFlow } = loadInternals();
    packFlow(p, folder);
    const m1 = lastModal(); ok(m1 && /3 files go into one note/.test(m1.text) && /3 links from live notes/.test(m1.text), 'pack: dry run lists 3 files and 3 inbound links');
    ok(app.vault.getAbstractFileByPath('Old Game/Level.md'), 'pack: dry run changed nothing');
    await m1.run('old-game');
    const pack = app.vault.getAbstractFileByPath('Archive/old-game.md');
    ok(!!pack && !app.vault.getAbstractFileByPath('Old Game/Level.md'), 'pack: one pack note, originals gone (to the trash)');
    ok(app.vault.trashed.length === 3, 'pack: originals went to the trash, not deleted');
    const home = await app.vault.read(app.vault.getAbstractFileByPath('Home.md'));
    ok(!home.includes('[[Old Game') && !home.includes('[[Level') && home.includes('the old game%%tb-pack:old-game:'), 'pack: live links became plain text with markers');
    const packText = await app.vault.read(pack);
    ok(!/\[\[/.test(packText.replace(/```[\s\S]*?```/g, '')) && packText.includes('[​['), 'pack: the browse copy has no live links');
    ok(!(app.metadataCache.resolvedLinks['Archive/old-game.md'] || {})['Craft/Dark Canvas Lighting.md'], 'pack: the process note gets no backlink from the pack');
    unpackFlow(p, pack); await new Promise((r) => setTimeout(r, 50));
    const m2 = lastModal(); ok(m2 && /3 files come back/.test(m2.text) && /3 of 3 disconnected links/.test(m2.text), 'unpack: dry run sees 3 files and 3 links');
    await m2.run();
    const back = new Uint8Array(await app.vault.readBinary(app.vault.getAbstractFileByPath('Old Game/shot.png')));
    ok(C.sameBytes(back, img), 'unpack: binary attachment restored byte for byte');
    ok((await app.vault.read(app.vault.getAbstractFileByPath('Old Game/Level.md'))) === '---\nsummary: a level\n---\nPart of [[Old Game]].', 'unpack: note restored exactly');
    const home2 = await app.vault.read(app.vault.getAbstractFileByPath('Home.md'));
    ok(home2 === '---\nsummary: home\nparent: "[[Old Game]]"\n---\nProjects: [[Old Game|the old game]] and [[Level]].', 'unpack: every link restored exactly (body and property)');
    ok(!app.vault.getAbstractFileByPath('Archive/old-game.md'), 'unpack: pack note removed');
  }

  // ---- plugin: report and AI index
  {
    const { p, app } = await newPlugin({ 'A.md': '---\nsummary: has one\n---\nSee [[Missing Note]].', 'B.md': 'no summary', 'x/B.md': '---\nsummary: dup\n---\n' });
    await p.writeReport(false);
    const rep = await app.vault.read(app.vault.getAbstractFileByPath('TrueBrain/TrueBrain Report.md'));
    ok(rep.includes('Missing Note') && rep.includes('`B.md`, `x/B.md`') && /\| 3 \| 1 \| off \| 1 \| 1 \|/.test(rep), 'report: broken link, duplicate, missing summary counted');
    await p.writeIndex(false);
    const idx = app.vault.adapter.data.get('.truebrain/index.tsv');
    ok(idx && idx.split('\n')[0].startsWith('path\tname') && idx.includes('A.md\tA\t\thas one'), 'index: one tab-separated line per note');
  }

  // ---- 0.1.1 fixes: each test below fails on 0.1.0
  // a second proposals run on the same day reuses the note, does no work, and says so (0.1.0 said "-1 proposals")
  {
    const { p } = await newPlugin({ 'A.md': '---\nsummary: a\n---\nhi' });
    await p.runProposals(true);
    let heatCalls = 0; const real = p.getHeat.bind(p); p.getHeat = async (f) => { heatCalls++; return real(f); };
    const before = M.notices.length;
    await p.runProposals(true);
    const said = M.notices.slice(before).join(' | ');
    ok(/already made/.test(said) && !/-1/.test(said), 'proposals: a second run the same day says the note already exists, not "-1 proposals"');
    ok(heatCalls === 0, 'proposals: a second run the same day skips the heat pass');
  }
  // a max of 0 turns a proposal section off
  {
    const { p, app } = await newPlugin({ 'Craft/Room Notes.md': '---\nsummary: notes\n---\nSee the game level one plan too.',
      'Projects/Game Level One Plan.md': '---\nsummary: a project\n---\nPlan.' }, { maxAdd: 0 });
    await p.runProposals(false);
    const note = app.vault.getMarkdownFiles().find((f) => f.basename.startsWith('TrueBrain Proposals'));
    ok(/## Add links\n\(nothing this week\)/.test(await app.vault.read(note)), 'proposals: maxAdd 0 proposes no links');
  }
  // the first AI index after startup carries real heat (0.1.0 wrote heat 0 until heat had been computed once)
  {
    const { p, app } = await newPlugin({ 'A.md': '---\nsummary: a\n---\nhi', 'B.md': '---\nsummary: b\n---\nho' });
    const t = C.isoStamp(new Date(Date.now() - 3600000));
    app.vault.adapter.data.set('.truebrain/usage.jsonl', [1, 2, 3].map(() => JSON.stringify({ t, note: 'A.md', tool: 'open', session: 's' })).join('\n') + '\n');
    p.heat = null;
    await p.writeIndex(false);
    const row = app.vault.adapter.data.get('.truebrain/index.tsv').split('\n').find((l) => l.startsWith('A.md\t'));
    ok(row && Number(row.split('\t')[5]) > 0, 'index: the first index after startup has real heat');
  }
  // unloading stops pending timers, and nothing is written after (0.1.0 left them armed)
  {
    const { p, app } = await newPlugin({ 'A.md': '---\nsummary: a\n---\nhi' });
    const realSet = global.window.setTimeout, realClear = global.window.clearTimeout, cleared = new Set();
    global.window.setTimeout = (fn, ms) => realSet(fn, 3600000); global.window.clearTimeout = (id) => { cleared.add(id); realClear(id); };
    try {
      p.queueIndex(); p.scheduleMarks(); const ids = [p._ix, p._mt].filter(Boolean);
      p.onunload();
      ok(ids.length === 2 && ids.every((id) => cleared.has(id)), 'unload: pending index and marks timers are cleared');
      app.vault.adapter.data.delete('.truebrain/index.tsv');
      await p.writeIndex(false);
      ok(!app.vault.adapter.data.has('.truebrain/index.tsv'), 'unload: no index is written after unload');
    } finally { global.window.setTimeout = realSet; global.window.clearTimeout = realClear; }
  }
  // the 15-second startup-upkeep timer is also cleared on unload (found by the Obsidian review lint pass)
  {
    const { p } = await newPlugin({ 'A.md': 'x' });
    const realClear = global.window.clearTimeout, cleared = new Set();
    global.window.clearTimeout = (id) => { cleared.add(id); realClear(id); };
    try { p._up = 4242; p.onunload(); ok(cleared.has(4242), 'unload: the startup upkeep timer is cleared'); }
    finally { global.window.clearTimeout = realClear; }
  }
  // the usage log is trimmed to what heat reads, and left alone when already trim
  {
    const old = C.isoStamp(new Date(Date.now() - 500 * C.DAY)), recent = C.isoStamp(new Date(Date.now() - C.DAY));
    const text = [JSON.stringify({ t: old, note: 'A.md' }), 'not json', JSON.stringify({ t: recent, note: 'B.md' }), ''].join('\n');
    const r = C.compactEvents(text, Date.now() - 400 * C.DAY);
    ok(r.kept === 1 && r.dropped === 2 && r.text.includes('B.md') && !r.text.includes('A.md'), 'usage: old events and bad lines are dropped, recent ones kept');
    const { p, app } = await newPlugin({ 'B.md': '---\nsummary: b\n---\nhi' });
    app.vault.adapter.data.set('.truebrain/usage.jsonl', text);
    ok((await p.compactUsage()).dropped === 2 && app.vault.adapter.data.get('.truebrain/usage.jsonl') === r.text, 'usage: the plugin rewrites the log trimmed');
    let writes = 0; const w = p.writeData.bind(p); p.writeData = async (n, t2) => { writes++; return w(n, t2); };
    ok((await p.compactUsage()).dropped === 0 && writes === 0, 'usage: an already trim log is not rewritten');
  }
  // a restored file beside a taken name keeps a sane name, with or without an extension
  ok(C.besidePath('a/b.md') === 'a/b (unpacked).md', 'unpack: beside name keeps the extension');
  ok(C.besidePath('a/Makefile') === 'a/Makefile (unpacked)', 'unpack: a file with no extension is not cut (0.1.0 cut its last character)');
  ok(C.besidePath('a.b/c') === 'a.b/c (unpacked)', 'unpack: a dot in a folder name is not an extension');
  ok(C.besidePath('a/.hidden') === 'a/.hidden (unpacked)', 'unpack: a leading-dot name is not an extension');

  console.log(fail ? 'TESTS FAIL ' + fail + ' of ' + (pass + fail) : 'TESTS PASS ' + pass + '/' + pass);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('TESTS CRASH: ' + (e.stack || e)); process.exit(1); });

function loadInternals() { return Plugin.internals; }   // the shipped bundle's own modules
async function runApply(p, note) { await loadInternals().applyProposals(p, note); }
