#!/bin/sh
# UserPromptSubmit hook: `/pathlight:open [VIEW]` opens the viewer and stops there, so the model is never called.
# Every other prompt passes through untouched.
input=$(cat)
case "$input" in
  *'"prompt":"/pathlight:open"'*|*'"prompt":"/pathlight:open '*) ;;
  *) exit 0 ;;
esac
# Only a plain view id is passed on; anything else is dropped rather than put on a command line. A leading `tmux` or `pane` says where to open it
# (the Claude plugin's pane answers `pane` itself; here it is always tmux), and is never a view.
view=$(printf '%s' "$input" | sed -n 's/.*"prompt":"\/pathlight:open *\(tmux \|pane \)\{0,1\}\([A-Za-z0-9_.-]*\)".*/\2/p')
case "$view" in tmux|pane) view= ;; esac
if ! command -v pathlight >/dev/null 2>&1; then
  reason="pathlight is not installed. Run: curl -fsSL https://raw.githubusercontent.com/dumbbunnyio/pathlight/main/install.sh | sh"
else
  # Bind to this conversation (the hook input names it), not "the newest session", which before its first tool call is nothing or a stale one.
  session=$(printf '%s' "$input" | sed -n 's/.*"session_id":"\([A-Za-z0-9_-]*\)".*/\1/p')
  if output=$(pathlight open ${view:+"$view"} --workspace "${CLAUDE_PROJECT_DIR:-$PWD}" ${session:+--session "$session" --source claude} 2>&1); then
    reason="Opened the pathlight viewer."
  else
    reason=$(printf '%s' "$output" | tail -n 1 | tr -d '"\\' | cut -c1-300)
  fi
fi
printf '{"continue":false,"stopReason":"%s"}\n' "$reason"
