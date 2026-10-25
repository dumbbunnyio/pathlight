import { join } from "node:path";

/**
 * Where Pathlight keeps what it writes into a workspace: one folder, so nothing lands in the root of someone's repository. The model a draft makes,
 * its LikeC4 project config, the file mapping, the overlay of names and notes, and the state diagrams an agent writes all live here. Ignored,
 * regenerated state (journals, the out-of-date stamp) stays in `.cache/pathlight`.
 */
export const home = ".pathlight";
export const modelFile = "pathlight.model.c4";
export const mappingFile = "pathlight.activity.json";
export const overlayFile = "pathlight.overlay.json";
export const configFile = "likec4.config.json";

/** The folder in a workspace that holds Pathlight's files. */
export const homeOf = (workspace: string) => join(workspace, home);
/** The file mapping of a workspace. */
export const mappingPath = (workspace: string) => join(workspace, home, mappingFile);
/** The overlay of names and notes of a workspace. */
export const overlayPath = (workspace: string) => join(workspace, home, overlayFile);
