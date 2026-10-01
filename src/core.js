'use strict';
/* TrueBrain core: pure functions with no Obsidian dependency, so they can be tested with plain Node.
 * Everything here works on plain data (paths, frontmatter objects, link lists, usage events). */

const DAY = 86400000;

// ---------------------------------------------------------------- small helpers
const baseName = (p) => p.replace(/^.*\//, '').replace(/\.md$/i, '');
const folderOf = (p) => (p.includes('/') ? p.replace(/\/[^/]*$/, '') : '');
const csv = (s) => String(s || '').split(',').map((x) => x.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
const inFolders = (path, folders) => folders.some((f) => path === f || path.startsWith(f + '/'));
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const isoStamp = (d) => isoDate(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, '0'); };
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 100);
const fmString = (v) => (Array.isArray(v) ? v.join(' ') : v == null ? '' : String(v));

// ---------------------------------------------------------------- find
/* entries: [{path, name, summary, tags, type, heat}]  ->  ranked hits
 * Every word must match somewhere: name (6, word start) > summary (3) > tags (2) > path (1). */
function rankNotes(entries, query, opts) {
  opts = opts || {};
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const e of entries) {
    if (opts.type && e.type !== opts.type) continue;
    const nm = e.name.toLowerCase(), sm = (e.summary || '').toLowerCase(), tg = (e.tags || '').toLowerCase(), pa = e.path.toLowerCase();
    let score = 0, ok = true;
    for (const w of words) {
      const re = new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const s = (re.test(nm) ? 6 : 0) + (sm.includes(w) ? 3 : 0) + (tg.includes(w) ? 2 : 0) + (pa.includes(w) ? 1 : 0);
      if (!s) { ok = false; break; }
      score += s;
    }
    if (ok) hits.push({ entry: e, score: score + Math.min(e.heat || 0, 30) / 30 });
  }
  hits.sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
  return opts.limit ? hits.slice(0, opts.limit) : hits;
}

// ---------------------------------------------------------------- heat
/* events: [{t: ISO, note: path, tool, session}]; notes: [{path, mtime, ctime, back, out, hub, keep}]
 * links: {src: [dst...]} (resolved, body links only for "never followed")  ->  heat model */
function computeHeat(events, notes, links, now, opts) {
  opts = Object.assign({ coldDays: 90, followMin: 10, readsForNever: 5 }, opts || {});
  const t30 = now - 30 * DAY;
  const reads = new Map(), last = new Map(), sessions = new Map();
  for (const ev of events) {
    const t = Date.parse(ev.t); if (!isFinite(t)) continue;
    if (t >= t30) reads.set(ev.note, (reads.get(ev.note) || 0) + 1);
    if (!last.has(ev.note) || last.get(ev.note) < t) last.set(ev.note, t);
    const s = ev.session || 'none';
    if (!sessions.has(s)) sessions.set(s, []);
    sessions.get(s).push([t, ev.note]);
  }
  // link follows: B opened within followMin minutes after A, and A links to B
  const linkSet = new Set();
  for (const [src, dsts] of Object.entries(links || {})) for (const d of dsts) linkSet.add(src + '\u0000' + d);
  const follows = new Map(), pairs = new Map();
  for (const seq of sessions.values()) {
    seq.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < seq.length; i++) {
      const [ta, a] = seq[i - 1], [tb, b] = seq[i];
      if (a !== b && tb - ta <= opts.followMin * 60000 && linkSet.has(a + '\u0000' + b)) {
        const k = a + '\u0000' + b; follows.set(k, (follows.get(k) || 0) + 1);
      }
    }
    const uniq = [...new Set(seq.map((x) => x[1]))].sort().slice(0, 60);   // cap: pairs grow as n^2
    for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) {
      const k = uniq[i] + '\u0000' + uniq[j]; pairs.set(k, (pairs.get(k) || 0) + 1);
    }
  }
  const out = [];
  for (const n of notes) {
    const r = reads.get(n.path) || 0;
    const edited = n.mtime >= t30 ? 1 : 0;
    const used = Math.max(last.get(n.path) || 0, n.mtime || 0);
    const idle = used ? Math.floor((now - used) / DAY) : null;
    const old = !n.ctime || now - n.ctime >= opts.coldDays * DAY;
    const score = Math.round((r * 2 + edited * 1.5 + Math.min(n.back || 0, 10) * 0.3) * 10) / 10;
    const cold = !n.hub && !n.keep && old && idle != null && idle >= opts.coldDays && (n.back || 0) <= 2;
    out.push({ note: n.path, score, reads30: r, edited30: edited, back: n.back || 0, out: n.out || 0, idle, cold });
  }
  out.sort((a, b) => b.score - a.score || a.note.localeCompare(b.note));
  const never = [];
  for (const [src, dsts] of Object.entries(links || {})) {
    const meta = notes.find((n) => n.path === src);
    if (!meta || meta.hub || (reads.get(src) || 0) < opts.readsForNever) continue;
    for (const d of dsts) if (!follows.has(src + '\u0000' + d)) never.push({ a: src, b: d, reads: reads.get(src) });
  }
  const split = (k) => k.split('\u0000');
  return {
    generated: isoStamp(new Date(now)), notes: out,
    follows: [...follows].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([k, n]) => ({ a: split(k)[0], b: split(k)[1], n })),
    pairs: [...pairs].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([k, n]) => ({ a: split(k)[0], b: split(k)[1], sessions: n })),
    never: never.sort((x, y) => y.reads - x.reads).slice(0, 200),
  };
}

