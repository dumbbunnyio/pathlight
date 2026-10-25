import { Plugin } from "@opencode/plugin/tui";
import { Effect } from "effect";
import { run } from "../../src/process";

// The OpenCode counterpart of Claude's `/pathlight:open`: typed by the user, so no model turn. It runs in the terminal process, which is the one
// place that knows the real tmux pane, so the viewer is split beside this conversation and follows the newest recorded session.
export default Plugin.define({
  id: "pathlight",
  setup(context) {
    const open = async (view: string | undefined) => {
      const pane = process.env.TMUX_PANE;
      if (!pane) { context.ui.toast.show({ message: "Pathlight needs OpenCode to run inside tmux", variant: "warning" }); return; }
      const directory = context.location?.directory ?? context.data.location.default().directory;
      const socket = process.env.TMUX?.split(",")[0];
      // Bound to this conversation from the start (not "the newest session", which before its first tool call is nothing or a stale one).
      const route = context.ui.router.current();
      const bind = route.type === "session" ? ["--session", route.sessionID, "--source", "opencode"] : [];
      const args = ["open", ...(view ? [view] : []), "--workspace", directory, "--split", "--pane", pane, ...(socket ? ["--socket", socket] : []), ...bind];
      try {
        await Effect.runPromise(run("pathlight", args));
        context.ui.toast.show({ message: "Pathlight opened beside this conversation", variant: "success" });
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n").find(line => line.trim() && !line.startsWith("Command failed")) ?? error.message : String(error);
        context.ui.toast.show({ message: `Pathlight: ${message}`, variant: "error" });
      }
    };
    // The counterpart of Claude's `/pathlight`: asks the agent to use the pathlight skill. Only the terminal process knows the real tmux pane, so it is
    // handed over here, and the skill passes it to `pathlight show --pane` (OpenCode's background service may not share this terminal's environment).
    const ask = async (view: string | undefined) => {
      const pane = process.env.TMUX_PANE, socket = process.env.TMUX?.split(",")[0];
      const route = context.ui.router.current();
      try {
        const directory = context.location?.directory ?? context.data.location.default().directory;
        const sessionID = route.type === "session" ? route.sessionID : (await context.client.session.create({ location: { directory } })).id;
        if (route.type !== "session") context.ui.router.navigate({ type: "session", sessionID });
        const where = pane ? ` The user's tmux pane is ${pane}${socket ? ` on the tmux server with socket ${socket}` : ""}; pass it as --pane${socket ? " and --socket" : ""}.` : "";
        await context.client.session.prompt({ sessionID, text: `Use the pathlight skill${view ? ` to show the "${view}" view` : " to show the architecture"}.${where}` });
      } catch (error) {
        context.ui.toast.show({ message: `Pathlight: ${error instanceof Error ? error.message : String(error)}`, variant: "error" });
      }
    };
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "pathlight.ask", title: "Ask the agent to show the architecture", group: "Pathlight", palette: true,
        slash: { name: "pathlight", arguments: true },
        run: (input?: string) => ask(input?.trim() || undefined),
      }, {
        id: "pathlight.open", title: "Open the Pathlight viewer", group: "Pathlight", palette: true,
        slash: { name: "pathlight-open", aliases: ["pathlight:open"], arguments: true },
        run: (input?: string) => open(input?.trim() || undefined),
      }],
    }));
  },
});
