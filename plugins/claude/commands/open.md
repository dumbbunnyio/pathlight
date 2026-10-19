---
description: Open the live architecture viewer beside this conversation, without asking the model
argument-hint: [view-id]
allowed-tools: Bash(pathlight:*)
---
!`pathlight open $ARGUMENTS --workspace "$CLAUDE_PROJECT_DIR"`
Reply with one short sentence saying whether the viewer opened.
