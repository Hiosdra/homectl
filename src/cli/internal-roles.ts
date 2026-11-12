// Internal roles that homectl starts for itself (src/internal.ts), run as
// `home-ctl __internal <role>`. Nothing else is parsed here. Each role's module runs on
// import; the session daemon keeps the process alive.
export async function runInternal(role: string | undefined): Promise<number> {
  // The worker reports its own status in process.exitCode, so keep it.
  if (role === "worker") {
    await import("../credentials/worker");
    return Number(process.exitCode ?? 0);
  }
  if (role === "session-daemon") {
    await import("../session/daemon");
    return 0;
  }
  // An update runs this in the new release to copy that release's skills.
  if (role === "refresh-skills")
    return (await import("../skill-install")).refreshSkills();
  return 2;
}
