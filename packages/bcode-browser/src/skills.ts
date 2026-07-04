// Skills directory resolver.
//
// Materializes the skills tree to `<dataDir>/skills/` and substitutes the
// `{{SKILLS_DIR}}` placeholder in every file with that absolute path so any
// cross-references inside the skill files point at a real location.
//
// Compiled launches (the user-facing path) read a one-line sentinel at
// `<target>/.bcode-build` recording `<buildHash>:<target>`. When it matches
// — i.e. same build, same dataDir — the resolver returns immediately
// without reading or writing any skill content. The build hash is computed
// once by `script/embed-skills.ts` and lives in the binary, so the cost is
// a single small file read.
//
// Dev launches (`bun run dev`) always re-extract from the worktree so
// editor saves to source skill files land on the next launch without a
// separate invalidation step.

import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isCompiled = __dirname.replaceAll("\\", "/").match(/^\/\$bunfs\/|^B:\/~BUN\//) !== null
const DEV_SKILLS_DIR = path.resolve(__dirname, "..", "skills")
const SENTINEL = ".bcode-build"

// Static — the agent permission glob and the substituted placeholder both
// resolve to this path.
export const skillsDir = (dataDir: string) => path.join(dataDir, "skills")

const cache = new Map<string, Promise<string>>()

export const resolveSkillsDir = (dataDir: string): Promise<string> => {
  const cached = cache.get(dataDir)
  if (cached) return cached
  const fresh = materialize(skillsDir(dataDir))
  cache.set(dataDir, fresh)
  fresh.catch(() => { if (cache.get(dataDir) === fresh) cache.delete(dataDir) })
  return fresh
}

const materialize = async (target: string): Promise<string> => {
  // Compiled-mode short-circuit: import the embed (cheap — just file
  // handles, no content read), check the sentinel, return on hit.
  // @ts-expect-error generated at build time
  const embed = isCompiled ? await import("bcode-skills.gen.ts").catch(() => null) : null
  if (isCompiled && !embed) throw new Error("bcode-skills.gen.ts not found — was the build script updated?")
  const want = `${embed?.buildHash ?? "dev"}:${target}`
  if (embed && (await fs.readFile(path.join(target, SENTINEL), "utf8").catch(() => null)) === want) return target

  await fs.mkdir(target, { recursive: true })
  const map = embed
    ? await readEmbed(embed.files)
    : await readDevSkills()

  await Promise.all(
    Object.entries(map).map(async ([rel, content]) => {
      const dest = path.join(target, rel)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.writeFile(dest, content.replaceAll("{{SKILLS_DIR}}", target), "utf8")
    }),
  )
  if (embed) await fs.writeFile(path.join(target, SENTINEL), want, "utf8")
  return target
}

const readEmbed = async (map: Record<string, string>): Promise<Record<string, string>> =>
  Object.fromEntries(
    await Promise.all(Object.entries(map).map(async ([rel, p]) => [rel, await fs.readFile(p, "utf8")])),
  )

const readDevSkills = async (): Promise<Record<string, string>> => {
  const all = await fs.readdir(DEV_SKILLS_DIR, { recursive: true })
  const rels: string[] = []
  for (const rel of all) {
    const stat = await fs.stat(path.join(DEV_SKILLS_DIR, rel))
    if (stat.isFile()) rels.push(rel)
  }
  return Object.fromEntries(
    await Promise.all(
      rels.map(async (rel) => [
        rel.replaceAll("\\", "/"),
        await fs.readFile(path.join(DEV_SKILLS_DIR, rel), "utf8"),
      ]),
    ),
  )
}

export * as Skills from "./skills"
