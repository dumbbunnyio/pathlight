#!/bin/sh
# PreToolUse hook (Bash): an agent's own call to a pathlight command that writes the map (name, draft, plan, refresh, flow, setup, init) is refused
# when the pathlight on the PATH is older than this plugin needs, since an older binary redraws the map without what it does not know. Every other
# call passes untouched, and nothing is run for it.
input=$(cat)
case "$input" in *'"tool_name":"Bash"'*) ;; *) exit 0 ;; esac
case "$input" in
  *'pathlight name'*|*'pathlight draft'*|*'pathlight plan'*|*'pathlight refresh'*|*'pathlight flow'*|*'pathlight setup'*|*'pathlight init'*) ;;
  *) exit 0 ;;
esac
command -v pathlight >/dev/null 2>&1 || exit 0
pathlight needs 1 >/dev/null 2>&1 && exit 0
reason="The pathlight on this computer ($(command -v pathlight)) is older than the Claude plugin needs, and would redraw the map without what it does not know. Do not run it: tell the person in one line to update it with npm i -g @dumbbunnyio/pathlight, or the install script again."
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$(printf '%s' "$reason" | tr -d '"\\')"
