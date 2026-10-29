# Reader/editor QA — October 28, 2026

[Documentation](README.md) · [Development and test commands](DEVELOPMENT.md)

Scope: Margin's non-AI reader/editor on macOS Apple Silicon. All notes and profiles used for desktop tests were disposable synthetic fixtures. No Ollama server, protocol fixture, AI task, model download, or model inference was used. Agent-specific tests were excluded.

## Bugs reproduced and remediated

| Problem | Remediation and regression evidence |
| --- | --- |
| HTML/PDF export could overwrite an open Markdown document | Resolve export destinations canonically and reject an open tab's path; recheck before PDF output is written. Native tests cover both formats. |
| Save-and-close could discard text typed during the asynchronous save | Recheck unresolved text before closing a tab/window; leave it open and warn. Native tests pause an actual write, type newer text, then release it. |
| Preferences-storage quota errors crashed the renderer | Catch preference writes/removals, warn, and keep in-memory settings/theme/editor usable. Native quota-failure injection covers settings and active-tab storage. |
| Startup cleared the preferred active tab before restoring the session | Do not persist the active tab until restoration is complete. Native renderer restart checks the selected tab, dirty text, conflict indicator, and unchanged external disk version. |
| Reader find missed phrases split by bold/italic markup | Match logical text runs and map one result to its inline highlight fragments, preserving markup on cleanup. Unit and native tests cover this. |
| Reader find counted folded/collapsed content and controls | Exclude hidden sections, closed callout bodies, and buttons; refresh when callouts toggle. Unit/component/native checks cover visibility. |
| Checkbox undo could also undo recent typing; first-use Read edits had no history; quoted tasks did not toggle | Route checkbox changes through lazily initialized CodeMirror transactions, isolate history, and handle quote prefixes. Unit and native tests cover first-use, quoted tasks, and undo/redo. |
| Connected-note enhancement hijacked local heading/footnote anchors | Keep ordinary `#fragment` links local and preserve embed-specific ID remapping. Unit/export regressions cover host and embedded notes. |

Additional hardening: atomic writes now use exclusive UUID temporary files and clean up partial files even when writing fails. Native tests exercise concurrent writes with a fixed clock and an injected disk-full failure. Reader-find and palette inputs now have explicit accessible names.

## Verification

- 108 non-AI unit/component tests, including new regression coverage.
- Production TypeScript/Vite build passed.
- 15 original native smoke checks and 23 extended reader-only checks passed on source launch; both workflows also passed against the rebuilt unsigned macOS application.
- All 293 packaged native/renderer files matched the current on-disk build byte for byte; the app's ASAR remains approximately 8.99 MiB. The Electron runtime is additional to that size.
- npm audit: zero reported vulnerabilities in the installed lockfile dependency graph at the time of this check. This is not a security guarantee.
- Offline documentation links/assets and patch/syntax checks.

The original native smoke workflow covers local open/save/navigation, linked notes/embeds, math/Mermaid, annotations/bookmarks, folds, images/slides, live editing, graph, HTML/PDF output, dark/small layouts, and persistence after a full restart. The extended workflow adds byte integrity, concurrency/fault injection, conflict/recovery cases, source-overwrite prevention, and preference failure behavior. Both check unexpected renderer HTTP requests/errors; the extended workflow also blocks Node HTTP/fetch explicitly.

Reproduce without AI tests:

```sh
npm run test:reader
npm run test:desktop
npm run test:reader:desktop
node docs/check-links.cjs
git diff --check
```

Packaged macOS regression commands, after `npm run package:dir`:

```sh
MARGIN_SMOKE_EXECUTABLE="$PWD/release/mac-arm64/Margin.app/Contents/MacOS/Margin" node scripts/desktop-smoke.cjs
MARGIN_SMOKE_EXECUTABLE="$PWD/release/mac-arm64/Margin.app/Contents/MacOS/Margin" node scripts/reader-qa.cjs
```

## Boundaries and remaining validation

Native Windows/Linux runs were not performed in this QA session. Their existing CI matrix now includes the extended reader runner, but configuration is not evidence that those jobs passed. No virtual machine was started for this session.

This is broad regression QA, not an exhaustive proof of correctness or an independent penetration/accessibility audit. Native dialogs are stubbed for deterministic choices; Finder/Open With association UX, installer UX, printing on physical printers, OS permission prompts, screen-reader sessions, and signing/notarization still need platform-specific manual validation before a public release. The packaged preview remains unsigned. The test suite checks large-file rejection and Live's source fallback, not worst-case performance for every valid 25 MiB Markdown structure.

AI behavior, Ollama compatibility, and model quality remain explicitly untested. Existing illustrated-guide screenshots retain their recorded earlier-build provenance; this remediation does not redesign the interface.
