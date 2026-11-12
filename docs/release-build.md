# Compiled release build

A release is one executable. It carries the web panel, the credential worker and the session daemon. A source checkout runs the same code with `bun`.

## Steps

```sh
bun install --frozen-lockfile
bun run build:panel                                   # writes src/web/embedded.ts
bun build --compile src/cli/main.ts --outfile homectl
git checkout -- src/web/embedded.ts                   # restore the placeholder before committing
```

- `build:panel` bundles `src/web/app.tsx` for the browser and embeds it with `index.html` and `style.css`.
- A compiled executable refuses `home-ctl update` (install a newer release instead).
- The panel refuses to start in a compiled build without the embedded assets, and says why.

## Checks

- `./home-ctl help` and `./home-ctl __internal session-daemon` (reads a JSON config on stdin) run from the executable.
- `home-ctl serve` in the executable serves `/`, `/app.js` and `/style.css` from the embedded assets. Checked on Linux with Bun 1.4.4: html 347 bytes (a root element), script 281,512 bytes (React included).
- Not yet done: the same checks on Windows and macOS, and the arm64 targets.

## Release archives (scripts/build-release.ts)

`bun scripts/build-release.ts` builds every release executable into `dist/`:

- homectl-VERSION-linux-x64.tar.gz, linux-arm64, linux-x64-musl and linux-arm64-musl (Alpine and other musl systems)
- homectl-VERSION-macos-x64.tar.gz and macos-arm64.tar.gz
- homectl-VERSION-windows-x64.zip
- SHA256SUMS, one line per archive

Each executable carries the web panel. The script builds the panel first and puts the committed placeholder back afterwards, so a release build leaves no diff. One target can be built for a local check: `bun scripts/build-release.ts linux-x64`.

The release workflow (.github/workflows/release.yml) runs the typecheck, lint and tests, builds the archives, and smoke-tests the linux-x64 executable. A version tag (v*) must match the version in package.json. The tag then publishes a GitHub release with the archives and SHA256SUMS. A manual run builds without publishing.

Not built yet: the deb, rpm, apk and pacman packages (nfpm), and the install script.
