# Compiled release build

A release is one executable. It carries the web panel, the credential worker and the session daemon. A source checkout runs the same code with `bun`.

## Steps

```sh
bun install --frozen-lockfile
bun run build:panel                                   # writes src/web/embedded.ts
bun build --compile src/cli/main.ts --outfile homectl
git checkout -- src/web/embedded.ts                   # restore the placeholder before committing
```

- `build:panel` bundles `src/web/app.ts` for the browser and embeds it with `index.html` and `style.css`.
- A compiled executable refuses `homectl update` (install a newer release instead).
- The panel refuses to start in a compiled build without the embedded assets, and says why.

## Checks

- `./homectl help` and `./homectl __internal session-daemon` (reads a JSON config on stdin) run from the executable.
- `homectl serve` in the executable serves `/`, `/app.js` and `/style.css` from the embedded assets. Checked on Linux with Bun 1.4.4: html 3,750 bytes, script 58,563 bytes, css 15,836 bytes.
- Not yet done: the same checks on Windows and macOS, and the arm64 targets.
