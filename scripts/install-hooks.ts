// Points git at the repository's hooks (.githooks). Runs as `prepare` on
// `bun install`; outside a git checkout (a source archive, a container
// build) it does nothing.
const inside = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
  stdout: "pipe",
  stderr: "ignore",
});
if (inside.exitCode === 0 && inside.stdout.toString().trim() === "true") {
  const set = Bun.spawnSync(["git", "config", "core.hooksPath", ".githooks"]);
  if (set.exitCode !== 0)
    console.warn("install-hooks: could not set core.hooksPath");
}
