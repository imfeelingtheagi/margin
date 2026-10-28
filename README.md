# Margin

Margin is a calm, local-first Markdown reader and editor for macOS, Windows, and Linux. It is designed for comfortable reading, with a capable source editor and lightweight folder workspace when you need them.

## Documentation

Start with the [illustrated user guide](docs/USER_GUIDE.md) for reading, editing, linked notes, annotations, and export. The [documentation hub](docs/README.md) also links to the [architecture](docs/ARCHITECTURE.md), [data/security and backup reference](docs/DATA_AND_SECURITY.md), and [development/testing guide](docs/DEVELOPMENT.md).

![Margin with a local notebook, a highlight, and the Reading desk](docs/assets/reading.png)

Open `docs/examples` as a folder in Margin for a small connected notebook you can explore alongside the guide.

## Features

- Open individual Markdown or text files, or choose **Open Folder** for a persistent workspace with a lazy-loading file tree.
- Switch the sidebar between **Files**, folder-wide **Search**, and the active document's **Outline**. Open documents remain available in the Files view.
- Use **Quick Open** (`Cmd/Ctrl+P`) to find a file by path, or **Find in Folder** (`Cmd/Ctrl+Shift+F`) for literal full-text search with match-case and whole-word options. Search uses the current unsaved contents of open files.
- Work with up to 100 draggable tabs, reopen closed tabs, autosave saved files, recover unsaved drafts after a crash, and detect changes made by another app.
- Choose **Read**, **Live**, source **Edit**, or synchronized **Split** mode. Live mode renders inactive blocks in place; click a block to edit its original Markdown. New drafts start in Live mode. Focus Mode hides the surrounding interface when you want a distraction-free page.
- Render tables, task lists, footnotes, definition lists, strikethrough, mark, subscript, superscript, front matter, GitHub alerts, foldable callouts, sanitized raw HTML, KaTeX math, Mermaid diagrams, and syntax-highlighted code.
- Connect local notes with `[[wiki links]]`, `[[note#heading|labels]]`, block references, aliases, and `![[embedded notes]]`. Link suggestions appear as you type `[[`. Open a folder to browse backlinks, outgoing links, nested tags, and an interactive graph. Missing links offer to create a `.md` note in the selected folder.
- Open the **Reading desk** to bookmark documents, highlight selected text, attach notes, choose highlight colors, and return to saved reading positions. Reading data lives in Margin's local app profile and does not rewrite your Markdown.
- Collapse heading sections, zoom local images with a full-window viewer, and present a document as slides. Back/Forward buttons track visits between open documents.
- Edit with CodeMirror: word wrap, undo/redo, find/replace, go to line, line numbers, code folding, visible whitespace, typewriter mode, smart list continuation, URL-to-link pasting, Markdown formatting actions, autocomplete, and configurable indentation.
- Author pipe tables with the **Insert or format table** action; inside a table, `Tab` and `Shift+Tab` move between cells, and `Tab` from the final cell adds a row.
- Configure interface and reader themes, fonts, type size, line height, content width, spelling, autosave, and editor behavior in **Settings**. Sentence and paragraph focus dim surrounding text while you write. Word wrap is on by default and can also be toggled from the status bar or with `Alt/Option+Z`.
- Paste clipboard images or drop image files into Edit/Split mode. Margin copies supported images into an `assets/` folder beside the saved document and inserts relative Markdown links. The toolbar's **Image** button provides a file picker for the same workflow.
- Update task checkboxes from the rendered view, copy code blocks with one click, and export self-contained HTML or print-ready PDF.
- Stay offline and on-device: no account, analytics, telemetry, cloud sync, or background network requests.
- Optionally configure the [Agent desk](docs/AGENT_DESK.md) with a separately installed local Ollama model. Ask about permitted notes, extract tasks/decisions, or review proposed Markdown edits and drafts. It starts disabled, checks that cloud features are off, never downloads models, and never changes source documents during generation. Real-model inference testing is currently deferred; builds do not run models.

## Run from source

Requirements for development: Node.js 24.15+ (recommended), 22.22.2+, or 26.x, and npm. The packaged desktop app does not require Node.js.

```sh
git clone https://github.com/imfeelingtheagi/margin.git
cd margin
npm install
npm run dev
```

`npm run dev` starts Vite and launches the Electron app. Press `Ctrl+C` in the terminal to stop it.

To run the production renderer locally:

```sh
npm run build
npm start
```

Useful commands:

```sh
npm test          # run the test suite once
npm run test:desktop # build and smoke-test the real Electron app in a temporary profile
npm run test:agent # isolated Agent desk protocol fixture; no model or weights
npm run test:watch # run tests while files change
npm run build     # type-check and build the renderer into dist/
npm run package:dir # build an unpacked app for this computer
npm run package   # build this platform's installers/packages
```

