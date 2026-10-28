# Margin feature coverage

[Documentation hub](README.md) · [Illustrated user guide](USER_GUIDE.md) · [Architecture](ARCHITECTURE.md) · [Data and security](DATA_AND_SECURITY.md) · [Development](DEVELOPMENT.md)

Margin uses three complementary benchmarks: [Typora's live editing](https://support.typora.io/Quick-Start/), [iA Writer's focused editor](https://ia.net/writer/support/editor), and Obsidian's [linked notes](https://obsidian.md/help/link-notes), [tags](https://obsidian.md/help/tags), [bookmarks](https://obsidian.md/help/Plugins/Bookmarks), and [graph](https://obsidian.md/help/plugins/graph).

The product remains a cross-platform, offline desktop Markdown reader/editor. Markdown files stay readable in other tools. Reading metadata is kept separately in the local app profile.

| Workflow | Margin support |
| --- | --- |
| Reading | Reader themes, typography, widths, outline, search, heading folds, task checkboxes, code copy, remembered position, reading progress |
| Live editing | In-place rendered blocks, click to reveal original Markdown, standard source editing, undo/redo, formatting, table navigation, image import, link suggestions |
| Focused writing | UI focus mode, sentence/paragraph dimming, independent typewriter scrolling, spelling on macOS |
| Rich documents | GFM tables/tasks, footnotes, definitions, raw HTML sanitization, front matter, callouts/alerts, Mermaid, KaTeX, syntax highlighting |
| Connected notes | Wiki and standard links, aliases, heading/block references, bounded embeds, backlinks, outgoing links, tags, missing-note creation |
| Navigation | Folder tree, tabs, Quick Open, literal folder search with unsaved buffers, visit history, global/local graph filtering |
| Personal reading tools | File bookmarks, text highlights, editable notes, highlight colors, quote-based anchors that can relocate after text edits |
| Images | Relative local assets, image paste/drop/picker, transcluded-note assets, fit/zoom/previous/next viewer |
| Presentation | Heading/separator-based slides, one slide rendered at a time, keyboard navigation, math/diagrams/embeds |
| Export | Self-contained HTML/PDF with local images, fonts, math, diagrams, and embedded note content; wiki links become file links |
| Persistence | Atomic document writes, save conflict detection, autosave, external reload checks, crash recovery, persistent reading metadata |
| Privacy | No accounts, telemetry, cloud services, dictionary downloads, AI calls, or background HTTP requests |

## Implementation choices

The existing CodeMirror editor owns the Markdown text in every editing mode. Live mode replaces inactive Markdown blocks with rendered widgets. Selecting a block restores its source; this avoids converting edited HTML back into Markdown. Source and split modes remain available. Very large files use source rendering to keep editing responsive.

Connected notes are indexed only inside an explicitly selected folder and from open documents. Exact paths are preferred, short names require a unique match, and unresolved/ambiguous links are not silently redirected. Code fences and inline code do not generate note links or tags. Filesystem operations use the existing path capability checks and never follow workspace symlinks. Creating a missing note uses an exclusive write and cannot overwrite an existing file.

The graph uses native SVG with a bounded static layout. Presentation and reading panels are separate lazy-loaded chunks. There is no graph library, rich-text framework, database server, plugin runtime, or indexing daemon.

Highlights use quoted text plus surrounding context to find their location after edits. If the text no longer exists, the annotation remains in the Reading desk and jumping to it reports that the text changed. Editing annotations never modifies the source document.

The README documents explicit size limits. This scope covers core reading, writing, and linked-note workflows; Obsidian's plugin ecosystem, hosted sync/publishing, and database/canvas products are outside this desktop reader's scope.

## Verification

Automated tests cover document integrity, rendering and sanitization, filesystem capabilities, search bounds, wiki resolution and ambiguity, code exclusions, embeds/cycles, callouts, exports, annotation anchors, reading storage validation, collapsible sections, live editor selection/undo, and slide boundaries.

`npm run test:desktop` exercises the real Electron app in an isolated temporary profile: folder/file opening, note navigation, reference/footnote-aware embeds, bookmarks, cross-paragraph annotations without source changes, folding, image zoom, slides, live editing/undo/focus, YAML tags, missing-note creation/completion, graph navigation, persistence after reload and full restart, and offline network behavior. It verifies scrolling immediately before a tab closes, rather than waiting for a persistence debounce.

Production builds and native app packaging are checked separately. `scripts/Dockerfile.smoke` provides a repeatable Linux environment; `.github/workflows/desktop.yml` runs the same tests and unpacked app packaging on macOS, Windows, and Linux when published. The Linux container disables Chromium's OS sandbox for its isolated test processes; the production application retains its sandbox configuration. Native Windows validation requires the Windows job or a Windows development machine.
