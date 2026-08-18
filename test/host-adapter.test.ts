import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	registerBeforeBranchHandler,
	rewindConversation,
} from "../src/host-adapter.ts";

test("normalizes Pi fork events and OMP branch events", async () => {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown>>();
	const pi = {
		on: (event: string, handler: (event: any, ctx: any) => Promise<unknown>) => {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const received: string[] = [];
	registerBeforeBranchHandler(pi, async (event) => {
		received.push(event.entryId);
		return undefined;
	});

	await handlers.get("session_before_fork")?.({ entryId: "pi-before", position: "before" }, {});
	await handlers.get("session_before_fork")?.({ entryId: "pi-after", position: "after" }, {});
	await handlers.get("session_before_branch")?.({ entryId: "omp-branch" }, {});
	assert.deepEqual(received, ["pi-before", "omp-branch"]);
});

test("navigates Pi conversations in place and uses the OMP branch API", async () => {
	const notifications: string[] = [];
	let editorText = "";
	let piEntryId = "";
	let forkCalled = false;
	const piContext = {
		navigateTree: async (entryId: string) => {
			piEntryId = entryId;
			return { cancelled: false };
		},
		fork: async () => {
			forkCalled = true;
			return { cancelled: false };
		},
		ui: {
			setEditorText: (text: string) => {
				editorText = text;
			},
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as ExtensionCommandContext;
	assert.deepEqual(
		await rewindConversation(piContext, "entry-pi", "original prompt", "Conversation rewound", "info"),
		{ cancelled: false },
	);
	assert.equal(piEntryId, "entry-pi");
	assert.equal(forkCalled, false);
	assert.equal(editorText, "original prompt");
	assert.deepEqual(notifications, ["Conversation rewound"]);

	let ompEntryId = "";
	const ompContext = {
		branch: async (entryId: string) => {
			ompEntryId = entryId;
			return { cancelled: false };
		},
	} as unknown as ExtensionCommandContext;
	assert.deepEqual(
		await rewindConversation(ompContext, "entry-omp", "unused prompt", "unused notification", "info"),
		{ cancelled: false },
	);
	assert.equal(ompEntryId, "entry-omp");
});
