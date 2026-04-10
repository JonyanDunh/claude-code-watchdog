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
├── hooks/                  # Stop hook registration + stop-hook.sh (core loop logic)
├── scripts/                # setup-watchdog.sh / stop-watchdog.sh (bash state management)
├── LICENSE                 # Apache 2.0
└── NOTICE                  # Attribution to ralph-loop (required by Apache 2.0 § 4)
```

The heart of the plugin is `hooks/stop-hook.sh`. Read that first before changing anything.

## Before you open a PR

1. **Shell scripts must pass `shellcheck`.** CI runs it on every `.sh` file. Install locally (`apt install shellcheck`, `brew install shellcheck`) and fix warnings before pushing.
2. **Line endings must be LF.** The `.gitattributes` file enforces this — do not override.
3. **Do not skip the `NOTICE` file when making derivative changes.** If your change affects how we differ from `ralph-loop`, update the "modifications" list in `NOTICE`.
4. **Do not commit debug logging.** Remove any `WATCHDOG_DEBUG_LOG=...` scaffolding before the PR.
5. **One logical change per PR.** Mixing a bugfix with a refactor makes review harder.

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

There is no automated test suite (the project is small and the interesting behavior requires a live Claude Code session). Manual verification steps:

1. Clear any stale state: `rm -f .claude/watchdog.*.local.json`
2. Load the plugin locally (see Quick start above)
3. Run a small iterative task:
   ```
   /watchdog:start "Create tmp/test.md with 'hello world'" --max-iterations 5
   ```
4. Verify the loop converges (file created, Haiku judges NO_FILE_CHANGES on the next turn, loop exits)
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
