# Project intent: see the architecture of the work

Status: the approved native explorer is integrated as the production default.
This document records the product direction and accepted design as of
2026-10-18; it is not a claim that all platforms or future capabilities are done.

## What we are trying to achieve

Give a developer working with an AI coding agent a persistent, navigable view of
the system beside the conversation. The developer should be able to answer:

- Where does this component sit in the architecture?
- What does it depend on, and what depends on it?
- Which explicitly mapped files implement it?
- Where is the bound agent session reading or editing right now, according to
  the tool events we actually received?

The diagram should be a working interface, not a picture the agent generates and
forgets. Moving between architecture, source files and the conversation should
not require losing orientation or reopening the viewer.

## The intended working loop

1. Open a LikeC4 view beside the coding conversation in an owned tmux pane.
2. Explore with selection, search, pan/zoom, group/parent navigation and explicit
   linked views. Inspect incoming/outgoing relationships without obscuring nodes.
3. Select a component, browse its mapped files, filter the list, and open a file
   in the developer's editor. Return to the same diagram context afterward.
4. Optionally bind the viewer to an opted-in agent session. See mapped READ/EDIT
   activity and observed outcomes without changing layout, selection or camera.
5. Follow a linked detail view and return with Back, restoring the previous
   selection and camera. Reuse the owned pane for a new requested view safely.

This loop is supported today through the CLI, with OpenCode integration and a
Claude hook adapter. The Claude adapter has payload-based tests; a complete
interactive Claude session has not been verified.

## Accepted design

### Architecture comes from LikeC4

LikeC4 owns element IDs, relationships, hierarchy and diagram layout. Navigation
between views follows explicit links. File attribution comes from explicit
workspace mappings, not agent guesses or title matching.

### The primary experience is genuinely interactive terminal UI

OpenTUI renders nodes, groups, labels and an inspector. Three supplies the eased
orthographic camera; orthogonal thin-line connectors with rounded bends
connect the nodes. They share the same projection so picking and connectors remain
aligned as the developer moves around.

The user approved the Three camera, the orthogonal thin-line appearance, polished inspector and
restored workflows. Preserve these together. A prior ScrollBox-based camera was
rejected because its movement did not match the approved experiment. Replacing
the camera again requires a demonstrated improvement and explicit approval,
not merely an equivalent feature checklist.

The inspector adapts between side and bottom layouts, supports a draggable
divider, and can be hidden. Linux usability and visual quality take priority;
narrow terminals must remain usable rather than being treated as an afterthought.

### Live activity means observed agent work—not runtime telemetry

Events describe tool starts and outcomes mapped to architecture elements. A read
or edit may pulse the affected node; it does not demonstrate traffic along a
relationship. A successful tool call is not proof of passing tests or correctness.

Activity is best-effort, bounded and local. Unmapped work remains unmapped.
Old unfinished calls become unconfirmed rather than being presented as proof
that a tool is still running. A group shows its own mapped activity, not an
automatic roll-up of its children.

Workspace, project, source and session attribution must prevent unrelated work
from appearing in the viewer. Viewing is distinct from recording: opening a
bound CLI viewer consumes retained events, and closing it does not stop an
already-enabled observer. No source code or tool payloads belong in the journal.

### Continuity and safe ownership are product features

Search cancellation, linked-view history and editor return preserve orientation.
Activity must not recenter the camera. External editors own input while active.
Shutdown must clean up owned resources and editor process groups, without
touching the user's conversation or a pane repurposed for another command.

## What “working” means

Changes must preserve these observable outcomes:

| Outcome | Evidence to seek |
| --- | --- |
| Developer can explore without losing orientation | Search cancel and Back restore selection, pan and zoom; resize keeps interaction aligned |
| Architecture leads to real source | Mapped-file filtering/refresh, safe paths, actual editor open/save/return |
| Native diagram remains readable and interactive | Flat/nested views, node/group clicks, projected markers, narrow/wide inspector checks |
| Live activity is truthful | Real journal events, project/session isolation, no camera movement or synthetic connection traffic |
| Integration is safe | Usable-frame readiness, pane reuse/replacement, error rollback, signal and editor-group cleanup |
| The approved experience survives implementation changes | Terminal regression checks plus an actual visual check when appearance or movement changes |

Automated tests establish behavior, not universal visual quality or portability.
Keep platform-specific and manual verification claims separate.

## Non-goals for the current scope

- Replacing LikeC4 with an inferred architecture model or automatic layout system.
- Inferring file ownership, links, runtime traffic or test outcomes from agent prose.
- Editing the architecture model through the viewer, or becoming a source editor.
- A hosted dashboard, network telemetry service, collaborative presence system,
  or durable audit log.
- Automatically recording every agent/subagent session, or presenting a subagent's work as the conversation's own. Claude subagent calls are recorded with their type as a label and can be hidden; they are never unlabelled.
- Pixel-identical reproduction of every LikeC4 shape in native terminal cells.

These are scope boundaries, not promises of later implementation.

## Current limits and remaining validation

- Linux/tmux is verified. macOS and broader terminal compatibility remain open;
  locking currently relies on Linux `flock`.
- Connectors are routed by a simple grid search; in very dense diagrams two routes can share a lane or pass close to a node.
- Labels may clip or hide at small scales; boxes move on terminal-cell boundaries.
  Dot and diamond markers are drawn as plain arrowheads.
- Search is confined to the current view. Group collapsing, relationship-link
  navigation and model editing are not implemented.
- Journals can lose events under overload or disk failure. Their bounded history
  cannot answer historical questions like a durable event store.

Near-term work should harden and validate this working loop, address concrete
usability failures, and improve compatibility without sacrificing the approved
camera or inventing observation semantics. New product capabilities should be
proposed against this intent before expanding the scope.

## Related documents

- [README](../README.md): installation, CLI, integrations and activity configuration.
- [Native viewer](native-viewer.md): current controls and detailed limits.
- [AGENTS.md](../AGENTS.md): engineering ownership, invariants and validation guidance.
