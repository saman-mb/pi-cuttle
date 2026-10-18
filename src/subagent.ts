/**
 * Subagent detection helpers for pi-cuttle.
 *
 * `PI_SUBAGENT_CHILD=1` is set in the environment of background subagent child processes
 * (see pi-subagents src/runs/background/subagent-runner.js). The main agent runs without it.
 *
 * Caveat: foreground subagents run inside the parent Pi process and do not reload ambient
 * extensions, so they use the parent's policy. Background is the default for subagent work,
 * and the docs explicitly say agents needing ambient extensions must run as background children.
 */

/** Environment variable set by pi-subagents in child processes. */
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";

/** True when running inside a pi-subagents child process. */
export function isSubagent(): boolean {
	return process.env[SUBAGENT_CHILD_ENV] === "1";
}
