# Development, testing, and packaging

[All documentation](README.md) · [Architecture](ARCHITECTURE.md) · [Data and security](DATA_AND_SECURITY.md)

## Prerequisites

- A supported Node.js release: `^22.22.2`, `^24.15.0`, or `^26.0.0` as declared in `package.json`. Node 24.15+ within the 24.x line is the straightforward development choice.
- npm, Git, and a desktop environment for native Electron checks. Headless Linux needs Xvfb and Electron's system libraries; a Docker recipe is included.
- Network access for the initial dependency/Electron download. Once built, the app's normal workflow is offline.

The packaged app carries its own Electron runtime. End users do not install Node, npm, Docker, or a Vite server.

## Install and run

From a clone of the repository:

```sh
npm ci
npm run dev
```

`npm ci` installs the lockfile's exact dependency graph. `npm install` is appropriate when intentionally changing dependencies; review and commit the resulting lockfile change. Many manifest entries use `latest`, so reinstalling without the lockfile is not a reproducible version-selection strategy.

`npm run dev` starts Vite on `127.0.0.1:5173`, waits for it, then launches Electron with the allowed development URL. Keep that address/port aligned with the explicit main-process network policy. If the port is occupied, resolve the conflict rather than silently switching the renderer to an arbitrary origin. `Ctrl+C` stops the development command.

To exercise the production renderer locally:

```sh
npm run build
npm start
```

`build` performs `tsc --noEmit` and a Vite production build. It does not compile Electron CommonJS files or package an installer. `start` launches Electron against the existing `dist/` files; rebuild after changing renderer code. Electron main/preload changes require restarting the process.

`npm run preview` serves the renderer through Vite preview, not through the real filesystem bridge. The browser fallback is a limited UI preview, not a desktop integration test or supported replacement application.

## Repository map

```text
electron/
  main.cjs                 Native lifecycle, IPC, saves, recovery, exports
  preload.cjs              window.margin bridge and delivery handshake
  workspace.cjs            Bounded traversal, path policy, search/snapshots
  external-open.cjs        OS/CLI open coordination
  network-policy.cjs       App-session resource request policy
src/
  App.tsx                  UI/application coordination
  types.ts                 Document, settings, workspace, bridge contracts
  components/              Editor, reader, sidebar, graph, panels, overlays
  lib/                     Markdown, live widgets, links/index, reading state
  styles.css               Core application styles
  features.css             Workspace/reading/connected-note surfaces
  test/setup.ts            Shared Vitest environment setup
scripts/
  desktop-smoke.cjs         Real Electron regression workflow
  Dockerfile.smoke          Repeatable Linux checks
docs/
  examples/                Small, portable demonstration notebook
  assets/                  Real screenshots, no user profile data
  capture-screenshots.cjs   Documentation-only screenshot tool
build/                     App icon source/generated platform icons
dist/                      Generated renderer output; ignored by Git
release/                   Generated packages/unpacked apps; ignored by Git
.github/workflows/desktop.yml
```

Renderer TypeScript uses ES modules. Native Electron and supporting scripts use `.cjs` explicitly because `package.json` declares `type: module`. Shared main/renderer behavior is communicated through IPC data structures, not by handing native objects to the page.

## Commands and what they prove

| Command | Purpose |
| --- | --- |
| `npm test` | Run all Vitest library/component tests once |
| `npm run test:watch` | Run tests interactively while developing |
| `npm run build` | Type-check renderer code and generate production assets |
| `npm run test:desktop` | Build, then exercise the native Electron application with private fixtures/profile |
| `npm run test:agent` | Build, then exercise the Agent desk with an isolated deterministic loopback fixture; no real model/weights |
| `npm run package:dir` | Build an unpacked app for this host OS/architecture |
| `npm run package` | Build configured distribution packages for the host platform |
| `npm audit` | Inspect the installed dependency graph against the available advisory data; needs network |
| `git diff --check` | Catch whitespace/patch formatting problems |

A passing build is not proof that IPC, native dialogs, clipboard, file association, or restart persistence work. A successful package is not proof that its contents are current unless you inspect/run that generated artifact. Dependency audit results are time-specific, not a security warranty.

