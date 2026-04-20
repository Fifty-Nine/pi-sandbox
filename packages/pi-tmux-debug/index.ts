/**
 * Tmux Debug Tool Extension for pi-coding-agent
 *
 * Provides a `tmux` tool that lets the agent interact with a tmux session
 * by capturing pane output and sending keystrokes. Designed for debugging
 * scenarios where the agent's only access to the target system is through
 * a tmux session socket.
 *
 * The tmux socket path is read from the TMUX_SOCKET_PATH environment variable,
 * which is set by the sandbox launch script when using the --tmux flag.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

const TMUX_EXEC_TIMEOUT = 10_000;
const TMUX_SEND_TIMEOUT = 5_000;

export default function (pi: ExtensionAPI) {
	/**
	 * Build the base tmux arguments for socket targeting.
	 * If TMUX_SOCKET_PATH is set, use -S to connect to that socket.
	 * Otherwise, fall back to default tmux behavior (TMUX env var or default socket).
	 */
	function getTmuxBaseArgs(): string[] {
		const socketPath = process.env.TMUX_SOCKET_PATH;
		if (socketPath) {
			return ["-S", socketPath];
		}
		return [];
	}

	/**
	 * Build target arguments (-t <target>) if a target is specified.
	 */
	function buildTargetArgs(target?: string): string[] {
		if (target) {
			return ["-t", target];
		}
		return [];
	}

	/**
	 * Execute a tmux command and return the result.
	 */
	async function tmuxExec(
		args: string[],
		options: { signal?: AbortSignal; timeout?: number } = {},
	) {
		const baseArgs = getTmuxBaseArgs();
		return pi.exec("tmux", [...baseArgs, ...args], {
			signal: options.signal,
			timeout: options.timeout ?? TMUX_EXEC_TIMEOUT,
		});
	}

	/**
	 * Format a tmux exec result as a tool result, handling errors.
	 */
	function handleResult(
		result: { stdout: string; stderr: string; code: number; killed: boolean },
		action: string,
		details: Record<string, unknown>,
	) {
		if (result.killed) {
			return {
				content: [{ type: "text" as const, text: "Tmux command timed out or was cancelled" }],
				isError: true,
				details: { ...details, action, killed: true },
			};
		}

		if (result.code !== 0) {
			const errorText = result.stderr.trim() || `tmux exited with code ${result.code}`;
			return {
				content: [{ type: "text" as const, text: `Error: ${errorText}` }],
				isError: true,
				details: { ...details, action, exitCode: result.code },
			};
		}

		return null; // No error
	}

	pi.registerTool({
		name: "tmux",
		label: "Tmux",
		description: `Interact with a tmux session. Use this to debug issues in a tmux session by capturing pane output and sending keystrokes.

Actions:
- capture_pane: Capture the visible content (and optionally scrollback) of a tmux pane. This is how you "see" what's on the terminal.
- send_keys: Send keystrokes to a tmux pane. This is how you "type" commands or send control sequences.
- list_sessions: List all tmux sessions. Use this first to discover available sessions.
- list_windows: List windows in a tmux session.
- list_panes: List panes in a tmux window or session.

The 'target' parameter uses tmux's target format:
- "session_name" — target a session (e.g., "mysession")
- "session_name:window_index" — target a window (e.g., "mysession:0")
- "session_name:window_index.pane_index" — target a specific pane (e.g., "mysession:0.1")
- Omit to target the currently active pane

Common tmux key names for send_keys: Enter, Escape, Tab, Backspace, Up, Down, Left, Right, Home, End, PgUp, PgDn, C-c (Ctrl+C), C-d (Ctrl+D), C-z (Ctrl+Z), C-l (Ctrl+L to clear screen), F1–F12, Space.`,
		promptSnippet: "Interact with a tmux session via capture-pane, send-keys, and list commands",
		promptGuidelines: [
			"Always capture the pane first to understand the current state before sending keys.",
			"After sending keys, capture the pane again to observe the result.",
			"Use list_sessions first if you don't know the session name.",
			"Use send_keys with enter=true to run commands; use keys like 'C-c' for control sequences.",
			"Iterate: observe output → form hypothesis → test with command → observe result.",
		],
		parameters: Type.Object({
			action: StringEnum(
				["capture_pane", "send_keys", "list_sessions", "list_windows", "list_panes"] as const,
				{ description: "The tmux action to perform" },
			),
			target: Type.Optional(
				Type.String({
					description:
						"Target pane/session/window using tmux target format (e.g., 'mysession', 'mysession:0', 'mysession:0.1'). Omit for the currently active pane.",
				}),
			),
			keys: Type.Optional(
				Type.String({
					description:
						"Keys to send (for send_keys action). Supports literal text and tmux key names: 'C-c' (Ctrl+C), 'C-d' (Ctrl+D), 'C-z' (Ctrl+Z), 'Enter', 'Up', 'Down', 'Escape', etc.",
				}),
			),
			enter: Type.Optional(
				Type.Boolean({
					description: "Whether to press Enter after sending keys (for send_keys action). Default: false.",
				}),
			),
			scrollback: Type.Optional(
				Type.Number({
					description:
						"Number of lines of scrollback history to include (for capture_pane action). Default: 0 (visible content only). Use larger values to see output that has scrolled off-screen.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const { action, target, keys, enter, scrollback } = params;
			const targetArgs = buildTargetArgs(target);
			const baseDetails: Record<string, unknown> = { target };

			try {
				switch (action) {
					case "capture_pane": {
						const args = ["capture-pane", "-p", ...targetArgs];
						if (scrollback && scrollback > 0) {
							args.push("-S", `-${scrollback}`);
						}

						const result = await tmuxExec(args, { signal });
						const error = handleResult(result, action, { ...baseDetails, scrollback });
						if (error) return error;

						// Trim trailing blank lines for cleaner output
						const output = result.stdout.replace(/\n+$/, "");
						return {
							content: [{ type: "text", text: output || "(empty pane)" }],
							details: { ...baseDetails, action, scrollback },
						};
					}

					case "send_keys": {
						if (!keys) {
							return {
								content: [{ type: "text", text: "Error: 'keys' parameter is required for send_keys action" }],
								isError: true,
								details: { ...baseDetails, action },
							};
						}

						const args = ["send-keys", ...targetArgs, keys];
						if (enter) {
							args.push("Enter");
						}

						const result = await tmuxExec(args, { signal, timeout: TMUX_SEND_TIMEOUT });
						const error = handleResult(result, action, { ...baseDetails, keys, enter });
						if (error) return error;

						const sentDescription = enter ? `${keys} + Enter` : keys;
						return {
							content: [{ type: "text", text: `Keys sent: ${sentDescription}` }],
							details: { ...baseDetails, action, keys, enter },
						};
					}

					case "list_sessions": {
						const result = await tmuxExec(["list-sessions"], { signal });
						const error = handleResult(result, action, baseDetails);
						if (error) return error;

						return {
							content: [{ type: "text", text: result.stdout.trim() || "No tmux sessions found" }],
							details: { action },
						};
					}

					case "list_windows": {
						const args = ["list-windows", ...targetArgs];
						const result = await tmuxExec(args, { signal });
						const error = handleResult(result, action, baseDetails);
						if (error) return error;

						return {
							content: [{ type: "text", text: result.stdout.trim() || "No windows found" }],
							details: { ...baseDetails, action },
						};
					}

					case "list_panes": {
						const args = ["list-panes", ...targetArgs];
						const result = await tmuxExec(args, { signal });
						const error = handleResult(result, action, baseDetails);
						if (error) return error;

						return {
							content: [{ type: "text", text: result.stdout.trim() || "No panes found" }],
							details: { ...baseDetails, action },
						};
					}

					default:
						return {
							content: [{ type: "text", text: `Unknown action: ${action}` }],
							isError: true,
						};
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Tmux error: ${message}` }],
					isError: true,
					details: { ...baseDetails, action, error: message },
				};
			}
		},
	});
}