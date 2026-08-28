import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import rewindExtension from "../extensions/rewind.ts";
import { REWIND_ENTRY_TYPE, type CheckpointRecord } from "../src/types.ts";

type Handler = (event: any, context: any) => Promise<any> | any;

function git(cwd: string, ...args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", ["-C", cwd, ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(String(stderr).trim() || error.message));
				return;
			}
			resolve(String(stdout).trim());
		});
	});
}

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

test("turns double Escape into the rewind command", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "better-pi-rewind-shortcut-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const mock = new MockPi([]);
		rewindExtension(mock as unknown as ExtensionAPI);
		let terminalInputHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
		let editorText = "";
		let idle = true;
		const context = {
			cwd: "/tmp/project",
			mode: "tui",
			hasUI: true,
			isIdle: () => idle,
			isProjectTrusted: () => false,
			ui: {
				onTerminalInput: (handler: typeof terminalInputHandler) => {
					terminalInputHandler = handler;
					return () => {};
				},
				getEditorText: () => editorText,
				setEditorText: (text: string) => {
					editorText = text;
				},
				notify: () => {},
			},
			sessionManager: {
				getEntries: () => [],
				getBranch: () => [],
				getSessionId: () => "session-shortcut",
			},
		};

		await mock.emit("session_start", { type: "session_start", reason: "startup" }, context);
		assert.ok(terminalInputHandler);
		assert.equal(terminalInputHandler(""), undefined);
		assert.deepEqual(terminalInputHandler(""), { data: "\r" });
		assert.equal(editorText, "/rewind");

		idle = false;
		editorText = "";
		assert.equal(terminalInputHandler(""), undefined);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("resets descendant commits before restoring code and conversation", async () => {
	const root = await mkdtemp(join(tmpdir(), "better-pi-rewind-extension-git-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(cwd, { recursive: true });
	await git(cwd, "init", "--initial-branch=main");
	await git(cwd, "config", "user.name", "Rewind Test");
	await git(cwd, "config", "user.email", "rewind@example.test");
	const filePath = join(cwd, "example.txt");
	await writeFile(filePath, "committed base\n");
	await git(cwd, "add", "example.txt");
	await git(cwd, "commit", "-m", "initial");
	const checkpointHead = await git(cwd, "rev-parse", "HEAD");
	await writeFile(filePath, "before\n");

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const userMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "change and commit the file" }],
			timestamp: Date.now(),
		};
		const userEntry = {
			type: "message",
			id: "user-git",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: userMessage,
		} as SessionEntry;
		const entries = [userEntry];
		const mock = new MockPi(entries);
		rewindExtension(mock as unknown as ExtensionAPI);
		const notifications: string[] = [];
		const menuOptions: string[][] = [];
		let navigatedTo = "";
		let editorText = "";
		const theme = {
			bold: (text: string) => text,
			fg: (_color: string, text: string) => text,
		} as Theme;
		const context = {
			cwd,
			mode: "tui",
			hasUI: true,
			isIdle: () => true,
			isProjectTrusted: () => false,
			waitForIdle: async () => {},
			navigateTree: async (entryId: string) => {
				navigatedTo = entryId;
				return { cancelled: false };
			},
			ui: {
				onTerminalInput: () => () => {},
				getEditorText: () => editorText,
				setEditorText: (text: string) => {
					editorText = text;
				},
				notify: (message: string) => notifications.push(message),
				confirm: async () => true,
				select: async (_title: string, options: string[]) => {
					menuOptions.push(options);
					return options.find((option) => option.includes("and reset"));
				},
				custom: async (factory: (...args: any[]) => any) => {
					let selected: unknown;
					const component = factory({}, theme, {}, (value: unknown) => {
						selected = value;
					});
					component.handleInput("\u001b[A");
					component.handleInput("\r");
					return selected;
				},
			},
			sessionManager: {
				getEntries: () => entries,
				getBranch: () => entries,
				getSessionId: () => "session-git-reset",
			},
		};

		await mock.emit("session_start", { type: "session_start", reason: "startup" }, context);
		await mock.emit("message_end", { message: userMessage }, context);
		await mock.emit("message_start", { message: { role: "assistant", content: [] } }, context);
		await mock.emit(
			"tool_call",
			{ type: "tool_call", toolName: "edit", toolCallId: "tool-git-edit", input: { path: "example.txt" } },
			context,
		);
		await writeFile(filePath, "after\n");
		await git(cwd, "commit", "-am", "agent commit");

		await mock.commands.get("rewind")?.handler("", context);

		assert.equal(await git(cwd, "rev-parse", "HEAD"), checkpointHead);
		assert.equal(await readFile(filePath, "utf8"), "before\n");
		assert.equal(navigatedTo, "user-git");
		assert.equal(editorText, "change and commit the file");
		assert.ok(menuOptions.some((options) => options.includes("Restore code and conversation, and reset 1 commit")));
		assert.ok(notifications.includes("1 commit reset"));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("captures a new file before write and restores it during conversation branching", async () => {
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
			mode: "print",
			hasUI: true,
			isProjectTrusted: () => false,
			ui: {
				select: async (_title: string, options: string[]) => options[0],
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

		const notesPath = join(cwd, "notes.txt");
		await writeFile(notesPath, "before\n");
		await mock.emit(
			"tool_call",
			{
				type: "tool_call",
				toolName: "edit",
				toolCallId: "tool-omp-edit",
				input: { input: "[notes.txt#A1B2]\nPUT 1.=1:\n+after" },
			},
			context,
		);
		assert.equal(mock.appended[1]?.files["notes.txt"]?.backupFileName === null, false);
		await writeFile(notesPath, "after\n");

		const filePath = join(cwd, "generated.txt");
		await mock.emit(
			"tool_call",
			{ type: "tool_call", toolName: "write", toolCallId: "tool-1", input: { path: "generated.txt", content: "hello" } },
			context,
		);
		assert.equal(mock.appended[2]?.kind, "update");
		assert.equal(mock.appended[2]?.files["generated.txt"]?.backupFileName, null);
		await writeFile(filePath, "hello\n");

		const forkResult = await mock.emit(
			"session_before_fork",
			{ type: "session_before_fork", entryId: "user-entry", position: "before" },
			context,
		);
		assert.equal(forkResult, undefined);
		await assert.rejects(stat(filePath), { code: "ENOENT" });
		assert.equal(await readFile(notesPath, "utf8"), "before\n");
		await writeFile(filePath, "hello again\n");
		await writeFile(notesPath, "after again\n");
		const branchResult = await mock.emit(
			"session_before_branch",
			{ type: "session_before_branch", entryId: "user-entry" },
			context,
		);
		assert.equal(branchResult, undefined);
		await assert.rejects(stat(filePath), { code: "ENOENT" });
		assert.equal(await readFile(notesPath, "utf8"), "before\n");
		assert.equal(notifications.filter((message) => message.includes("2 files restored")).length, 2);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
