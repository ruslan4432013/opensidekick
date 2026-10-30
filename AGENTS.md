# Agent Notes — OpenSidekick

Instructions for AI coding agents working in this repository.

## What this checkout is

A local fork of https://github.com/esterhuizen/opensidekick (upstream release
0.4.2) with our own patches on top, loaded into Chrome as an **unpacked**
extension. Check `git log` — local commits carry fixes that upstream does not
have (vision-probe size fix, local LLM activity log, narration nudge). When
rebasing on upstream, re-verify them.

## The one rule that is easy to forget

**Bump the version every time you add or fix something.** No silent changes:

1. `version` in `manifest.json` **and** `package.json` — together, always
   equal. Patch digit for fixes and small additions, minor for a new
   user-facing capability (see CONTRIBUTING.md → Versioning).
2. A `## [x.y.z] — YYYY-MM-DD` section in `CHANGELOG.md` describing what
   shipped, written for users, not for the commit log.

Do this in the same commit as the change, or in the release commit that
gathers the branch — never "later".

## Project constraints (from CONTRIBUTING.md, enforced by tests)

- No build step, no npm runtime dependencies. Plain ES modules only.
- `npm run check` syntax-checks every file; `npm run test:unit` runs all suites
  (each test file is a standalone node script with an exit code). Run both
  before declaring work done.
- No analytics, no telemetry, no phone-home. Anything new that touches the
  network must go only to an endpoint the user configured.
- Match existing style: 2-space indent, comments that explain _why_,
  descriptive function names.

## Where things live

- Agent loop: `src/background/agent.js` (model calls → tool execution →
  permission gates → events streamed to the side panel).
- Provider wire formats + the capability probe (`testModel`):
  `src/background/providers.js`.
- Local LLM activity ring (device-only black box, exported from Options):
  `src/background/activity.js`, key `opensidekick.activity.v1`.
- Storage keys and defaults: `src/common/constants.js`, `src/background/storage.js`.

## After changing code

Chrome will not pick changes up by itself: reload the extension at
`chrome://extensions`, and reload any page whose content script changed.
