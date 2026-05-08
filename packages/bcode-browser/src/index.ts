// @browser-use/bcode-browser
//
// This package holds all Level-1 BrowserCode code — substantial implementation
// that is logically self-contained and has zero upstream-fork friction.
//
// See decisions.md §1c (three-level model) and §1d (this package) in the
// BrowserCode memory docs.
//
// Contents:
//   src/cdp/               — vendored CDP layer (session.ts, generated.ts, codegen)
//   src/browser-execute.ts — in-process JS-eval browser_execute body
//   src/session-store.ts   — per-opencode-session CDP Session map
//   src/skills.ts          — runtime resolver for embedded skills
//   skills/                — BROWSER.md + interaction-skills/*.md + cloud-browser.md (embedded into binary)
//
// Cloud browser provisioning is intentionally NOT a separate Level-1
// surface. The agent reads `skills/cloud-browser.md` and writes the
// fetch+connect snippet itself, matching how local-browser connect works
// (snippet-side, not tool-side). Decisions trail in
// `memory/browsercode/decisions.md` §3.4.
//
// Planned (per ROADMAP phase):
//   src/fetch-use/         — FetchUse.Service implementation (ROADMAP B1)
//   src/cloud/             — cloud deploy, skillbase, judge clients (Phase D)
//
// Integration points into packages/opencode (tool registration, service wiring,
// CLI commands) are Level 2 — they live in packages/opencode/src, not here,
// and must stay as minimal as possible (one-line rule).
