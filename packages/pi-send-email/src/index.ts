/**
 * Send Markdown Email Extension for pi-coding-agent
 *
 * Provides a `send_markdown_email` tool that converts a markdown document to
 * HTML via pandoc and sends it as an HTML email via SMTP with STARTTLS.
 *
 * SMTP credentials are read from pi's auth.json under the "smtp" key.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import nodemailer from "nodemailer";

const DEFAULT_TO = "tim.prince@gmail.com";

/**
 * Allowed recipient patterns:
 *   - tim.prince@gmail.com (exact)
 *   - *@trprince.com or *@*.trprince.com (any subdomain of trprince.com)
 */
const ALLOWED_RECIPIENTS = [
	/^tim\.prince@gmail\.com$/i,
	/^[^@]+@(?:.+\.)?trprince\.com$/i,
];

/**
 * Allowed sender patterns:
 *   - *@trprince.com or *@*.trprince.com (any subdomain of trprince.com)
 *   - gmail.com is NOT allowed for sending
 */
const ALLOWED_SENDERS = [
	/^[^@]+@(?:.+\.)?trprince\.com$/i,
];

function isAllowedRecipient(email: string): boolean {
	return ALLOWED_RECIPIENTS.some((re) => re.test(email));
}

function isAllowedSender(email: string): boolean {
	return ALLOWED_SENDERS.some((re) => re.test(email));
}

function validateRecipient(email: string, label: string): void {
	if (!isAllowedRecipient(email)) {
		throw new Error(
			`${label} "${email}" is not an allowed recipient. ` +
			`Only tim.prince@gmail.com and @trprince.com addresses are permitted.`,
		);
	}
}

function validateSender(email: string, label: string): void {
	if (!isAllowedSender(email)) {
		throw new Error(
			`${label} "${email}" is not an allowed sender. ` +
			`Only @trprince.com addresses are permitted for sending.`,
		);
	}
}

interface SmtpConfig {
	host: string;
	port?: number;
	username: string;
	password: string;
	from?: string;
}

/**
 * Read SMTP credentials from pi's auth.json.
 *
 * Search order:
 *   1. PI_CODING_AGENT_DIR/auth.json
 *   2. ~/.pi/agent/auth.json
 *   3. ~/.pi-sandbox/pi-agent/auth.json
 */
async function readSmtpConfig(): Promise<SmtpConfig> {
	const home = homedir();
	const candidates = [
		process.env.PI_CODING_AGENT_DIR
			? join(process.env.PI_CODING_AGENT_DIR, "auth.json")
			: null,
		join(home, ".pi", "agent", "auth.json"),
		join(home, ".pi-sandbox", "pi-agent", "auth.json"),
	].filter(Boolean) as string[];

	for (const path of candidates) {
		try {
			const content = await readFile(path, "utf-8");
			const auth = JSON.parse(content);
			const smtp = auth?.smtp as SmtpConfig | undefined;
			if (smtp?.host && smtp?.username && smtp?.password !== undefined) {
				return smtp;
			}
		} catch {
			continue;
		}
	}

	throw new Error(
		"SMTP credentials not found in auth.json.\n" +
		"Add an 'smtp' entry with 'host', 'port', 'username', 'password':\n" +
		'  "smtp": {\n' +
		'    "host": "mail.home.trprince.com",\n' +
		'    "port": 587,\n' +
		'    "username": "you@example.com",\n' +
		'    "password": "your-password"\n' +
		"  }",
	);
}

/**
 * Convert a markdown file to HTML using pandoc.
 */
async function markdownToHtml(
	filePath: string,
	pi: ExtensionAPI,
	signal?: AbortSignal,
): Promise<string> {
	const result = await pi.exec("pandoc", [
		"-f", "markdown",
		"-t", "html",
		"--standalone",
		filePath,
	], { signal, timeout: 30_000 });

	if (result.code !== 0) {
		throw new Error(`pandoc failed (exit ${result.code}): ${result.stderr.trim() || "(no stderr)"}`);
	}

	return result.stdout;
}

/**
 * Extract plain text from a markdown file using pandoc.
 */
