/**
 * pi-sub-agent — Spawn persistent nested agents with isolated context.
 *
 * Registered tools:
 *   spawn_agent(agent_id, system_prompt?, tools?, from_definition?)
 *   prompt_agent(agent_id, prompt)
 *   list_agents
 *   destroy_agent(agent_id)
 *
 * Environment variables (set by pi-sandbox):
 *   PI_SUB_AGENT_MODEL       — Model for sub-agents (default: same as supervisor)
 *   PI_SUB_AGENT_TURN_LIMIT  — Max sub-agent turns per supervisor response (default: 30, -1 = unlimited)
 */

import type {
	AgentSession,
	ExtensionAPI,
	Model,
} from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------
const SUB_AGENT_MODEL = process.env.PI_SUB_AGENT_MODEL || "";
const TURN_LIMIT = (() => {
	const raw = process.env.PI_SUB_AGENT_TURN_LIMIT || "30";
	const n = parseInt(raw, 10);
	return Number.isFinite(n) ? n : 30;
})();
const isUnlimited = TURN_LIMIT === -1;

// ---------------------------------------------------------------------------
// Per-supervisor-turn global budget
// ---------------------------------------------------------------------------
let globalTurnCounter = 0;

function budgetRemaining(): number {
	if (isUnlimited) return Infinity;
	return Math.max(0, TURN_LIMIT - globalTurnCounter);
}

function budgetExhausted(): boolean {
	if (isUnlimited) return false;
	return globalTurnCounter >= TURN_LIMIT;
}

// ---------------------------------------------------------------------------
// Sub-agent session store
// ---------------------------------------------------------------------------
interface ManagedAgent {
	session: AgentSession;
	createdAt: number;
	totalTurns: number;
	modelId: string | undefined;
}

const agents = new Map<string, ManagedAgent>();

