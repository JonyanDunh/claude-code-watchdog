# Contributing to Watchdog

Thanks for your interest in contributing. Watchdog is a small, self-contained Claude Code plugin, so the contribution workflow is intentionally lightweight.

## Quick start

```bash
git clone https://github.com/JonyanDunh/claude-code-watchdog
cd claude-code-watchdog
```

### Try it locally without touching your global config

```bash
claude --plugin-dir /absolute/path/to/claude-code-watchdog
```

This loads the plugin for a single Claude Code session only. Use it to verify your changes before opening a PR.

### Or wire it in via `~/.claude/settings.json`

```json
{
  "extraKnownMarketplaces": {
    "claude-code-watchdog": {
      "source": {
        "source": "directory",
        "path": "/absolute/path/to/claude-code-watchdog"
      }
    }
  },
  "enabledPlugins": {
    "watchdog@claude-code-watchdog": true
  }
}
```

Then `/reload-plugins` inside Claude Code.

## Repository layout

```
claude-code-watchdog/
├── .claude-plugin/         # marketplace + plugin manifests
├── commands/               # slash command definitions (markdown with frontmatter)
├── hooks/                  # Stop hook registration + stop-hook.js (core loop logic)
├── scripts/                # setup-watchdog.js / stop-watchdog.js entry points
├── lib/                    # shared modules (state, transcript, judge, log, stdin, constants)
├── test/                   # node:test unit + integration tests with fixtures
├── LICENSE                 # Apache 2.0
└── NOTICE                  # Attribution to ralph-loop (required by Apache 2.0 § 4)
```

The heart of the plugin is `hooks/stop-hook.js`. Read that first before changing anything — it consumes everything under `lib/`.

## Before you open a PR

1. **All JavaScript must parse under `node --check`.** CI runs it on every `.js` file. Broken syntax will fail the build.
2. **All tests must pass.** Run `node --test 'test/*.test.js'` locally before pushing. CI runs the full suite on `ubuntu-latest`, `macos-latest`, and `windows-latest` across Node 18 / 20 / 22 — any regression on any matrix entry blocks merge.
3. **Line endings must be LF.** The `.gitattributes` file enforces this — do not override.
4. **Do not skip the `NOTICE` file when making derivative changes.** If your change affects how we differ from `ralph-loop`, update the "modifications" list in `NOTICE`.
5. **Do not commit debug logging.** Remove any `console.log` scaffolding before the PR — `lib/log.js` is the only sanctioned stderr output surface.
6. **One logical change per PR.** Mixing a bugfix with a refactor makes review harder.

## Commit messages

Follow Conventional Commits format:

```
<type>(<scope>): <short description>

<optional longer body explaining the "why">
```

Common types:
- `fix(hooks):` — bug fix in the Stop hook
- `feat(scripts):` — new feature in setup/stop scripts
- `docs:` — README / NOTICE / CONTRIBUTING updates
- `chore:` — dependency / config bumps, no functional change
- `refactor:` — code cleanup with no behavior change

## Testing your change

Watchdog ships with 53 automated tests using Node's built-in `node:test` runner — no external test dependencies. Run them from the repo root:

```bash
node --test 'test/*.test.js'
```

Target an individual file:

```bash
node --test test/transcript.test.js
```

The suite covers:

- **`test/transcript.test.js`** — JSONL parser, real-vs-tool_result user turn detection, tool_use extraction
- **`test/state.test.js`** — atomic state file writes, merge updates, validation, per-session path keying
- **`test/judge.test.js`** — verdict parser (FILE_CHANGES substring trap, ambiguous, empty, multi-token)
- **`test/setup.test.js`** — E2E subprocess tests for `scripts/setup-watchdog.js`
- **`test/stop-watchdog.test.js`** — E2E subprocess tests for `scripts/stop-watchdog.js`
- **`test/stop-hook.test.js`** — E2E subprocess tests for `hooks/stop-hook.js` including the recursion guard, ownership claim, max iterations cap, missing transcript, and pure-text turn branches

In addition to the unit/integration suite, you should **also** manually verify your change in a live Claude Code session:

1. Clear any stale state: `rm -f .claude/watchdog.*.local.json`
2. Load the plugin locally (see Quick start above)
3. Run a small iterative task:
   ```
   /watchdog:start "Create tmp/test.md with 'hello world'" --max-iterations 5
   ```
4. Verify the loop converges (file created, Haiku judges `NO_FILE_CHANGES` on the next turn, loop exits)
5. Verify `/watchdog:stop` cleanly removes the state file

## Reporting bugs

See [SECURITY.md](./SECURITY.md) for security-sensitive bugs.

For regular bugs, open an issue with:
- Claude Code version (`claude --version`)
- Your OS + terminal emulator
- The `/watchdog:start` command you ran
- The observed behavior vs expected behavior

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0 (the project license).
