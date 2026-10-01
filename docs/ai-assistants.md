# Using TrueBrain with AI assistants (Claude, ChatGPT, local agents)

TrueBrain keeps three plain files in `.truebrain/` at the root of your vault. Any assistant that can read
files in your vault (for example Claude Code, or an agent with file access) can use them.

## 1. Search cheaply: `.truebrain/index.tsv`

- **What it holds:** one tab-separated line per note: `path`, `name`, `type`, `summary`, `tags`, `heat`.
- **How to use it:** an assistant should search this file first, for example `grep -i "lighting" .truebrain/index.tsv`, and then open only the notes that matter.
- **Why:** on a large vault that saves most of the reading and tokens.
- **Freshness:** the index is rewritten about a minute after notes change, while Obsidian is open.

## 2. Let reads count as heat: `.truebrain/usage.jsonl`

Append one JSON line per note the assistant reads:

```json
{"t": "2026-10-01T09:30:00", "note": "Projects/My Note.md", "tool": "read", "session": "claude-123"}
```

- `t` is local time.
- `note` is the path inside the vault.
- `session` is any id that stays the same for one conversation.

TrueBrain then counts those reads in the heat, the "used together" pairs and the link-follow statistics.
For Claude Code, a PostToolUse hook that appends a line whenever the Read tool opens a file inside the
vault is enough.

## 3. Save what was learned: captures

Write a note into your inbox folder with these properties:

```yaml
---
type: decision        # or finding, process, note
summary: "One line: what it is and when to use it."
created: 2026-10-01
tags: [capture/decision]
---
```

or open this link (Obsidian creates the note):

```
obsidian://truebrain?action=capture&kind=finding&title=<title>&summary=<summary>&body=<text>
```

## A short instruction for your assistant

```text
My notes are in an Obsidian vault at <path>. Before answering from memory, search
<path>/.truebrain/index.tsv and read only the notes that matter. At the end of a task, save each
durable decision, finding or process as a note in <path>/<Inbox> with the properties
type, summary (one line) and created. One idea per note; never save secrets.
```
