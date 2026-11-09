#!/bin/sh
# UserPromptSubmit hook: `/pathlight:open [VIEW]` opens the viewer and stops there, so the model is never called.
# Every other prompt passes through untouched.
input=$(cat)
case "$input" in
  *'"prompt":"/pathlight:open"'*|*'"prompt":"/pathlight:open '*) ;;
  *) exit 0 ;;
esac
# Only a plain view id is passed on; anything else is dropped rather than put on a command line. A leading `tmux`, `pane` or `web` says where to
# open it (the Claude plugin's pane answers `pane` itself; here `pane` means tmux), and is never a view. With none, Pathlight's own setting
# (`pathlight config get claude`) decides: `web` opens the browser window, anything else tmux.
where=$(printf '%s' "$input" | sed -n 's/.*"prompt":"\/pathlight:open *\(tmux\|pane\|web\)\( [^"]*\)\{0,1\}".*/\1/p')
view=$(printf '%s' "$input" | sed -n 's/.*"prompt":"\/pathlight:open *\(tmux \|pane \|web \)\{0,1\}\([A-Za-z0-9_.-]*\)".*/\2/p')
case "$view" in tmux|pane|web) view= ;; esac
if ! command -v pathlight >/dev/null 2>&1; then
  reason="pathlight is not installed. Run: curl -fsSL https://raw.githubusercontent.com/dumbbunnyio/pathlight/main/install.sh | sh"
else
  [ -n "$where" ] || where=$(pathlight config get claude 2>/dev/null)
  if [ "$where" = web ]; then
    # The browser page's own window (one per workspace); it shows the map, and the agent's activity reaches it in a later step.
    output=$(pathlight web ${view:+"$view"} --open --workspace "${CLAUDE_PROJECT_DIR:-$PWD}" 2>&1)
    reason=$(printf '%s' "$output" | tail -n 1 | tr -d '"\\' | cut -c1-300)
  else
    # Bind to this conversation (the hook input names it), not "the newest session", which before its first tool call is nothing or a stale one.
    session=$(printf '%s' "$input" | sed -n 's/.*"session_id":"\([A-Za-z0-9_-]*\)".*/\1/p')
    if output=$(pathlight open ${view:+"$view"} --workspace "${CLAUDE_PROJECT_DIR:-$PWD}" ${session:+--session "$session" --source claude} 2>&1); then
      reason="Opened the pathlight viewer."
    else
      reason=$(printf '%s' "$output" | tail -n 1 | tr -d '"\\' | cut -c1-300)
    fi
  fi
fi
printf '{"continue":false,"stopReason":"%s"}\n' "$reason"