// ---------------------------------------------------------------------------
// Resolve model from env or fall back to supervisor's model
// ---------------------------------------------------------------------------
function resolveModel(
	modelRegistry: { find: (provider: string, id: string) => Model | undefined },
	supervisorModel: Model | undefined,
): Model | undefined {
	if (!SUB_AGENT_MODEL) {
		// No env override — use supervisor's model
		return supervisorModel;
	}

	// Try provider/id format first
	if (SUB_AGENT_MODEL.includes("/")) {
		const [provider, ...rest] = SUB_AGENT_MODEL.split("/");
		const id = rest.join("/");
		const m = modelRegistry.find(provider, id);
		if (m) return m;
	}

	// Try as a model ID across all providers
	const available = modelRegistry.getAvailable?.();
	if (available) {
		for (const m of available) {
			if (m.id === SUB_AGENT_MODEL || m.name === SUB_AGENT_MODEL) return m;
		}
	}

	return supervisorModel;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
	// Reset global turn budget when the user sends a new message (not between supervisor tool calls)
	pi.on("input", (event) => {
		if (event.source === "interactive" || event.source === "rpc") {
			// debug: console.error("[pi-sub-agent] input from user, resetting budget (was " + globalTurnCounter + ")");
			globalTurnCounter = 0;
		}
	});
	// -----------------------------------------------------------------------
	// spawn_agent
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description: [
			"Create a new sub-agent session with an isolated context window.",
			"The sub-agent persists across prompt_agent calls — its conversation history accumulates.",
			"The model is determined by sandbox configuration, not by the supervisor.",
			"Use destroy_agent to clean up when done.",
		].join(" "),
		promptSnippet: "Spawn a persistent sub-agent for delegated work",
		promptGuidelines: [
			"Use spawn_agent to create a sub-agent for focused, isolated work.",
			"The sub-agent retains context across multiple prompt_agent calls.",
			"Do not use spawn_agent to bypass the turn budget — each prompt_agent call counts toward the same per-response limit.",
		],
		parameters: Type.Object({
			agent_id: Type.String({
				description: "Unique identifier for this sub-agent. Use the same ID in prompt_agent calls.",
			}),
			system_prompt: Type.Optional(
				Type.String({
					description: "System prompt for the sub-agent. If omitted, uses a default assistant prompt.",
				}),
			),
			tools: Type.Optional(
				Type.Array(
					Type.String({
						description: "Tool names to grant the sub-agent (e.g. read, bash, grep, find, ls, write, edit).",
					}),
					{
						description: "Tools the sub-agent can use. Default: read, bash, grep, find, ls.",
					},
				),
			),
			from_definition: Type.Optional(
				Type.String({
					description:
						"Name of a predefined agent definition from ~/.pi/agent/agents/ or .pi/agents/. Overrides system_prompt and tools if specified.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Check global budget
			if (budgetExhausted()) {
				return {
					content: [
						{
							type: "text",
							text: `[Sub-agent budget exhausted: ${TURN_LIMIT} prompt_agent calls used. Cannot spawn new agent. Return to the user for further instructions.]`,
						},
					],
					details: {},
					isError: true,
				};
			}

			if (agents.has(params.agent_id)) {
				return {
					content: [
						{
							type: "text",
							text: `Agent '${params.agent_id}' already exists. Use a different agent_id or destroy_agent first.`,
						},
					],
					details: {},
					isError: true,
				};
			}

			// Resolve tools — filter out sub-agent tools to prevent recursive spawning
			const forbiddenTools = new Set([
				"spawn_agent",
				"prompt_agent",
				"list_agents",
				"destroy_agent",
			]);
			const requestedTools = params.tools ?? ["read", "bash", "grep", "find", "ls"];
			const allowedTools = requestedTools.filter((t) => !forbiddenTools.has(t));

			// Resolve model
			const model = resolveModel(ctx.modelRegistry, ctx.model);

			// Create the sub-agent session with optional system prompt
			const systemPrompt = params.system_prompt || "";

			// Use DefaultResourceLoader with all discovery disabled
			// and only the system prompt set
			const resourceLoader = systemPrompt
				? new DefaultResourceLoader({
						cwd: ctx.cwd,
						agentDir: ctx.cwd,
						systemPrompt,
						noExtensions: true,
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
					})
				: undefined;
			if (resourceLoader) await resourceLoader.reload();

			const { session } = await createAgentSession({
				sessionManager: SessionManager.inMemory(),
				authStorage: ctx.modelRegistry.authStorage,
				modelRegistry: ctx.modelRegistry,
				model,
				tools: allowedTools,
				resourceLoader,
			});

			const managed: ManagedAgent = {
				session,
				createdAt: Date.now(),
				totalTurns: 0,
				modelId: model ? `${model.provider}/${model.id}` : undefined,
			};
			agents.set(params.agent_id, managed);

			const toolList = allowedTools.length > 0 ? allowedTools.join(", ") : "(none)";
			const modelInfo = managed.modelId ? `, model: ${managed.modelId}` : ", model: (same as supervisor)";
			return {
				content: [
					{
						type: "text",
						text: [
							`Agent '${params.agent_id}' spawned.`,
							`Tools: ${toolList}${modelInfo}`,
							`Budget remaining: ${budgetRemaining()} prompt_agent call(s).`,
							systemPrompt ? `System prompt: ${systemPrompt.slice(0, 200)}` : "",
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: {
					agent_id: params.agent_id,
					tools: allowedTools,
					model: managed.modelId,
					budget_remaining: budgetRemaining(),
				},
			};
		},
	});

	// -----------------------------------------------------------------------
	// prompt_agent
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "prompt_agent",
		label: "Prompt Agent",
		description: [
			"Send a prompt to an existing sub-agent and wait for its response.",
			"The sub-agent's conversation history is preserved across calls.",
			"Streams output to the user in real-time for observation.",
			"Returns the sub-agent's final response. Intermediate thinking is not included in the supervisor's context.",
		].join(" "),
		promptSnippet: "Prompt a sub-agent and wait for its response",
		promptGuidelines: [
			"Use prompt_agent to delegate work to a sub-agent. The sub-agent's intermediate tool calls and thinking are not added to your context.",
			"Each prompt_agent call counts as 1 toward the per-response budget. What the sub-agent does internally does not affect the budget.",
			"When the budget is exhausted, return to the user for further instructions.",
		],
		parameters: Type.Object({
			agent_id: Type.String({
				description: "ID of the sub-agent to prompt (must have been created via spawn_agent).",
			}),
			prompt: Type.String({
				description: "The prompt to send to the sub-agent.",
			}),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Check global budget
			if (budgetExhausted()) {
				return {
					content: [
						{
							type: "text",
							text: `[Sub-agent budget exhausted: ${TURN_LIMIT} prompt_agent calls used. Cannot prompt sub-agent. Return to the user for further instructions.]`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const managed = agents.get(params.agent_id);
			if (!managed) {
				return {
					content: [
						{
							type: "text",
							text: `Agent '${params.agent_id}' not found. Use spawn_agent first.`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const { session } = managed;
			let accumulatedText = "";

			// Each prompt_agent call by the supervisor counts as 1 turn against the budget.
			// What the sub-agent does internally (its own turns) does not affect the budget.
			globalTurnCounter++;
			managed.totalTurns++;

			if (globalTurnCounter > TURN_LIMIT) {
				globalTurnCounter--; // undo the increment
				managed.totalTurns--;
				return {
					content: [
						{
							type: "text",
							text: `[Sub-agent budget exhausted: ${TURN_LIMIT} prompt_agent calls used. Cannot prompt sub-agent. Return to the user for further instructions.]`,
						},
					],
					details: {
						agent_id: params.agent_id,
						turns_total: managed.totalTurns,
						budget_remaining: 0,
					},
					isError: true,
				};
			}

			// Track sub-agent events for observability
			const toolCalls: Array<{ name: string; args: any; result?: string }> = [];

			// Subscribe to sub-agent events for streaming
			const unsubscribe = session.subscribe((event) => {
				// Accumulate text deltas for the final return value
				if (
					event.type === "message_update" &&
					event.assistantMessageEvent.type === "text_delta"
				) {
					accumulatedText += event.assistantMessageEvent.delta;
				}

				// Stream tool calls as they happen
				if (event.type === "tool_execution_start") {
					toolCalls.push({ name: event.toolName, args: event.args });
					onUpdate({
						content: [{ type: "text", text: "\u21d2 " + event.toolName + " " + JSON.stringify(event.args) }],
						details: { tool_calls: [...toolCalls] },
					});
				}

				// Stream tool results
				if (event.type === "tool_execution_end") {
					const last = toolCalls[toolCalls.length - 1];
					if (last) {
						const resultText = event.result?.content
							?.filter((c: any) => c.type === "text")
							.map((c: any) => c.text)
							.join("\n") || "";
						last.result = resultText.slice(0, 200);
					}
					onUpdate({
						content: [{ type: "text", text: "\u21d2 " + event.toolName + " done" }],
						details: { tool_calls: [...toolCalls] },
					});
				}

				// Update display on complete assistant messages
				if (event.type === "message_end" && event.message.role === "assistant") {
					const text = event.message.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("\n") || "(generating...)";
					onUpdate({
						content: [{ type: "text", text }],
						details: { tool_calls: [...toolCalls] },
					});
				}
			});

			// Connect supervisor's abort signal (Escape key) to the sub-agent
			let userAborted = false;
			const abortListener = () => {
				userAborted = true;
				session.abort();
			};
			if (signal && !signal.aborted) {
				signal.addEventListener("abort", abortListener, { once: true });
			} else if (signal?.aborted) {
				userAborted = true;
				session.abort();
			}

			try {
				await session.prompt(params.prompt);
			} catch {
				// session.prompt() may throw or resolve on abort — handled by userAborted flag below
			} finally {
				unsubscribe();
				if (signal && !signal.aborted) {
					signal.removeEventListener("abort", abortListener);
				}
			}

			if (userAborted) {
				return {
					content: [
						{
							type: "text",
							text: `[Sub-agent '${params.agent_id}' aborted by user.]
${accumulatedText || "(no output yet)"}`,
						},
					],
					details: {
						agent_id: params.agent_id,
						turns_total: managed.totalTurns,
						budget_remaining: budgetRemaining(),
						aborted: true,
						tool_calls: toolCalls,
					},
				};
			}

			// Get the final assistant message content
			const lastAssistantMsg = session.messages
				.filter((m) => m.role === "assistant")
				.pop();
			const finalText =
				lastAssistantMsg?.content?.[0]?.type === "text"
					? lastAssistantMsg.content[0].text
					: accumulatedText || "(no text response)";

			return {
				content: [{ type: "text", text: finalText }],
				details: {
					agent_id: params.agent_id,
					turns_total: managed.totalTurns,
					budget_remaining: budgetRemaining(),
					tool_calls: toolCalls,
				},
			};
		},

		renderCall(args, theme, _context) {
			const preview = args.prompt
				? args.prompt.length > 60
					? args.prompt.slice(0, 60) + "..."
					: args.prompt
				: "...";
			return new Text(
				theme.fg("toolTitle", theme.bold("prompt_agent ")) +
					theme.fg("accent", args.agent_id) +
					theme.fg("dim", " " + preview),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as any;
			const tc = details?.tool_calls as Array<{ name: string; args: any; result?: string }> | undefined;
			const isAborted = details?.aborted;
			const icon = isAborted
				? theme.fg("warning", "\u26a0")
				: theme.fg("success", "\u2713");

			let text = icon + " " + theme.fg("toolTitle", theme.bold("prompt_agent ")) + theme.fg("accent", details?.agent_id || "?");

			if (tc && tc.length > 0) {
				const toShow = expanded ? tc : tc.slice(-5);
				const skipped = tc.length - toShow.length;
				if (skipped > 0) text += "\n" + theme.fg("muted", "... " + skipped + " earlier tool call(s)");
				for (const t of toShow) {
					const argsStr = JSON.stringify(t.args);
					const preview = argsStr.length > 50 ? argsStr.slice(0, 50) + "..." : argsStr;
					text += "\n  " + theme.fg("muted", "\u2192 ") + theme.fg("accent", t.name) + theme.fg("dim", " " + preview);
					if (expanded && t.result) {
						text += "\n" + theme.fg("toolOutput", "     " + t.result.slice(0, 300).split("\n").join("\n     "));
					}
				}
			}

			// Show final output
			const output = result.content[0];
			if (output?.type === "text" && output.text) {
				text += "\n" + theme.fg("toolOutput", output.text.slice(0, expanded ? undefined : 200));
				if (!expanded && output.text.length > 200) text += "\n" + theme.fg("muted", "(Ctrl+O to expand)");
			}

			// Show usage stats
			const stats: string[] = [];
			if (details?.turns_total) stats.push(details.turns_total + " call(s)");
			if (details?.budget_remaining !== undefined) stats.push(details.budget_remaining + " remaining");
			if (stats.length > 0) text += "\n" + theme.fg("dim", stats.join(" | "));

			return new Text(text, 0, 0);
		},
	});

	// -----------------------------------------------------------------------
	// list_agents
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description: "List all active sub-agent sessions with their turn counts and model info.",
		parameters: Type.Object({}),
		promptSnippet: "List active sub-agents",
		async execute() {
			if (agents.size === 0) {
				return {
					content: [{ type: "text", text: "No active sub-agents." }],
					details: { agents: [], budget_remaining: budgetRemaining() },
				};
			}

			const lines: string[] = [
				`Active sub-agents (budget: ${budgetRemaining()}/${isUnlimited ? "∞" : TURN_LIMIT} turns remaining):`,
			];
			for (const [id, managed] of agents) {
				const age = Math.round((Date.now() - managed.createdAt) / 1000);
				const modelInfo = managed.modelId ? `, model: ${managed.modelId}` : "";
				lines.push(
					`  - ${id}: ${managed.totalTurns} prompt_agent call(s), ${age}s old${modelInfo}`,
				);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					agents: Array.from(agents.keys()),
					budget_remaining: budgetRemaining(),
				},
			};
		},
	});

	// -----------------------------------------------------------------------
	// destroy_agent
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "destroy_agent",
		label: "Destroy Agent",
		description: "Destroy a sub-agent session and free its resources.",
		parameters: Type.Object({
			agent_id: Type.String({
				description: "ID of the sub-agent to destroy.",
			}),
		}),
		promptSnippet: "Destroy a sub-agent",
		async execute(_toolCallId, params) {
			const managed = agents.get(params.agent_id);
			if (!managed) {
				return {
					content: [
						{
							type: "text",
							text: `Agent '${params.agent_id}' not found.`,
						},
					],
					details: {},
					isError: true,
				};
			}

			managed.session.dispose();
			agents.delete(params.agent_id);

			return {
				content: [
					{
						type: "text",
						text: `Agent '${params.agent_id}' destroyed (${managed.totalTurns} turns used).`,
					},
				],
				details: {
					agent_id: params.agent_id,
					turns_used: managed.totalTurns,
				},
			};
		},
	});
}
