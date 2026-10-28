# Documentation images

These PNGs are real screenshots of Margin's production renderer using the public notes in [examples](../examples/Welcome.md). They are not AI-generated interface mockups and do not contain a real user notebook or reading profile.

| File | Shows |
| --- | --- |
| [reading.png](reading.png) | Read mode, workspace navigation, bookmark, selected-text annotation |
| [live.png](live.png) | Source-preserving Live mode and connected-note backlinks |
| [split.png](split.png) | Source and rendered preview side by side |
| [graph.png](graph.png) | Sample-note graph with zoom controls |
| [dark.png](dark.png) | Dark interface and Midnight reading surface |

Screenshots use a 1440 × 960 CSS-pixel content-size request and are captured at CSS scale. Platform/window constraints can affect the actual captured height, so use the PNG dimensions as authoritative. The macOS captures can differ cosmetically from Windows/Linux.

## Reproduce

From the repository root, after installing dependencies:

```sh
npm run build
node docs/capture-screenshots.cjs
```

To capture a packaged Apple Silicon Mac build instead:

```sh
MARGIN_SMOKE_EXECUTABLE="$PWD/release/mac-arm64/Margin.app/Contents/MacOS/Margin" node docs/capture-screenshots.cjs
```

The tool copies example notes to a fresh temporary directory, launches a fresh profile, selects only those fixtures through test dialog handlers, and asserts the profile path before proceeding. It writes the five named screenshots here and prints the fixture location. A real user profile is never needed. Review each image for completed rendering and readable framing before accepting the update.

The diagrams are maintained as Mermaid source inside the architecture/data guides. Margin renders them locally from its bundled engine; GitHub also renders compatible fenced Mermaid blocks. They explain real process/data relationships and are not screenshots of an imaginary UI.

These are documentation-only assets. The packaging allowlist does not include `docs/`, so the screenshots do not increase the distributed application's runtime payload.
