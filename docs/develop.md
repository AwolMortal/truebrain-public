# Developing TrueBrain Public

Plain JavaScript, no dependencies, no bundler. You need Node.js 18 or later and git.

## Set up

```
git clone https://github.com/AwolMortal/truebrain-public.git
cd truebrain-public
node build.js && node test/run.js
```

On a PC without Node, the portable zip from nodejs.org works, unpacked anywhere and put on `PATH`.
No installer or admin rights are needed.

**Commit with your GitHub private address**, not a work or personal email: this repo is public.
Set it for this repo only:

```
git config user.email "<id>+<user>@users.noreply.github.com"
```

## Layout

| Path | What it is |
|---|---|
| `src/core.js` | Pure functions, with no Obsidian: ranking, heat, the proposal text helpers, the pack format. Test here first. |
| `src/packs.js` | Cold storage: pack, unpack, used-by. |
| `src/proposals.js` | The weekly proposals note, and applying ticked lines. |
| `src/plugin.js` | Obsidian wiring: the panel, commands, settings, the report and the AI index. |
| `build.js` | Joins `src/` into `main.js`, the one file Obsidian loads. Commit `main.js` with every change. |
| `test/mock.js` | An in-memory stand-in for the parts of the Obsidian API used. |
| `test/run.js` | Tests that load the BUILT `main.js`, so they test exactly what ships. |
| `example-vault/` | A small vault to try the plugin in. |

## The loop

```
node build.js                          # main.js from src/
node test/run.js                       # TESTS PASS n/n
node build.js --vault example-vault    # also copy the plugin into a vault
node build.js --check                  # exit 1 if main.js is stale (CI runs this)
```

`npm test` runs the build and the tests.

**Write the test so it fails first.** Run it against the previous build and see it fail before
calling a fix done. A test that passes either way protects nothing.

## Line endings

The repo is LF (`.gitattributes`), and `build.js` normalises whatever it reads, so `main.js` is the
same on every machine. A Windows checkout once produced a different build; that is now impossible.

## Releasing

1. Bump `version` in `manifest.json` and `package.json`, and add the version to `versions.json`
   (`"0.1.2": "<minAppVersion>"`).
2. Write `docs/releases/<version>.md`, the release notes.
3. `node build.js && node test/run.js`, then commit, including `main.js`.
4. Tag it with no "v", and push: `git tag 0.1.2 && git push origin main 0.1.2`.

The Release workflow refuses unless the tag, `manifest.json` and `versions.json` agree, `main.js`
matches the sources, and the tests pass. Then it publishes the GitHub release with `main.js`,
`manifest.json` and `styles.css`. BRAT users get the update from there.

## Test in a real vault

Use `example-vault/` or a fresh vault. **Not a vault that already runs the private TrueBrain**: both
would double the panels, the open-tracking and the weekly notes.
