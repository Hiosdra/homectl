// The agent skills, embedded in a compiled executable so that `home-ctl setup` can
// install them without a source checkout. Each skill lists every file it has, relative to
// its folder. A source checkout still links the skills from skills/ instead of copying.
// tests/skill-install.test.ts fails if a file under skills/ is missing from this list.
import homelabSkill from "../skills/homelab/SKILL.md" with { type: "file" };
import homelabEnrollSkill from "../skills/homelab-enroll/SKILL.md" with {
  type: "file",
};
import homelabSetupSkill from "../skills/homelab-setup/SKILL.md" with {
  type: "file",
};

export type BundledSkill = {
  name: string;
  // Path inside the skill folder -> source path of the file.
  files: Record<string, string>;
};

export const bundledSkills: BundledSkill[] = [
  { name: "homelab", files: { "SKILL.md": homelabSkill } },
  { name: "homelab-enroll", files: { "SKILL.md": homelabEnrollSkill } },
  { name: "homelab-setup", files: { "SKILL.md": homelabSetupSkill } },
];

// The text of every file of a skill, keyed by its path inside the skill folder.
export async function skillContents(
  skill: BundledSkill,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(skill.files).map(
      async ([path, source]) => [path, await Bun.file(source).text()] as const,
    ),
  );
  return Object.fromEntries(entries);
}