Build artifacts are written to `release/`. Build Windows, macOS, and Linux releases on their target operating systems or in an appropriate CI matrix. Public releases also need the target platform's signing/notarization credentials.

The desktop smoke test opens a temporary app profile, creates its own sample files, exercises editing/reading/export/navigation, and checks restart persistence and absence of HTTP requests. It leaves screenshots and exported files in the temporary artifact folder printed in its output. It does not use your normal Margin profile. On a Linux machine without a display, use `xvfb-run -a npm run test:desktop` with the standard Electron system libraries installed.

An isolated Linux check is also available through Docker:

```sh
docker build -f scripts/Dockerfile.smoke -t margin-desktop-smoke .
docker run --rm --shm-size=1g margin-desktop-smoke
```

The repository includes a macOS/Windows/Linux verification workflow for tests, native smoke checks, and unpacked app builds. It runs when those changes are published to GitHub; this does not publish installers or releases.

### Run the packaged app on macOS

For Apple Silicon:

```sh
npm install
npm run package:dir
open release/mac-arm64/Margin.app
```

On an Intel Mac, the generated app is normally `release/mac/Margin.app`. Keep and distribute the complete `Margin.app` bundle—the executable inside `Margin.app/Contents/MacOS/` is not a standalone binary.

`npm run package` creates the configured DMG and ZIP on macOS, NSIS installer on Windows, or AppImage and DEB packages on Linux.

## Using Margin

1. Choose **Open File** for one or more `.md`, `.markdown`, `.mdown`, `.mkd`, or `.txt` files. Choose **Open Folder** to browse and search a folder without importing or uploading it.
2. In a folder workspace, use the sidebar's **Files**, **Search**, and **Outline** buttons. `Cmd/Ctrl+P` opens the folder file picker; `Cmd/Ctrl+Shift+F` focuses folder search.
3. Choose **Read**, **Live**, **Edit**, or **Split** in the toolbar. Live renders the document around the block you are editing; use `Cmd/Ctrl+click` to follow links in Live mode. Edit shows the full source. Split keeps source and preview scrolling together.
4. Save normally with `Cmd/Ctrl+S`. Use **File → Save As** for a new path, and **File → Export as HTML/PDF** for a shareable rendering.
5. Open **Settings** to tune word wrap, line numbers, whitespace, folding, typewriter mode, indentation, themes, typography, content width, spelling, and autosave.
6. To import images, first save the document, then paste or drop images into the editor or use the toolbar's **Image** button. Supported images are limited to 20 MB each and are copied into the neighboring `assets/` folder.
7. For Markdown tables, use **Insert or format table**. Press `Tab`/`Shift+Tab` to navigate cells; tabbing past the final cell creates the next row.
8. Open the book icon at the top right for the **Reading desk**. In Read mode, select text and choose **Highlight** or **Add note**. Edit notes or colors in the desk; click a highlight's quote to jump back to it. Bookmarks and positions survive closing and reopening the app.
9. Use **Links** in the Reading desk for backlinks and outgoing links, or **Tags** to filter notes by tags. Write `[[Note]]`, `[[Note#Heading]]`, `[[Note#^block-id]]`, or `![[Note#Heading]]`. Put `^block-id` at the end of a paragraph to name a block. Folder-relative paths disambiguate notes with the same name. Aliases and tags can be lists in YAML front matter.
10. Click the chevron beside a heading to collapse its section; **Expand/Collapse all reading sections** are also available in the command palette. Click an image to zoom it. Use the presentation icon (or `F5`) for slides split at level 1/2 headings and horizontal rules; arrow keys change slides and `Esc` exits.
11. Open **Note graph** to explore relationships. Filter by title, path, or tag, select the active note's neighborhood, drag the background to pan, and zoom with the wheel or buttons. Click a node to open the note.

You can also open documents through the operating system's **Open With** action, a file association, or by dragging files onto Margin. On macOS, files opened or manually saved by Margin appear under **File → Open Recent**.

To make Margin the default Markdown app on macOS, select a `.md` file in Finder, choose **Get Info**, select Margin under **Open with**, and click **Change All…**. The Windows NSIS installer requests administrator approval for its per-machine file associations. Linux associations are advertised through the AppImage/DEB desktop metadata.

