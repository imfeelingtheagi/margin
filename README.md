# Margin

Margin is a calm, local-first Markdown reader and editor for macOS, Windows, and Linux. It opens directly into a reading-focused single pane, with editing one click or shortcut away.

## What it includes

- Native Open With / file-association support, multi-file open, tabs, save, Save As, autosave, crash recovery, and external-change detection
- Read and Edit modes with a responsive outline, focus mode, word/character counts, reading time, and cursor position
- Markdown tables, task lists, footnotes, definition lists, strikethrough, mark, subscript, superscript, front matter, raw HTML (sanitized), KaTeX math, Mermaid diagrams, and syntax-highlighted code
- CodeMirror editing with undo/redo, find/replace, line numbers, folding, Markdown-aware formatting tools, and keyboard shortcuts
- System, light, and dark interface themes plus Paper, Snow, Sepia, Midnight, and custom reader palettes
- Reader font, size, line-height, and content-width controls
- Self-contained HTML export and print-ready PDF export, including local images, diagrams, syntax styles, and embedded math fonts
- Offline-only operation: no account, analytics, telemetry, or cloud service

Remote images are deliberately blocked. Local image paths are resolved only inside the opened Markdown file's directory.

## Development

Requirements: Node.js 22–26 and npm.

```sh
npm install
npm run dev
```

Useful commands:

```sh
npm test          # run the test suite
npm run build     # type-check and create the production renderer
npm run package   # create installers for the current platform
npm run package:dir # create an unpacked app for the current platform
```

Electron Builder produces artifacts in `release/`. Cross-platform installers should be built on their target operating systems (or in an appropriate CI matrix). Production releases still need the signing/notarization credentials for each target platform.

### Run the packaged app on macOS

```sh
npm install
npm run package:dir
open release/mac-arm64/Margin.app   # Apple Silicon
```

On an Intel Mac, the generated directory is normally `release/mac/Margin.app`. Keep and distribute the complete `Margin.app` bundle; the executable inside it is not a standalone binary.

To open a document, double-click it after associating Markdown files with Margin, drag it onto Margin, use **File → Open**, or choose **Open With → Margin** in Finder. To make Margin the default, select a `.md` file in Finder, choose **Get Info**, select Margin under **Open with**, then click **Change All…**.

Windows file associations are installed by the per-machine NSIS installer and therefore request administrator approval. Linux associations are advertised through the AppImage/DEB desktop metadata; the desktop environment controls the final default-app choice.

## Keyboard shortcuts

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| New | `⌘ N` | `Ctrl N` |
| Open | `⌘ O` | `Ctrl O` |
| Save | `⌘ S` | `Ctrl S` |
| Save As | `⇧ ⌘ S` | `Ctrl Shift S` |
| Read / Edit | `⌘ E` | `Ctrl E` |
| Find | `⌘ F` | `Ctrl F` |
| Replace | `⌥ ⌘ F` | `Ctrl H` |
| Close tab | `⌘ W` | `Ctrl W` |
| Focus mode | `⇧ ⌘ F` | `Ctrl Shift F` |

Standard editing shortcuts such as bold, italic, undo, and redo work in Edit mode.

## Security and privacy

The renderer uses Electron context isolation, sandboxing, a narrow preload API, and no Node.js integration. Markdown HTML and generated Mermaid SVG are sanitized before display. File access is brokered by the main process and scoped to files the user selected; saved session recovery lives in Electron's per-user application-data directory.

Exported HTML has a restrictive Content Security Policy and embeds its required styles and math fonts, so it remains portable without reaching the network.
