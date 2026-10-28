# @dumbbunnyio/pathlight-opencode

[Pathlight](https://github.com/dumbbunnyio/pathlight) for OpenCode: an architecture diagram beside your conversation that lights up the components the agent reads and edits, and a Sonnet-sized tracer agent that records how something works as a flow.

This package is the OpenCode side only. It needs the `pathlight` binary on your PATH:

```sh
npm i -g pathlight
```

(or, without Node, `curl -fsSL https://raw.githubusercontent.com/dumbbunnyio/pathlight/main/install.sh | sh`).

Then let `pathlight` add this plugin to your global OpenCode config for every project:

```sh
pathlight init --global
```

Or add it to one project's `opencode.json` yourself (`record: true` turns on observation of that workspace's sessions; leave it out to record only when asked):

```json
{ "plugins": [{ "package": "@dumbbunnyio/pathlight-opencode", "options": { "record": true } }] }
```

Then, inside tmux, `/pathlight-open` opens the viewer and `/pathlight` asks the agent to set it up (`pathlight setup`).

## The tracer model

Pressing `d` in the viewer asks the agent to trace a flow. The plugin registers a read-only `pathlight-tracer` subagent for that, so the reading does not run on your largest model. It is pinned to the newest Sonnet-class model you can use. If you have none, it runs on your current model; ask the agent to run `pathlight_models`, or set it yourself:

```json
{ "plugins": [{ "package": "@dumbbunnyio/pathlight-opencode", "options": { "tracerModel": "anthropic/claude-sonnet-5-5" } }] }
```

Only Sonnet-class models have been measured doing this well (Sonnet passed 4 of 5 test traces, Haiku 1 of 5; see the Pathlight repository, `docs/eval.md`).
