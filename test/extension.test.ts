import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import rewindExtension from "../extensions/rewind.ts";
import { REWIND_ENTRY_TYPE, type CheckpointRecord } from "../src/types.ts";

type Handler = (event: any, context: any) => Promise<any> | any;

class MockPi {
	readonly handlers = new Map<string, Handler[]>();
	readonly commands = new Map<string, { handler: Handler }>();
	readonly appended: CheckpointRecord[] = [];
	private readonly entries: SessionEntry[];

	constructor(entries: SessionEntry[]) {
		this.entries = entries;
	}

	on(event: string, handler: Handler): void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	}

	appendEntry(customType: string, data: unknown): void {
		if (customType !== REWIND_ENTRY_TYPE) return;
		this.appended.push(data as CheckpointRecord);
		const parentId = this.entries.at(-1)?.id ?? null;
		this.entries.push({
			type: "custom",
			id: `custom-${this.entries.length}`,
			parentId,
			timestamp: new Date().toISOString(),
			customType,
			data,
		} as SessionEntry);
	}

	registerCommand(name: string, options: { handler: Handler }): void {
		this.commands.set(name, options);
	}

	async emit(event: string, payload: unknown, context: unknown): Promise<any> {
		let result;
		for (const handler of this.handlers.get(event) ?? []) result = await handler(payload, context);
		return result;
	}
}

test("captures a new file before write and restores it during fork", async () => {
	const root = await mkdtemp(join(tmpdir(), "better-pi-rewind-extension-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(cwd, { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const userMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "create generated.txt" }],
			timestamp: Date.now(),
		};
		const userEntry = {
			type: "message",
			id: "user-entry",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: userMessage,
		} as SessionEntry;
		const entries = [userEntry];
		const mock = new MockPi(entries);
		rewindExtension(mock as unknown as ExtensionAPI);
		const notifications: string[] = [];
		const context = {
			cwd,
			hasUI: true,
			ui: {
				select: async () => "Restore 1 changed file",
				notify: (message: string) => notifications.push(message),
			},
			sessionManager: {
				getEntries: () => entries,
				getBranch: () => entries,
				getSessionId: () => "session-test",
			},
		};

		await mock.emit("session_start", { type: "session_start", reason: "startup" }, context);
		await mock.emit("message_end", { message: userMessage }, context);
		await mock.emit("message_start", { message: { role: "assistant", content: [] } }, context);
		assert.equal(mock.appended[0]?.kind, "snapshot");

		const filePath = join(cwd, "generated.txt");
		await mock.emit(
			"tool_call",
			{ type: "tool_call", toolName: "write", toolCallId: "tool-1", input: { path: "generated.txt", content: "hello" } },
			context,
		);
		assert.equal(mock.appended[1]?.kind, "update");
		assert.equal(mock.appended[1]?.files["generated.txt"]?.backupFileName, null);
		await writeFile(filePath, "hello\n");

		const forkResult = await mock.emit(
			"session_before_fork",
			{ type: "session_before_fork", entryId: "user-entry", position: "before" },
			context,
		);
		assert.equal(forkResult, undefined);
		await assert.rejects(stat(filePath), { code: "ENOENT" });
		assert.ok(notifications.some((message) => message.includes("1 file restored")));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
