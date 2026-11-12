import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkillCopy, skillManifest } from "../src/skill-install";
import { bundledSkills, skillContents } from "../src/skills-bundle";

const skillsDir = join(import.meta.dir, "..", "skills");
const windows = process.platform === "win32";

async function withTemp(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "homectl-skills-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the executable carries every file of every skill", async () => {
  const folders = (await readdir(skillsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(bundledSkills.map((skill) => skill.name).sort()).toEqual(folders);

  for (const skill of bundledSkills) {
    const onDisk: string[] = [];
    for await (const file of new Bun.Glob("**/*").scan({
      cwd: join(skillsDir, skill.name),
      onlyFiles: true,
    }))
      onDisk.push(file.replaceAll("\\", "/"));
    expect(Object.keys(skill.files).sort()).toEqual(onDisk.sort());
  }
});

test("copies a skill into an empty folder and is idempotent", async () => {
  await withTemp(async (root) => {
    const dest = join(root, "homelab");
    const skill = bundledSkills.find((item) => item.name === "homelab");
    if (skill === undefined)
      throw new Error("the homelab skill is not bundled");
    const files = await skillContents(skill);
    const expected = files["SKILL.md"];
    if (expected === undefined) throw new Error("SKILL.md is not bundled");
    await installSkillCopy(dest, files);
    expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe(expected);
    const manifest = await readFile(join(dest, skillManifest), "utf8");
    expect(Object.keys(JSON.parse(manifest))).toEqual(["SKILL.md"]);

    await installSkillCopy(dest, files);
    expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe(expected);
  });
});

test("a newer release replaces a copy that nobody has edited", async () => {
  await withTemp(async (root) => {
    const dest = join(root, "homelab");
    await installSkillCopy(dest, { "SKILL.md": "version one\n" });
    await installSkillCopy(dest, { "SKILL.md": "version two\n" });
    expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe(
      "version two\n",
    );
  });
});

test("an edited copy is kept, and nothing else is written", async () => {
  await withTemp(async (root) => {
    const dest = join(root, "homelab");
    await installSkillCopy(dest, { "SKILL.md": "version one\n" });
    await writeFile(join(dest, "SKILL.md"), "my own notes\n");
    await expect(
      installSkillCopy(dest, {
        "SKILL.md": "version two\n",
        "extra.md": "new file\n",
      }),
    ).rejects.toThrow("replacement requires separate explicit approval");
    expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe(
      "my own notes\n",
    );
    expect(existsSync(join(dest, "extra.md"))).toBe(false);
  });
});

test("a folder that homectl did not install is not overwritten", async () => {
  await withTemp(async (root) => {
    const dest = join(root, "homelab");
    await mkdir(dest);
    await writeFile(join(dest, "SKILL.md"), "someone else's skill\n");
    await expect(
      installSkillCopy(dest, { "SKILL.md": "version one\n" }),
    ).rejects.toThrow("changed or was not installed by homectl");
    expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe(
      "someone else's skill\n",
    );
  });
});

test.skipIf(windows)(
  "a link into a checkout is kept, never written through",
  async () => {
    await withTemp(async (root) => {
      const checkout = join(root, "checkout");
      await mkdir(checkout);
      await writeFile(join(checkout, "SKILL.md"), "same\n");
      const dest = join(root, "homelab");
      await symlink(checkout, dest);

      await installSkillCopy(dest, { "SKILL.md": "same\n" });
      expect(existsSync(join(checkout, skillManifest))).toBe(false);

      await expect(
        installSkillCopy(dest, { "SKILL.md": "different\n" }),
      ).rejects.toThrow("replacement requires separate explicit approval");
      expect(await readFile(join(checkout, "SKILL.md"), "utf8")).toBe("same\n");
    });
  },
);