### Unit and component tests

The Vitest configuration uses jsdom, shared setup, and React testing helpers. Tests live beside the modules they cover:

- `document`, `external-open`: open/save state, line endings, conflicts, path/argument/delivery behavior.
- `workspace`: traversal/capabilities, symlinks, bounds, buffers, cancellation, literal search.
- `markdown`, `readerFind`, `MarkdownPreview`: rendered output, sanitization, math/diagram/export behavior, outline/search, reader interactions.
- `markdownTable`, `livePreview`: table editing, active-source/live widgets, undo, focus behavior, global references/footnotes.
- `noteIndex`: resolution, aliases/tags, ambiguity, code exclusions, sections, transclusion/cycles, index budgets.
- `readingState`, `networkPolicy`: quote anchoring, storage validation/retention/failure behavior, annotation markup, resource restrictions.

Use a targeted test while working, then the full suite before handoff:

```sh
npm test -- src/lib/noteIndex.test.ts
npm test
npm run build
```

### Native desktop smoke test

```sh
npm run test:desktop
```

The script uses Playwright's Electron support against the local Electron runtime; a separate Playwright Chromium download is not required. It creates its own files/profile, replaces native file dialogs with fixture paths, and exercises real renderer/main-process integration. It tests navigation, embeds with references/footnotes, math/diagrams, annotations, HTML/PDF files, folds, images, slides, history, Live editing/undo, missing-note creation/completion, graph interaction, theme/layout, immediate-close position persistence, restart persistence, storage-failure close cancellation, and blocked background networking.

It prints an artifact directory with screenshots and exports. These fixtures are intentionally temporary and distinct from your normal app profile. The script tests normal quit/restart in its persistence flow; final forced exit is private test teardown, not the recommended user shutdown workflow.

To test an already packaged macOS app instead of the development Electron binary:

```sh
MARGIN_SMOKE_EXECUTABLE="$PWD/release/mac-arm64/Margin.app/Contents/MacOS/Margin" node scripts/desktop-smoke.cjs
```

This environment variable expects the executable inside the bundle, not the `.app` directory. The test still uses a separate `--user-data-dir` and asserts that its actual profile matches the fixture path. That is a testing invocation, not advice to distribute the inner executable alone.

### Headless Linux and Docker

The Agent desk also has `scripts/agent-smoke.cjs`: a real Electron/IPC/file workflow driven by a synthetic Ollama-protocol server. It verifies disabled/default behavior, local-only checks, source references, review/reject/accept, undo, stale edits, cancellation, explicit folder scope, and unsaved drafts without loading a model. In unpackaged tests only, `MARGIN_TEST_OLLAMA_PORT` can choose an ephemeral fixture port when `NODE_ENV=test` and an explicit temporary profile are present. Packaged apps ignore this override and use `127.0.0.1:11434`.

Real-model inference testing is currently deferred at the user's request. Never run `ollama run`, pull weights, or start a live inference task as part of a build. Protocol tests prove integration and safety behavior, not model quality. See the [Agent desk guide](AGENT_DESK.md).

With Electron system dependencies already available:

```sh
xvfb-run -a npm run test:desktop
```

For an isolated repeatable environment:

```sh
docker build -f scripts/Dockerfile.smoke -t margin-desktop-smoke .
docker run --rm --shm-size=1g margin-desktop-smoke
```

The image installs the GTK/NSS/audio/graphics libraries, Xvfb, fonts, and D-Bus helper needed by Electron, then runs unit tests, a native smoke test under Xvfb, and unpacked packaging. Its architecture follows the Docker host/image platform. `.dockerignore` excludes local dependencies/build output so they cannot replace the container install.

The isolated container sets `MARGIN_TEST_NO_SANDBOX=1`, which permits the smoke runner's Linux `--no-sandbox` flag. Do not use that as a production launch setting or weaken the application's sandbox configuration to fix a test environment.

### CI

