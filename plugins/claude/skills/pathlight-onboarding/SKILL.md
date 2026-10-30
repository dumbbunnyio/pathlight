---
name: pathlight-onboarding
description: Use when the user wants to understand a codebase they have not seen yet ("explain this codebase", "walk me through it", "where do I start", "onboard me", /pathlight-onboarding). Gives the first-day briefing from pathlight brief --first-day, then walks the recorded journeys step by step and the boxes no journey touched, moving the pathlight viewer to each with pathlight point. Reads, never edits.
---

# pathlight onboarding

A person new to this code wants to know what it is, how it is built, where it starts and what to read first. The map already holds the facts (the scan, the boxes, the imports) and the agent's reading (names, notes, journeys). This skill gives them those, in that order, and walks them through the map with the diagram beside the chat, one box at a time.

## The rules of the walk

- **Facts first.** Start from what pathlight prints: `pathlight brief --first-day`, `pathlight brief KEY` for the box in hand, `pathlight flows --json` for a journey's steps. Do not read the code to repeat what these already say.
- **Files second, and narrowly.** When a step needs more, open the one file that decides it (the file the step names, the entry point, the box's largest file) and say which file you read. Never read a whole folder to sound thorough.
- **Cite identifiers.** Name each box with its title and key (`Backend API and services [mealie]`), each file as `path:line`. A sentence about behaviour points at where it is.
- **Say what was read and what was inferred.** A note marked `(inferred)` was worked out from file names; say so when you rely on it. Never describe behaviour you did not see in code or in a recorded step.
- **Change nothing.** Names come only through the `pathlight-namer` agent and journeys only through the `pathlight-tracer` agent; do not edit the model, the overlay, the mapping or the code.
- The person can stop at any step. Keep each message short: one box or one step, then wait.
- **A long message scrambles the terminal and is not read.** A walk step is at most eight lines: the box as `<title> [<key>]`, what happens here in two or three sentences, one file as `path:line`, and one line on what you did not read; everything else only if asked.

## Before the walk

1. `pathlight list --workspace .`. No views means no map: follow the `pathlight` skill's **First run** (it asks before writing anything), then come back.
2. `pathlight brief --first-day --workspace .`. If most boxes say `not named yet`, the walk would be folder names: say so and offer to have the `pathlight-namer` agent name them first ("Name every box of the pathlight map in this workspace"). A map a person wrote by hand has no drafted boxes; walk its overview view instead, from its own `.c4` files.

## 1. The briefing

Show the output of `pathlight brief --first-day --workspace .` **as printed**: paste the command's output whole, in a code block; add nothing above it and cut nothing from it. When the briefing was already shown in this conversation (the first run ends with it), say "the briefing above" and do not print it again. It already says what it is, how it is built, where it starts, the journeys, what to read first and how sure the names are. Who owns which part (git history) is not covered; say so if asked.

## 2. Ask once before moving the diagram

"I can move the diagram to each box as we go (it selects the box once and marks it `← agent`; your next key takes over). Shall I?" This is the only question before the walk: take the first journey the briefing lists, never ask "which journey?". Only after a yes, use `pathlight point`. When it answers that no viewer is open, reopen it with `pathlight show VIEW --workspace .` (inside tmux it finds the pane), say so in one line, then point again. Say once that they can press `F` in the viewer instead and step through a journey themselves.

## 3. Walk a journey, step by step

A newcomer learns a codebase by following one thing through. Take the first journey the briefing lists, and at most one more if they want it.

- `pathlight flows --json --workspace .` gives each journey's steps: the two components of each hop (`from`, `to`), the step's text, and the function it calls when the tracer recorded one (`call`).
- For each step: `pathlight point <to-component> --workspace .`, then one message of at most eight lines: which box the work is now in (`<title> [<key>]`), what it does there in two or three sentences (the step's own text, the box's note from `pathlight brief KEY --workspace .`, which takes the step's `to` id as it is, so there is no key to look up), and the one file the step names, read narrowly, cited as `path:line`; then one line on what you did not read.
- A step marked `≠` (no arrow on the map for this hop) is the story and the map disagreeing; say so plainly rather than explaining it away.

**No journey recorded.** Say so. Ask whether the tracer should draw the first journey from the entry point the briefing lists first; on yes, hand it to the `pathlight-tracer` agent with the request the viewer's `d` key sends: `Trace how this works in the "<title>" component (<id>) and record it as a pathlight journey: <what happens from that entry point>`. The tracer decides the journey, never this skill. Until it is recorded, walk the boxes (next section).

## 4. The boxes no journey touched

In the order the briefing's **How it is built** lists them, skipping any box a journey already showed: `pathlight point KEY --workspace .` (a box's key from the briefing works), then one message per box, three lines each, from `pathlight brief KEY --workspace .`: what it is for (its note, marked inferred if it is), the one key file (its largest, or its entry point), and what it talks to (its `imports from` and `imported by`). Move the diagram to the box before its message, and never cover two boxes in one message; inside a big one name the two or three that matter and say how many more there are.

## 5. Where to go next

End with the briefing's **Read these first** and three questions worth asking with `t` in the viewer, each about a real box or step you showed ("how does Backend API and services check a login?"). Then `pathlight point --workspace .` with no element, to clear the mark.

## A point request

"Point the viewer at …" is one `pathlight point` command and one line of reply ("Pointed at `<title> [<key>]`."): no reading, no file list, no offer. When no viewer is open, reopen it as in step 2, say so in the same line, and point.

## A worked example (`examples/parcel`)

Parcel is a small fictional shop, a map a person wrote: no code, so no journey can be recorded and the briefing has no drafted boxes. The walk is the boxes of its overview, `index`, from its own `.c4` files.

1. `pathlight list --workspace examples/parcel` → views `index`, `services`, `checkout`. The briefing says `no drafted map`, so the overview is read from `examples/parcel/model.c4` and `views.c4`.
2. "Parcel is drawn in three views; the overview, *Parcel / System context*, shows the Customer, Parcel itself, and three outside systems: the Payment provider, the Shipping carrier and the Email provider. Shall I move the diagram as we go?" They say yes.
3. No journey: "There is no recorded journey, and Parcel has no code to trace one from. I'll walk the boxes instead."
4. `pathlight point parcel --workspace examples/parcel` → "Parcel [parcel]: the system itself (model.c4). `o` on it opens *Service architecture*, where its Storefront, Commerce and Fulfillment parts are."
5. `pathlight point parcel.commerce --view services --workspace examples/parcel` → "Commerce [parcel.commerce], in *Service architecture*: the Checkout API, Inventory, Orders, Stock and the Outbox relay (model.c4:12). `o` opens *Checkout detail*."
6. … one message per remaining box, then: "Read first: `model.c4` (every element and arrow), then `views.c4`. Worth asking with `t`: how does the Checkout API reach the Payment provider?", and `pathlight point --workspace examples/parcel` to clear the mark.

On a drafted map the same walk starts from the briefing and its journeys, and every box comes with its files.
