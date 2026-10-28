# Quick start

Pathlight draws your codebase's architecture beside your AI coding agent and lights up the parts it reads and edits. This page is the one screen you need; [the viewer reference](native-viewer.md) has the rest.

## Open it

In a tmux pane, in the project you work in:

- **Claude Code** (with the plugin): type `/pathlight`. The first time, the agent runs `pathlight setup`, draws a first map from the code, names its boxes, and opens the viewer beside the conversation. Later, `/pathlight:open` reopens it without asking the model.
- **OpenCode** (with the plugin): type `/pathlight`, and `/pathlight-open` to reopen it.
- **A shell**: `pathlight setup --yes` draws the map, `pathlight init --workspace .` wires the agent's hooks, `pathlight open` turns the pane into the viewer.

## Three keys to start

- `tab` selects the next box; the inspector on the right says what it is and what it connects to.
- `t` asks the agent about it. On first open the question is already there (`how does … work?`): press Enter, and the answer arrives in chat and is drawn on the map.
- `F` steps through what was drawn, one hop at a time (`[` `]` move, `esc` leaves).

`?` lists every key, in three groups, in the order you will want them.

## Understand it

Everyone starts here, even on their own code. Select boxes (`tab`, a click, `h j k l`), go into a group with `enter` and back out with `backspace`. Ask how something works with `t`: a question about a path ("how does a document get saved?", "where does the token go?") is answered and recorded as a journey, which `F` walks on the diagram. Everything drawn this way is the agent's reading of the code, in violet, never something observed.

## Direct it

Once you know the ground, the same `t` tells the agent what to change ("add a health-check route"). Before it edits a file it declares where it will work: the boxes it will touch are outlined, and anything new appears dashed where you pointed. As it works, the boxes it reads and edits light up; `a` follows the work, `w` jumps to it, `c` shows the session and asks you about any new dependency the code gained. `e` lists a box's files and opens one in your editor, `/` searches, `g` changes view, `b` goes back, `f` fits.

## Shape the map

The map is yours to correct. `d` asks the agent to trace a flow from the selected box, `m` asks it to improve a box's name and description, `n` lets you write them yourself (yours are never overwritten). `p` replays the session, `s` hides subagent calls, `T` picks a theme.

## What it is not

Pathlight shows the code's structure (from its imports), the agent's reading of it, and the tool calls the agent made. It never shows runtime traffic, and it says which of the three each thing on screen is. Linux and tmux are the verified platform.
