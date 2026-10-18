---
description: Open the live architecture diagram beside this conversation
argument-hint: [view-id]
allowed-tools: Bash(c4view:*)
---
Open the live architecture viewer in the user's tmux window. It follows this session's tool activity.

- If a view ID was given ($ARGUMENTS), run:
  `c4view show $ARGUMENTS --workspace "$CLAUDE_PROJECT_DIR" --follow`
- Otherwise run `c4view list --workspace "$CLAUDE_PROJECT_DIR"`, choose the most useful overview view, and show that one.

If `c4view` is not found, tell the user to run `bun link` in the visualize-work repository. Report only whether the viewer opened. Do not describe the diagram from memory.
