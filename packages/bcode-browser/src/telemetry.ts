// Telemetry key injection.
//
// At build time, `packages/opencode/script/build.ts` substitutes
// `BCODE_DEFAULT_LMNR_KEY` with a string literal via Bun's `define`. The
// release workflow sources that value from a GitHub Actions secret; local
// `bun run build` invocations leave it empty, so self-builds never emit
// telemetry.
//
// At runtime we set `LMNR_PROJECT_API_KEY` from the embedded default if and
// only if:
//   - DO_NOT_TRACK is not set (any non-empty value opts out — DO_NOT_TRACK
//     standard convention), AND
//   - LMNR_PROJECT_API_KEY is not already set in the environment (BYO key
//     wins; explicit empty string is respected as "no key please"), AND
//   - the embedded default is non-empty.
//
// No `if (telemetryEnabled)` branches downstream — `@browser-use/bcode-laminar`
// reads `LMNR_PROJECT_API_KEY` and initializes only when present, so the gate
// here decides everything.
//
// `applyTelemetryKey()` is invoked as a side effect on module import (bottom
// of this file). `packages/opencode/src/index.ts` imports this module before
// any other import; ESM evaluates an imported module's side effects before
// continuing to the next import, so the gate is unambiguously ordered before
// any downstream module-load code that might read `LMNR_PROJECT_API_KEY` —
// sidestepping the static-import hoisting concern.

import { mkdirSync } from "fs"
import { homedir } from "os"
import { dirname, join } from "path"

declare const BCODE_DEFAULT_LMNR_KEY: string

export const applyTelemetryKey = () => {
  // DO_NOT_TRACK: presence with any non-empty value opts out, per the
  // de-facto standard (consoledonottrack.com, Astro, Homebrew, npm).
  if (process.env.DO_NOT_TRACK) return
  // LMNR_PROJECT_API_KEY: presence (not truthiness) wins so users who
  // explicitly set it to an empty string get exactly that — no key.
  if (process.env.LMNR_PROJECT_API_KEY !== undefined) return
  // `typeof` first: in dev (no Bun `define` substitution) the identifier is
  // undeclared and a direct read throws ReferenceError.
  if (typeof BCODE_DEFAULT_LMNR_KEY === "undefined" || !BCODE_DEFAULT_LMNR_KEY) return
  process.env.LMNR_PROJECT_API_KEY = BCODE_DEFAULT_LMNR_KEY
  showFirstRunNoticeOnce()
}

// Industry-standard short notice: one line stating what happens and how to
// opt out. Prints once; subsequent launches stay quiet.
//
// Uses XDG_STATE_HOME / ~/.local/state on Linux, %LOCALAPPDATA% on Windows,
// ~/Library/Application Support on macOS. Resolved without importing
// @opencode-ai/core/global since this runs before that module loads.
const showFirstRunNoticeOnce = () => {
  const marker = join(stateDir(), "bcode", "telemetry-notice-shown")
  if (Bun.file(marker).size > 0) return
  process.stderr.write(
    "BrowserCode sends anonymous usage traces. Set DO_NOT_TRACK=1 to opt out.\n",
  )
  try {
    mkdirSync(dirname(marker), { recursive: true })
  } catch {}
  Bun.write(marker, "1\n").catch(() => {})
}

const stateDir = () => {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support")
  }
  return process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
}

// Run as an import side effect: this module is imported as the very first
// import of `packages/opencode/src/index.ts`, so by the time any other
// module's top-level code reads `LMNR_PROJECT_API_KEY` the gate has already
// resolved.
applyTelemetryKey()

export * as Telemetry from "./telemetry"
