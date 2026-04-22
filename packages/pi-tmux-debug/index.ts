/**
 * Tmux Debug Tool Extension for pi-coding-agent
 *
 * Provides a `tmux` tool that lets the agent interact with a tmux session
 * by capturing pane output and sending keystrokes. Supports two modes:
 *
 * 1. Local mode (default): interacts with a local tmux session via its socket.
 *    The socket path is read from TMUX_SOCKET_PATH, set by --tmux flag.
 *
 * 2. SSH mode: proxies all tmux commands over SSH to a remote host.
 *    Enabled by setting TMUX_SSH_HOST. Uses the remote host's default
 *    tmux socket (as if the user SSH'd in and ran `tmux a`).
 *    SSH connections use ControlMaster=auto for self-healing multiplexing.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

const TMUX_EXEC_TIMEOUT = 10_000;
const TMUX_SEND_TIMEOUT = 5_000;
const WAIT_POLL_INTERVAL_MS = 500;
const WAIT_STABLE_POLLS = 2; // Need 2 consecutive identical captures (1s of stability)
const WAIT_DEFAULT_TIMEOUT_S = 30;

// SSH ControlMaster options for self-healing connection multiplexing
// Control socket goes in /tmp (not ~/.ssh, which is read-only when mounted via --ssh)
const SSH_CONTROL_PATH = "/tmp/ssh-ctrl-%h";
const SSH_OPTIONS = [
	"-o", "ControlMaster=auto",
	"-o", `ControlPath=${SSH_CONTROL_PATH}`,
	"-o", "ControlPersist=10m",
	"-o", "ServerAliveInterval=15",
	"-o", "ServerAliveCountMax=4",
] as const;

// Patterns that indicate SSH connection errors (vs tmux errors)
const SSH_ERROR_PATTERNS = [
	"Connection refused",
	"Connection timed out",
	"Connection reset",
	"Connection reset by peer",
	"Host key verification failed",
	"Permission denied",
	"No route to host",
	"Network is unreachable",
	"Broken pipe",
	"control socket",
] as const;

export default function (pi: ExtensionAPI) {
	/**
	 * Whether we're operating in SSH mode (proxy tmux commands over SSH).
	 */
	function isSshMode(): boolean {
		return !!process.env.TMUX_SSH_HOST;
	}

	/**
	 * Build the base tmux arguments for local socket targeting.
	 * If TMUX_SOCKET_PATH is set, use -S to connect to that socket.
	 * Otherwise, fall back to default tmux behavior (TMUX env var or default socket).
	 * Not used in SSH mode — remote host uses its default socket.
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
	 *
	 * In SSH mode, the tmux arguments are joined with null bytes, base64-encoded,
	 * and sent over SSH. On the remote side, the base64 is decoded and
	 * `xargs -0` reconstructs the argument boundaries for `tmux`. This avoids
	 * all shell interpretation issues (spaces, parens, backslashes, $, etc.)
	 * since base64 output contains only safe shell characters [A-Za-z0-9+/=].
	 *
	 * In local mode, runs `tmux [-S <socket>] <args>` directly via spawn,
	 * which preserves argument boundaries natively.
	 */
	async function tmuxExec(
		args: string[],
		options: { signal?: AbortSignal; timeout?: number } = {},
	) {
		const sshHost = process.env.TMUX_SSH_HOST;

		if (sshHost) {
			// SSH mode: base64-encode null-separated args to bypass shell interpretation.
			//
			// Problem: SSH concatenates all arguments after the hostname into a single
			// string passed to the remote shell. The remote shell then word-splits and
			// interprets metacharacters, destroying argument boundaries at spaces and
			// consuming backslashes, parentheses, $, etc.
			//
			// Solution: Join args with null bytes, base64-encode, and decode on the
			// remote side. Base64 contains only [A-Za-z0-9+/=] — zero shell metacharacters.
			// `xargs -0` splits on null bytes, reconstructing exact argument boundaries.
			//
			// Remote pipeline: printf '%s' BASE64 | base64 -d | xargs -0 tmux
			const nullSeparated = args.join('\0');
			const b64 = Buffer.from(nullSeparated, 'utf-8').toString('base64');
			return pi.exec("ssh", [
				...SSH_OPTIONS, sshHost,
				"printf", "'%s'", b64,
				"|", "base64", "-d",
				"|", "xargs", "-0", "tmux",
			], {
				signal: options.signal,
				timeout: options.timeout ?? TMUX_EXEC_TIMEOUT,
			});
		} else {
			// Local mode: tmux [-S <socket>] <args...>
			const baseArgs = getTmuxBaseArgs();
			return pi.exec("tmux", [...baseArgs, ...args], {
				signal: options.signal,
				timeout: options.timeout ?? TMUX_EXEC_TIMEOUT,
			});
		}
	}

	/**
	 * Format a tmux exec result as a tool result, handling errors.
	 * Returns null if no error.
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
			const stderr = result.stderr.trim();
			const isSshError = isSshMode() && SSH_ERROR_PATTERNS.some(p => stderr.includes(p));
			const errorText = isSshError
				? `SSH error: ${stderr || `ssh exited with code ${result.code}`}`
				: (stderr || `tmux exited with code ${result.code}`);
			return {
				content: [{ type: "text" as const, text: `Error: ${errorText}` }],
				isError: true,
				details: { ...details, action, exitCode: result.code, isSshError: isSshError || undefined },
			};
		}

		return null;
	}

	/**
	 * Sleep for a given number of milliseconds, interrupted by AbortSignal.
	 * Returns true if the sleep completed, false if the signal was aborted.
	 */
	function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
		return new Promise((resolve) => {
			if (signal?.aborted) {
				resolve(false);
				return;
			}
			const timer = setTimeout(() => {
				resolve(true);
			}, ms);
			signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				resolve(false);
			}, { once: true });
		});
	}

	/**
	 * Wait for a pane's content to stabilize after sending a command.
	 * Polls capture-pane at intervals until the content is identical across
	 * consecutive polls (indicating the command has finished and the prompt
	 * has returned) or until the timeout is reached.
	 *
	 * Returns the stabilized pane content, or a timeout message with whatever
	 * was captured last.
	 */
	async function waitForCompletion(
		targetArgs: string[],
		timeoutS: number,
		signal: AbortSignal | undefined,
	): Promise<{ content: string; completed: boolean; timedOut: boolean }> {
		const timeoutMs = timeoutS * 1000;
		const startTime = Date.now();
		let lastContent: string | null = null;
		let stableCount = 0;

		while (Date.now() - startTime < timeoutMs) {
			const slept = await sleep(WAIT_POLL_INTERVAL_MS, signal);
			if (!slept) {
				// Aborted
				return { content: lastContent ?? "", completed: false, timedOut: false };
			}

			const captureResult = await tmuxExec(["capture-pane", "-p", ...targetArgs], { signal });
			if (captureResult.code !== 0) {
				// Retry on transient errors
				continue;
			}

			const currentContent = captureResult.stdout;

			if (currentContent === lastContent) {
				stableCount++;
				if (stableCount >= WAIT_STABLE_POLLS) {
					const trimmed = currentContent.replace(/\n+$/, "");
					return { content: trimmed || "(empty pane)", completed: true, timedOut: false };
				}
			} else {
				stableCount = 0;
				lastContent = currentContent;
			}
		}

		// Timeout — return whatever we last captured
		const trimmed = (lastContent ?? "").replace(/\n+$/, "");
		return { content: trimmed || "(empty pane)", completed: false, timedOut: true };
	}

	pi.registerTool({
		name: "tmux",
		label: "Tmux",
		description: `Interact with a tmux session. Use this to debug issues in a tmux session by capturing pane output and sending keystrokes.

Actions:
- capture_pane: Capture the visible content (and optionally scrollback) of a tmux pane. This is how you "see" what's on the terminal.
- send_keys: Send keystrokes to a tmux pane. This is how you "type" commands or send control sequences. Supports waiting for command completion.
- list_sessions: List all tmux sessions. Use this first to discover available sessions.
- list_windows: List windows in a tmux session.
- list_panes: List panes in a tmux window or session.

The 'target' parameter uses tmux's target format:
- "session_name" — target a session (e.g., "mysession")
- "session_name:window_index" — target a window (e.g., "mysession:0")
- "session_name:window_index.pane_index" — target a specific pane (e.g., "mysession:0.1")
- Omit to target the currently active pane

Common tmux key names for send_keys: Enter, Escape, Tab, Backspace, Up, Down, Left, Right, Home, End, PgUp, PgDn, C-c (Ctrl+C), C-d (Ctrl+D), C-z (Ctrl+Z), C-l (Ctrl+L to clear screen), F1–F12, Space.

When using send_keys with wait=true, the tool polls the pane content until it stabilizes
(consecutive captures are identical, indicating the command has finished and the prompt
has returned), then returns the captured output. This avoids the need for manual
capture_pane polling after every command. If the command doesn't complete within
wait_timeout seconds, the tool returns whatever was captured along with a timeout notice.`,
		promptSnippet: "Interact with a tmux session via capture-pane, send-keys, and list commands",
		promptGuidelines: [
			"Always capture the pane first to understand the current state before sending keys.",
			"After sending keys, capture the pane again to observe the result.",
			"Use list_sessions first if you don't know the session name.",
			"Use send_keys with enter=true to run commands; use keys like 'C-c' for control sequences.",
			"Iterate: observe output → form hypothesis → test with command → observe result.",
			"Use wait=true on send_keys to wait for a command to finish and get the output in one call.",
			"If a command times out while waiting, send C-c to interrupt it, then retry or adjust.",
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
			wait: Type.Optional(
				Type.Boolean({
					description:
						"Wait for command completion after sending keys (for send_keys action). Polls the pane until content stabilizes, then returns the output. Default: false (return immediately).",
				}),
			),
			wait_timeout: Type.Optional(
				Type.Number({
					description:
						"Maximum seconds to wait for command completion (for send_keys with wait=true). Default: 30. Ignored when wait is false or omitted.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const { action, target, keys, enter, scrollback, wait, wait_timeout } = params;
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

						// Without wait: return immediately
						if (!wait) {
							const sentDescription = enter ? `${keys} + Enter` : keys;
							return {
								content: [{ type: "text", text: `Keys sent: ${sentDescription}` }],
								details: { ...baseDetails, action, keys, enter },
							};
						}

						// With wait: poll until content stabilizes or timeout
						const timeoutS = wait_timeout ?? WAIT_DEFAULT_TIMEOUT_S;
						const waitResult = await waitForCompletion(targetArgs, timeoutS, signal);

						if (waitResult.completed) {
							return {
								content: [{ type: "text", text: waitResult.content }],
								details: {
									...baseDetails,
									action,
									keys,
									enter,
									wait: true,
									completed: true,
								},
							};
						}

						if (waitResult.timedOut) {
							return {
								content: [{
									type: "text",
									text: `Command may still be running (waited ${timeoutS}s). Current pane:\n\n${waitResult.content}`,
								}],
								details: {
									...baseDetails,
									action,
									keys,
									enter,
									wait: true,
									completed: false,
									timedOut: true,
								},
							};
						}

						// Aborted
						return {
							content: [{ type: "text", text: `Wait was cancelled. Last captured pane:\n\n${waitResult.content}` }],
							isError: true,
							details: { ...baseDetails, action, keys, enter, wait: true, completed: false, timedOut: false },
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