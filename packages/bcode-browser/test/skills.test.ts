// Skills materialization with `{{SKILLS_DIR}}` template substitution.
// Regression guard: the on-disk skill files must not contain literal
// `{{SKILLS_DIR}}` strings — those are templates the agent reads as
// resolved absolute paths.

import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Skills } from "../src/skills"

test("resolveSkillsDir materializes skills with {{SKILLS_DIR}} substituted", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-skills-"))
  try {
    const dir = await Skills.resolveSkillsDir(dataDir)
    expect(dir).toBe(path.join(dataDir, "skills"))
    const browser = (await fs.readFile(path.join(dir, "browser-execute", "SKILL.md"), "utf8")).replaceAll("\\", "/")
    expect(browser).not.toContain("{{SKILLS_DIR}}")
    expect(browser).toContain(`${dir.replaceAll("\\", "/")}/`)
    expect(browser).toContain("`browser_delegate` should have been the first browser tool")
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test("different dataDirs get their own substituted paths", async () => {
  const a = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-skills-a-"))
  const b = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-skills-b-"))
  try {
    const dirA = await Skills.resolveSkillsDir(a)
    const dirB = await Skills.resolveSkillsDir(b)
    const [browserA, browserB] = (await Promise.all([
      fs.readFile(path.join(dirA, "browser-execute", "SKILL.md"), "utf8"),
      fs.readFile(path.join(dirB, "browser-execute", "SKILL.md"), "utf8"),
    ])).map((s) => s.replaceAll("\\", "/"))
    const [a2, b2] = [dirA.replaceAll("\\", "/"), dirB.replaceAll("\\", "/")]
    expect(browserA).toContain(a2)
    expect(browserB).toContain(b2)
    expect(browserA).not.toContain(b2)
    expect(browserB).not.toContain(a2)
  } finally {
    await fs.rm(a, { recursive: true, force: true })
    await fs.rm(b, { recursive: true, force: true })
  }
})
