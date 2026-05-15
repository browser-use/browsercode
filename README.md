<picture>
  <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/2ccdb752-22fb-41c7-8948-857fc1ad7e24">
  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/774a46d5-27a0-490c-b7d0-e65fcbbfa358">
  <img alt="Shows a black Browser Use Logo in light color mode and a white one in dark color mode." src="https://github.com/user-attachments/assets/2ccdb752-22fb-41c7-8948-857fc1ad7e24"  width="100%">
</picture>

<div align="center">
<h2>The browser-native agent framework.</h2>
</div>

<div align="center">
<a href="#demos"><img src="https://media.browser-use.tools/badges/demos" alt="Demos"></a>
<img width="16" height="1" alt="">
<a href="https://docs.browser-use.com"><img src="https://media.browser-use.tools/badges/docs" alt="Docs"></a>
<img width="16" height="1" alt="">
<a href="https://browser-use.com/posts"><img src="https://media.browser-use.tools/badges/blog" alt="Blog"></a>
<img width="280" height="1" alt="">
<a href="https://github.com/browser-use/browser-use"><img src="https://media.browser-use.tools/badges/github" alt="Github Stars"></a>
<img width="4" height="1" alt="">
<a href="https://x.com/intent/user?screen_name=browser_use"><img src="https://media.browser-use.tools/badges/twitter" alt="Twitter"></a>
<img width="4" height="1" alt="">
<a href="https://link.browser-use.com/discord"><img src="https://media.browser-use.tools/badges/discord" alt="Discord"></a>
</div>

<br/>

# BrowserCode

A streamlined coding agent that drives real browsers through unconstrained CDP.

The unbounded power of the browser working seamlessly with your code. The agent adapts to every site at runtime and writes scripts to reuse later.

<span id="demos"></span>
<!-- DEMO VIDEO HERE -->

## One-Line Install Command

Run this in a terminal that supports bash:

```sh
curl -fsSL https://bcode.sh/install | bash
```

## Usage

Open the TUI:

```sh
bcode
```

Run an agent headlessly:

```sh
bcode run "Connect to my browser and find the cheapest way to SF via any bus/train/rideshare"
```

### Connect an LLM

BrowserCode supports any model you can reach with an API key, plus every provider OpenCode supports.

[OpenCode provider docs](https://opencode.ai/docs/providers)

Use `/connect` in the TUI, or set provider API keys in your environment.

<picture>
  <source media="(prefers-color-scheme: light)" srcset="static/browser_harness_by_model_light.png">
  <source media="(prefers-color-scheme: dark)" srcset="static/browser_harness_by_model_dark.png">
  <img alt="BU Bench V1 Browser Harness bcode v0.0.3 accuracy by model, led by claude-opus-4-7, gpt-5.5, mimo-v2.5-pro, and glm-5.1" src="static/browser_harness_by_model_light.png" width="100%">
</picture>

Recommended models from current BrowserCode evals:

- Frontier: `claude-opus-4-7`, `gpt-5.5`
- Value: `glm-5.1`, `mimo-v2.5-pro`
- Budget: `gemini-3-flash-preview`

### Connect a Browser

Let the agent connect for you. It knows how. You can prompt:

```text
Connect to my current tab at https://amazon.com and look for a better deal for 64GB DDR5 RAM and return the URLs
```

The agent will take control of your actual browser.

```text
Make a new browser profile and work in the background to QA test http://localhost:3000, fix any bugs and open a PR
```

The agent will work locally in its own browser profile.

```text
Open a remote browser and extract every item sold at https://mcdonalds.com in SF
```

The agent will control a Browser Use Cloud browser and give you a link to watch it.

#### Cloud Browsers

- Browser Use Cloud offers unlimited free browsers, limited to 3 concurrent sessions, with stealth, captcha solving, and proxies.
- Just set `BROWSER_USE_API_KEY` in your environment. The agent can sign up completely autonomously; just ask it to. To upgrade further, go to [cloud.browser-use.com](https://cloud.browser-use.com).
- For a long-lived Browser Use Cloud browser controlled from Telegram on your own VPS, see [Browser Use Box](https://browser-use.com/bux) and the [15-second demo](https://www.tiktok.com/@browser_use/video/7639824093721758989).

## Philosophy

Browser ability and code-writing ability are deeply connected.

We turned browser interaction into a coding problem; the agent writes JavaScript that drives Chrome directly through CDP. Maximal power to the agent. Minimal abstractions. 

#### Do more with less.

*BrowserCode outperforms every browser agent we have tested it against.*

## Architecture

BrowserCode is a fork of [OpenCode](https://github.com/anomalyco/opencode) with a vendored TypeScript port of [Browser Harness](https://github.com/browser-use/browser-harness).

It adds one core browser primitive:

```text
browser_execute(code)
  -> runs JavaScript in-process
  -> talks to Chrome through the DevTools Protocol
  -> keeps the browser session alive across calls
  -> returns logs, values, and screenshots to the agent
```

Reusable browser scripts are written to:

```text
.bcode/agent-workspace/
```

*BrowserCode is not built by the OpenCode team and is not affiliated with OpenCode in any way.*

## Telemetry

BrowserCode sends anonymous usage traces to help improve the project. To opt out, set `DO_NOT_TRACK=1` in your environment.

## Contributing

Most upstream contributions belong in one of the projects BrowserCode builds on:

- Browser automation: [browser-use/browser-harness](https://github.com/browser-use/browser-harness)
- Core coding-agent: [anomalyco/opencode](https://github.com/anomalyco/opencode)

Run from source:

```sh
git clone https://github.com/browser-use/browsercode.git
cd browsercode
bun install
bun run --cwd packages/opencode dev
```

---

<p align="center">Tell your computer what to do, and it gets it done.</p>

<!-- FOOTER IMAGE HERE -->
