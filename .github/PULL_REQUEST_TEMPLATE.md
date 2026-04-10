<!--
Thank you for contributing! Please fill out the sections below.
Small focused PRs are reviewed much faster than large sprawling ones.
-->

## Summary

<!-- One or two sentences: what does this PR change and why? -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing users to adapt)
- [ ] Documentation only
- [ ] Refactor / internal cleanup (no behavior change)

## Test plan

<!-- How did you verify this works? Include the exact `/watchdog:start` command you ran and what you observed. -->

- [ ] Ran `shellcheck` locally on all modified `.sh` files
- [ ] Manually tested with `/watchdog:start` in a live Claude Code session
- [ ] Verified `/watchdog:stop` still cleans up state correctly
- [ ] Verified `--max-iterations` cap still works

## NOTICE / derivative work

<!-- If your change affects how Watchdog differs from ralph-loop, update the modifications list in NOTICE. Tick the box below when done or N/A. -->

- [ ] `NOTICE` updated (or not applicable)

## Related issues

<!-- Link issues this PR fixes, e.g. "Fixes #42" -->
