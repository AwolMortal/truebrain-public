# TrueBrain

A second brain that keeps itself in shape. TrueBrain helps you **find** notes by what they are about,
shows which notes and links are **hot** (used) or **cold** (forgotten), suggests **links to add, cut or archive**
once a week (nothing changes until you tick), **packs** finished projects into one note so they stop
cluttering your graph (and unpacks them exactly), and keeps an **index that AI assistants can read**.

No network, no accounts, nothing runs outside Obsidian. Everything it records stays in your vault.

## What it does

| Feature | How you use it |
|---|---|
| **Find** | `TrueBrain: Find notes...`: type a few words; notes rank by name, then their one-line `summary`, then tags and folder. All words must match. |
| **Heat** | The flame icon opens a panel: hot notes, possibly irrelevant (cold) notes, links you actually follow, notes you use together. The file list marks the hottest notes with a dot and dims cold ones. The status bar shows the open note's heat. |
| **Summary check** | The status bar says `NO SUMMARY` on notes without a one-line `summary` property (the property name is a setting). |
| **Capture** | `TrueBrain: Capture...`: pick decision, finding, process or note; give a title and a one-line summary. A note with the right properties and section headings lands in your inbox folder. |
| **Weekly proposals** | Once a week, one note in your inbox lists links to **add** (a note names another without linking it; two notes you use together), links to **cut** (never followed although the note is read often) and notes to **archive** (idle for months). Tick what you want and run `TrueBrain: Apply ticked proposals`. Delete a line to mean "no, never suggest it again". |
| **Cold storage (packs)** | Right-click a folder or note: `TrueBrain: pack into cold storage...`. After a preview, everything goes into ONE note in your cold-storage folder: a readable card, a read-only copy, and the exact bytes. Links from other notes turn into plain text with a hidden marker, so your graph and backlinks forget the project. `TrueBrain: Unpack` puts every file and every link back exactly. The originals go to your trash, not into thin air. |
| **Maintenance report** | Once a day, `TrueBrain/TrueBrain Report.md` lists notes without a summary, broken links, duplicate names, empty notes and old inbox items. |
| **AI index** | `.truebrain/index.tsv` holds one line per note (path, name, type, summary, tags, heat), so an AI assistant can search your vault without reading every note. See [docs/ai-assistants.md](docs/ai-assistants.md). |
| **Storm mode** | When a sync or a script changes many files at once, TrueBrain pauses its live work until things settle, so Obsidian stays responsive. |

## Install

**From Obsidian:** Settings > Community plugins > Browse > search "TrueBrain" (once it is listed).

**Before that, with BRAT:**
1. Install the community plugin "BRAT".
2. Choose "Add a beta plugin" and paste `https://github.com/AwolMortal/truebrain-public`.

**By hand:**
1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Put them in `<your vault>/.obsidian/plugins/truebrain-public/`.
3. Enable TrueBrain in Settings > Community plugins.

## Settings worth a look

- **Folders:** inbox, cold storage and report folders, and folders to leave out (templates, attachments).
- **Summary property:** default `summary`. Notes with a one-line summary are found faster, by you and by AI tools.
- **How-to folders and project folders (optional):** if you keep reusable how-tos apart from projects, TrueBrain never proposes a link from a how-to into a project. Projects link to how-tos, not the other way round, so how-tos stay reusable and packing a project leaves them untouched.
- **Archive sets this property:** what "archive" means for you (default `status: paused`).

## Privacy

- Opens are recorded only in `.truebrain/usage.jsonl` inside your vault. Turn it off in settings.
- TrueBrain makes no network requests.
- Links inside its own notes (proposals, report) are `obsidian://` links, so they add no backlinks and no heat.

## Develop

- `node build.js` joins `src/` into `main.js` (no dependencies).
- `node build.js --vault <path>` also copies the plugin into a vault.
- `node test/run.js` tests the built plugin against an in-memory stand-in for Obsidian.
- `node build.js --check` fails if `main.js` is out of date. Full guide: [docs/develop.md](docs/develop.md).

## Roadmap

- **Hub builder:** for folders with hundreds of notes, generate topic hubs so the graph shows clusters, not a dandelion.
- **Graph heat:** colour graph nodes by heat.
- **Better link-follow tracking:** record actual link clicks.

## License

MIT