function parseEvents(text, sinceMs) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && e.note && e.t && (!sinceMs || Date.parse(e.t) >= sinceMs)) out.push(e); } catch (err) { /* skip bad line */ }
  }
  return out;
}

// ---------------------------------------------------------------- text helpers for proposals
/* blank frontmatter, code, links, urls, headings and %% comments, keeping offsets (same length) */
function blankPlain(text, fmEnd) {
  const blank = (m) => ' '.repeat(m.length);
  let s = ' '.repeat(fmEnd || 0) + text.slice(fmEnd || 0);
  s = s.replace(/```[\s\S]*?```/g, blank).replace(/%%[\s\S]*?%%/g, blank).replace(/`[^`\n]*`/g, blank)
    .replace(/!?\[\[[^\]\n]*\]\]/g, blank).replace(/\[[^\]\n]*\]\([^)\n]*\)/g, blank)
    .replace(/https?:\/\/\S+/g, blank).replace(/^#.*$/gm, blank);
  return s;
}

/* find the first whole-word, case-insensitive occurrence of name in a blanked text; -1 if none */
function findMention(plainLower, nameLower) {
  let i = plainLower.indexOf(nameLower);
  const word = (c) => /[a-z0-9]/i.test(c || '');
  while (i >= 0 && (word(plainLower[i - 1]) || word(plainLower[i + nameLower.length]))) i = plainLower.indexOf(nameLower, i + 1);
  return i;
}

const PROPOSAL_LINE = /^- \[( |x|X)\] (.*?)\s*%%tb:(\w+)%%\s*$/;
function parseProposalLines(text) {
  return String(text).split('\n').map((line, i) => { const m = PROPOSAL_LINE.exec(line); return m ? { index: i, ticked: m[1] !== ' ', text: m[2], id: m[3] } : null; }).filter(Boolean);
}

// ---------------------------------------------------------------- packs (vaulting)
const ZW = '​';
function defang(text, names) {
  let t = text.replace(/\[\[/g, '[' + ZW + '[').replace(/\]\(/g, ']' + ZW + '(').replace(/(^|\s)#(?=\w)/g, '$1#' + ZW);
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    if (n.length > 2) t = t.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => m[0] + ZW + m.slice(1));
  }
  return t;
}
const fenceFor = (text) => '`'.repeat(Math.max(4, ...((text.match(/`+/g) || []).map((r) => r.length + 1))));
const chunk = (s, n) => { const o = []; for (let i = 0; i < s.length; i += n) o.push(s.slice(i, i + n)); return o; };

/* card: lines of markdown; files: [{path, b64}] (gzip+base64 already); previews: [{path, text}] */
function buildPackText(card, manifestB64, files, previews, names) {
  const out = card.slice();
  out.push('', '## Browse (read-only copy: links and names are disabled on purpose; unpack to use)', '');
  for (const p of previews) {
    const body = defang(p.text, names); const f = fenceFor(body);
    out.push('### ' + defang(p.path, names), '', f + 'text', body.replace(/\n+$/, ''), f, '');
  }
  out.push('## Sealed (exact bytes for unpacking: do not edit)', '', '%% truebrain-pack v1 %%', '');
  out.push('~~~~truebrain-manifest', ...chunk(manifestB64, 100), '~~~~', '');
  for (const f of files) out.push('~~~~truebrain-file ' + JSON.stringify(f.path), ...chunk(f.b64, 100), '~~~~', '');
  return out.join('\n');
}

/* -> {manifestB64, files: {path: b64}} or null */
function parsePackText(text) {
  const lines = String(text).split('\n'); let manifestB64 = null; const files = {};
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (L === '~~~~truebrain-manifest' || L.startsWith('~~~~truebrain-file ')) {
      let j = i + 1; const buf = [];
      while (j < lines.length && lines[j] !== '~~~~') buf.push(lines[j++]);
      if (L === '~~~~truebrain-manifest') manifestB64 = buf.join(''); else files[JSON.parse(L.slice(19))] = buf.join('');
      i = j;
    }
  }
  return manifestB64 ? { manifestB64, files } : null;
}

async function gzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function gunzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

module.exports = {
  DAY, baseName, folderOf, csv, inFolders, isoDate, isoStamp, hash, safeName, fmString,
  rankNotes, computeHeat, parseEvents, blankPlain, findMention, parseProposalLines, PROPOSAL_LINE,
  defang, buildPackText, parsePackText, gzip, gunzip, sameBytes, ZW,
};