## Keyboard shortcuts

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| New | `⌘ N` | `Ctrl N` |
| Open file | `⌘ O` | `Ctrl O` |
| Quick Open | `⌘ P` | `Ctrl P` |
| Save | `⌘ S` | `Ctrl S` |
| Save As | `⇧ ⌘ S` | `Ctrl Shift S` |
| Read / Edit | `⌘ E` | `Ctrl E` |
| Live editing | `⌥ ⌘ E` | `Ctrl Alt E` |
| Split editor and preview | `⇧ ⌘ E` | `Ctrl Shift E` |
| Reading desk | `⇧ ⌘ L` | `Ctrl Shift L` |
| Bookmark document | `⇧ ⌘ D` | `Ctrl Shift D` |
| Note graph | `⇧ ⌘ G` | `Ctrl Shift G` |
| Back / Forward | `⌥ ⌘ ←` / `⌥ ⌘ →` | `Ctrl Alt ←` / `Ctrl Alt →` |
| Present document | `F5` | `F5` |
| Find in document | `⌘ F` | `Ctrl F` |
| Find in folder | `⇧ ⌘ F` | `Ctrl Shift F` |
| Replace | `⌥ ⌘ F` | `Ctrl H` |
| Go to line | `⌥ ⌘ G` | `Ctrl Alt G` |
| Command palette | `⇧ ⌘ P` | `Ctrl Shift P` |
| Settings | `⌘ ,` | `Ctrl ,` |
| Close tab | `⌘ W` | `Ctrl W` |
| Reopen closed tab | `⇧ ⌘ T` | `Ctrl Shift T` |
| Next / previous tab | `Ctrl Tab` / `Ctrl Shift Tab` | `Ctrl Tab` / `Ctrl Shift Tab` |
| Select tab 1–9 | `⌘ 1`–`⌘ 9` | `Ctrl 1`–`Ctrl 9` |
| Toggle word wrap | `⌥ Z` | `Alt Z` |
| Toggle sidebar | `⇧ ⌘ O` | `Ctrl Shift O` |
| Focus Mode | `F8` | `F8` |

Standard shortcuts for undo, redo, bold, italic, and links work in Edit and Split modes.

## Session and safety limits

Margin restores the last folder and settings on launch. After an interrupted exit, its on-device recovery data can restore tabs, document modes, cursor/scroll positions, and bounded unsaved work.

Bookmarks, highlights, notes, collapsed sections, and reading positions persist separately across normal app restarts. Save drafts to give them permanent file bookmarks. Reading metadata stays in the app profile; it is not embedded into exported documents or synchronized elsewhere. Previously opened file paths are retained locally so bookmarks can reopen those files.

- A document may be at most **25 MB**.
- At most **100 tabs** and **200 MB of document text** are retained at once. Crash-recovery snapshots are separately capped at 50 MB.
- Quick Open indexes at most 10,000 supported documents.
- Connected notes index at most **2,000 files**, **1 MB per file**, and **16 MB total**, with a separate 16 MB text-memory bound that also covers open buffers; the Reading desk reports skipped/limited results. The index includes unsaved open buffers and reuses unchanged parsed notes. Refresh it from either sidebar, or return to Margin after editing files in another app.
- Note embeds expand at most two levels and 100,000 characters per embedded section, with aggregate bounds of 32 expansions, 500,000 source characters, and 4 MB of generated HTML per rendered surface; recursive/large embeds remain links. Section embeds preserve references and footnotes from the owning note, and embedded heading IDs cannot intercept the host's outline navigation. Assets resolve relative to the embedded note. The graph shows up to 250 matching notes and runs its layout only when its inputs change.
- Connection metadata is capped at 400 outgoing links, 200 tags, and 20 aliases per note, and 40,000 outgoing links across the index. Reaching connection limits is reported in the Reading desk.
- Live rendering applies to documents up to 300,000 characters. Larger files remain editable in source form. Presentations and graph tools load on demand; no additional runtime dependencies were added for these tools.
- A document supports up to 200 annotations, with 10,000 characters per highlighted selection and 20,000 per note. The reading library retains at most 2,000 records and 4 MB of encoded metadata. Storage failures are reported in the app.
- Folder search is deliberately bounded: up to 10,000 documents, 5 MB per searched file, 512 MB total scanned data, 200 returned matches, and 20 matches per file. The sidebar reports skipped or limited results.
- Workspace discovery ignores `.git`, `.hg`, `.svn`, and `node_modules`, limits traversal depth and entry counts, and does not follow symbolic links or junctions.

## Security and privacy

The Electron renderer runs with context isolation, sandboxing, a narrow preload API, and no Node.js integration. The desktop session blocks web requests and direct file requests outside packaged app assets, with an exact-file exception for each temporary PDF render window; development mode permits only the configured local Vite server. File and folder access is brokered by the main process and limited to files the user selected, the chosen workspace root, safe relative document links, and each document's local asset directory.

Markdown HTML and generated Mermaid SVG are sanitized before display. Remote and absolute image paths are blocked; relative images must remain inside the opened document's directory. Exported HTML uses a restrictive Content Security Policy and embeds its styles and math fonts.

Margin does not download spelling dictionaries. Spellcheck uses macOS's native on-device spelling service. It remains disabled on Windows and Linux until a local dictionary can be bundled without weakening the offline guarantee. External web and email links are handed to the operating system only after the user activates them.

See [feature coverage and design limits](docs/FEATURES.md) for the benchmark scope and verification checklist.