async function markdownToPlain(
	filePath: string,
	pi: ExtensionAPI,
	signal?: AbortSignal,
): Promise<string> {
	const result = await pi.exec("pandoc", [
		"-f", "markdown",
		"-t", "plain",
		filePath,
	], { signal, timeout: 30_000 });

	if (result.code !== 0) {
		// Fallback: read the file as-is
		return readFile(filePath, "utf-8");
	}

	return result.stdout;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "send_markdown_email",
		label: "Send Markdown Email",
		description: `Send a markdown document as an HTML email via SMTP with TLS.

Reads SMTP credentials from pi's auth.json (under the "smtp" key).
Uses pandoc to convert the markdown file to HTML.

Recipient is restricted to tim.prince@gmail.com or @trprince.com addresses.
Defaults to tim.prince@gmail.com if not specified.

Usage:
  - Provide the subject and path to the markdown file
  - Optionally specify a recipient (--to), CC (--cc), or custom From address (--from)
  - The SMTP relay must be configured in auth.json under the "smtp" key`,
		promptSnippet: "Send a markdown document as an HTML email via SMTP",
		promptGuidelines: [
			"Use send_markdown_email to send markdown documents as formatted HTML emails.",
			"SMTP credentials must be configured in auth.json under the 'smtp' key.",
			"The markdown file is converted to HTML using pandoc before sending.",
			"Recipient defaults to tim.prince@gmail.com; only @trprince.com addresses are allowed.",
		],
		parameters: Type.Object({
			to: Type.Optional(Type.String({
				description: "Recipient email address (default: tim.prince@gmail.com)",
			})),
			subject: Type.String({
				description: "Email subject line",
			}),
			file: Type.String({
				description: "Path to the markdown file to send",
			}),
			cc: Type.Optional(Type.String({
				description: "CC recipient email address (must be @trprince.com)",
			})),
			from: Type.Optional(Type.String({
				description: "From email address (defaults to smtp.from in auth.json, then SMTP username). Must be @trprince.com.",
			})),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const { subject, file, cc, from: fromParam } = params;
			const to = params.to ?? DEFAULT_TO;

			// Read SMTP config (needed for default from address)
			const smtp = await readSmtpConfig();

			// Resolve effective from address
			const fromAddr = fromParam ?? smtp.from ?? smtp.username;

			// Validate recipients
			validateRecipient(to, "Recipient");
			if (cc) {
				validateRecipient(cc, "CC recipient");
			}
			validateSender(fromAddr, "From address");

			// Convert markdown to HTML
			const htmlBody = await markdownToHtml(file, pi, signal);

			// Extract plain text version
			const plainBody = await markdownToPlain(file, pi, signal);

			// Build Nodemailer transport
			const transporter = nodemailer.createTransport({
				host: smtp.host,
				port: smtp.port ?? 587,
				secure: (smtp.port ?? 587) === 465, // true for SMTPS (465), false for STARTTLS (587)
				auth: {
					user: smtp.username,
					pass: smtp.password,
				},
			});

			// Build mail options
			const mailOptions: nodemailer.SendMailOptions = {
				from: fromAddr,
				to,
				subject,
				text: plainBody,
				html: htmlBody,
			};

			if (cc) {
				mailOptions.cc = cc;
			}

			// Send
			try {
				const info = await transporter.sendMail(mailOptions);
				return {
					content: [{ type: "text", text: `Email sent to ${to} (messageId: ${info.messageId})` }],
					details: {
						to,
						subject,
						cc: cc ?? null,
						messageId: info.messageId,
						host: smtp.host,
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (message.includes("auth") || message.includes("credentials")) {
					throw new Error(`SMTP authentication failed. Check username/password in auth.json: ${message}`);
				}
				if (message.includes("connect") || message.includes("ENOTFOUND") || message.includes("ECONNREFUSED")) {
					throw new Error(`Could not connect to SMTP relay at ${smtp.host}:${smtp.port ?? 587}: ${message}`);
				}
				throw new Error(`Failed to send email: ${message}`);
			}
		},
	});
}
