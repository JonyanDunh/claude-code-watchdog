# Security Policy

## Supported Versions

Only the latest released version of Watchdog receives security fixes. Pin your dependency accordingly.

| Version | Supported |
|---------|-----------|
| 1.0.x   | ✅ |
| < 1.0   | ❌ |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security-sensitive reports.**

Send a private email to **jonyandunh@outlook.com** with:

- A clear description of the issue
- Steps to reproduce (or a minimal PoC)
- The version / commit you tested against
- Your assessment of impact

I will acknowledge your report within 7 days and aim to publish a fix within 30 days for valid reports. If the report requires coordination with upstream projects (e.g., Claude Code itself or the `ralph-loop` plugin we derive from), the timeline may be longer — I will keep you informed.

## Scope

The Watchdog plugin runs as a set of bash scripts triggered by Claude Code hooks. In-scope issues include:

- **Command injection** via unescaped user input (prompts, state file contents, hook input JSON)
- **Path traversal** via malicious `TERM_SESSION_ID` values or state file names
- **State file manipulation** that bypasses the `owner_session_id` recursion guard
- **Privilege escalation** via the headless Claude CLI classifier call

Out of scope:

- Issues in Claude Code itself — report to Anthropic
- Issues in the `ralph-loop` plugin — report to Anthropic
- Social engineering that tricks a user into running `/watchdog:start` with a malicious prompt
- Resource exhaustion from legitimately-loop-bound tasks (use `--max-iterations` to bound)

## Credit

Reporters of valid vulnerabilities will be credited in the release notes unless they request otherwise.