The included workflow runs on pushes to `main`, pull requests, and manual dispatch. It uses Node 24 across macOS/Windows/Ubuntu runners and runs install, unit tests, native smoke, and unpacked packaging. Linux uses Xvfb. The workflow does not push commits, publish installers, attach a release, or notarize/sign a distribution.

Local macOS/Linux verification does not substitute for a native Windows run. A checked-in CI file is only a test plan until its jobs actually execute successfully. Before a public release, check the runs for the exact revision/platforms you intend to distribute.

## Packaging and distribution

```sh
npm run package:dir
```

Useful for trying the current build without creating an installer. Typical outputs include `release/mac-arm64/Margin.app`, `release/mac/Margin.app`, `release/win-unpacked/`, and `release/linux-<arch>-unpacked/`; read the builder output for the actual platform/architecture path.

```sh
npm run package
```

The manifest configures DMG/ZIP on macOS, NSIS on Windows, and AppImage/DEB on Linux. Prefer building/testing on each target operating system. Architecture and signing requirements are independent of TypeScript passing.

Builder packages the renderer `dist/`, native `electron/`, and package metadata into `app.asar`. Runtime renderer libraries are bundled from development dependencies; the normal app does not ship the repository's whole `node_modules`, test harness, documentation screenshots, or Docker tooling. Electron itself contributes a substantial baseline size: “lightweight” here means bounded work, limited subsystems, and no background service, not a tiny native executable.

The product name is **Margin**, app ID is `app.margin.markdown`, and icon paths are declared in `package.json`. Markdown extensions register the Editor role; `.txt` is an alternate text association. The Windows installer is configured per-machine and requests administrator approval. Linux advertises Markdown/text MIME types and passes file arguments through desktop metadata.

Public distribution still needs platform signing/notarization and release credentials configured outside the repository. An unsigned local build is not the same as a signed public release. Do not put credentials, profiles, signing identities, or private notes in Git. There is no updater/release-publishing implementation to configure in this version.

## Documentation and screenshots

The documentation is regular Markdown with local PNG assets and Mermaid diagrams. No hosted font/image/CDN is needed to view it in Margin. GitHub can render its Mermaid blocks too; a viewer without Mermaid support will show the readable diagram source.

To regenerate the five screenshots after rebuilding:

```sh
npm run build
node docs/capture-screenshots.cjs
```

Or set `MARGIN_SMOKE_EXECUTABLE` as in the packaged smoke example to capture the actual packaged app. The script copies `docs/examples` into temporary fixtures, asserts profile isolation, and writes only the intended documentation screenshots. Check them visually before committing. It may need local desktop-launch permission in restricted automation environments.

`node docs/check-links.cjs` validates relative documentation links, image paths, local anchors, and referenced assets without fetching the internet. It also checks that screenshot files are PNGs and reports their dimensions.

## A safe change workflow

1. Read the module's tests and the [architecture invariants](ARCHITECTURE.md). Reproduce the problem at the smallest appropriate boundary.
2. Keep document edits in source transactions and native filesystem work behind validated IPC. Update `MarginApi`, preload, main, and fallback together if the contract changes.
3. Test Unicode/path separators, stale async results, conflicting saves, unsaved buffers, and cancellation when relevant.
4. Run targeted/full tests and the production build. Run the native smoke for lifecycle/rendering/file/export changes.
5. Rebuild and run the package you will actually hand to someone; do not test an old binary and claim it covers new source.
6. Update the user guide, limits/security reference, and screenshots whenever behavior changes. Keep sample notes public and reproducible.
7. Review the exact staged files before committing. Generated `dist`, `release`, local profiles, and temporary fixtures do not belong in the source commit.

Useful diagnostic commands:

```sh
node --check electron/main.cjs
node --check electron/preload.cjs
node --check electron/workspace.cjs
node --check scripts/desktop-smoke.cjs
git diff --check
git status --short
```

For bugs, capture the app/build/platform, reproduction steps, mode, whether a workspace is open, expected/actual behavior, limit/conflict warnings, and whether the problem occurs with the sample notebook. Share a minimal synthetic file instead of a real private profile or reading library.
