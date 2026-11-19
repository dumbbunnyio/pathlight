/**
 * What this binary can do for the plugins, and read of what other binaries write, as one number. Bump it when an older binary would misread or
 * damage what this one writes (a new key in the mapping, as Phase 7's `runs`: an older `refresh` rewrote the mapping without it), or when the
 * plugins start to use a command or flag an older binary lacks. The plugins ask `pathlight needs N` before they run anything that writes; a binary
 * older than this command fails it too, so every older one is caught. `tests/contract.test.ts` keeps the hooks' number equal to this one.
 * `record` is not gated: the activity journal and the session pointer must stay readable and writable by older binaries, so change them only by
 * adding what an older one may ignore (an older `record` rewrites the pointer with the keys it knows).
 */
export const contract = 1;

/** How to put a newer pathlight on the PATH, for the line that says this one is too old. */
export const updateHint = "Update it with npm i -g @dumbbunnyio/pathlight, or run the install script again (curl -fsSL https://raw.githubusercontent.com/dumbbunnyio/pathlight/main/install.sh | sh).";
