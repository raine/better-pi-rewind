import {
	getAgentDir,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import {
	CheckpointHistory,
	captureFileVersion,
	captureTrackedFiles,
	createSnapshotRecord,
	getCheckpointDiff,
	makeTrackingPath,
	recordsFromEntries,
	restoreCheckpoint,
} from "../src/file-history.ts";
import { branchConversation, registerBeforeBranchHandler } from "../src/host-adapter.ts";
import { RewindSelector, type RewindSelectorItem } from "../src/rewind-selector.ts";
import { toolInputPaths } from "../src/tool-input-paths.ts";
import {
	REWIND_ENTRY_TYPE,
	REWIND_ENTRY_VERSION,
	type CheckpointUpdateRecord,
	type RestoreResult,
} from "../src/types.ts";

interface RuntimeState {
	history: CheckpointHistory;
	storeId: string;
	currentCheckpointId?: string;
	pendingUserMessage: boolean;
}

function userPrompt(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") return undefined;
	const content = entry.message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
	return text || undefined;
}

function latestUserEntry(entries: readonly SessionEntry[]): SessionEntry | undefined {
	return [...entries].reverse().find((entry) => userPrompt(entry) !== undefined);
}

function resultMessage(result: RestoreResult): string {
	const restored = `${result.changedFiles.length} ${result.changedFiles.length === 1 ? "file" : "files"} restored`;
	return result.errors.length === 0 ? restored : `${restored}, ${result.errors.length} failed`;
}

function notifyErrors(ctx: ExtensionContext, errors: Array<{ path: string; error: string }>, action: string): void {
	if (errors.length === 0) return;
	const first = errors[0];
	const detail = first ? `: ${first.path}: ${first.error}` : "";
	ctx.ui.notify(`${action} had ${errors.length} ${errors.length === 1 ? "error" : "errors"}${detail}`, "warning");
}

export default function rewindExtension(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	let state: RuntimeState | undefined;
	let suppressBranchPromptFor: string | undefined;
	let removeTerminalInputListener: (() => void) | undefined;
	let lastEscapeTime = 0;
	let rewindUiOpen = false;

	function rebuildState(ctx: ExtensionContext): RuntimeState {
		const history = new CheckpointHistory(recordsFromEntries(ctx.sessionManager.getEntries()));
		const branchHistory = new CheckpointHistory(recordsFromEntries(ctx.sessionManager.getBranch()));
		state = {
			history,
			storeId: ctx.sessionManager.getSessionId(),
			currentCheckpointId: branchHistory.latest()?.userEntryId,
			pendingUserMessage: false,
		};
		return state;
	}

	function getState(ctx: ExtensionContext): RuntimeState {
		if (!state || state.storeId !== ctx.sessionManager.getSessionId()) return rebuildState(ctx);
		return state;
	}

	pi.on("session_start", async (_event, ctx) => {
		rebuildState(ctx);
		removeTerminalInputListener?.();
		lastEscapeTime = 0;
		if (ctx.mode !== "tui") return;
		removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
			if (data !== "" || rewindUiOpen || !ctx.isIdle() || ctx.ui.getEditorText().trim()) {
				if (data !== "") lastEscapeTime = 0;
				return undefined;
			}
			const now = Date.now();
			if (now - lastEscapeTime >= 500) {
				lastEscapeTime = now;
				return undefined;
			}
			lastEscapeTime = 0;
			ctx.ui.setEditorText("/rewind");
			return { data: "\r" };
		});
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "user") getState(ctx).pendingUserMessage = true;
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const current = getState(ctx);
		if (!current.pendingUserMessage) return;
		current.pendingUserMessage = false;

		const entry = latestUserEntry(ctx.sessionManager.getBranch());
		const prompt = entry ? userPrompt(entry) : undefined;
		if (!entry || !prompt) return;
		if (current.history.get(entry.id)) {
			current.currentCheckpointId = entry.id;
			return;
		}

		const captured = await captureTrackedFiles(
			current.history.getTrackedPaths(),
			ctx.cwd,
			agentDir,
			current.storeId,
		);
		const record = createSnapshotRecord(entry.id, prompt, ctx.cwd, captured.files);
		pi.appendEntry(REWIND_ENTRY_TYPE, record);
		current.history.apply(record);
		current.currentCheckpointId = entry.id;
		notifyErrors(ctx, captured.errors, "Checkpoint capture");
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
		const current = getState(ctx);
		const checkpoint = current.currentCheckpointId
			? current.history.get(current.currentCheckpointId)
			: current.history.latest();
		if (!checkpoint) return;

		const files: CheckpointUpdateRecord["files"] = {};
		for (const inputPath of toolInputPaths(event.toolName, event.input)) {
			const absolutePath = resolve(ctx.cwd, inputPath);
			const trackingPath = makeTrackingPath(checkpoint.cwd, absolutePath);
			if (checkpoint.files[trackingPath]) continue;

			try {
				files[trackingPath] = await captureFileVersion(absolutePath, agentDir, current.storeId);
			} catch (error) {
				ctx.ui.notify(
					`Could not checkpoint ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		}
		if (Object.keys(files).length === 0) return;
		const record: CheckpointUpdateRecord = {
			version: REWIND_ENTRY_VERSION,
			kind: "update",
			userEntryId: checkpoint.userEntryId,
			files,
		};
		pi.appendEntry(REWIND_ENTRY_TYPE, record);
		current.history.apply(record);
	});

	registerBeforeBranchHandler(pi, async (event, ctx) => {
		if (suppressBranchPromptFor === event.entryId) {
			suppressBranchPromptFor = undefined;
			return;
		}
		const current = getState(ctx);
		const checkpoint = current.history.get(event.entryId);
		if (!checkpoint || !ctx.hasUI) return;

		const diff = await getCheckpointDiff(current.history, checkpoint, agentDir);
		notifyErrors(ctx, diff.errors, "Checkpoint comparison");
		if (diff.changedFiles.length === 0) return;
		const count = diff.changedFiles.length;
		const choice = await ctx.ui.select("Restore code with conversation?", [
			`Restore ${count} changed ${count === 1 ? "file" : "files"}`,
			"Keep current code",
			"Cancel branch",
		]);
		if (choice === "Cancel branch" || choice === undefined) return { cancel: true };
		if (choice === "Keep current code") return;

		const result = await restoreCheckpoint(current.history, checkpoint, agentDir);
		ctx.ui.notify(resultMessage(result), result.errors.length === 0 ? "info" : "warning");
		notifyErrors(ctx, result.errors, "Code restore");
	});

	async function rewindCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			ctx.ui.notify("/rewind requires an interactive terminal UI", "warning");
			return;
		}
		rewindUiOpen = true;
		try {
			await ctx.waitForIdle();
			const current = getState(ctx);
			const branch = ctx.sessionManager.getBranch();
			const candidates = branch.flatMap((entry) => {
				const prompt = userPrompt(entry);
				const checkpoint = current.history.get(entry.id);
				return prompt && checkpoint ? [{ entry, prompt, checkpoint }] : [];
			});
			if (candidates.length === 0) {
				ctx.ui.notify("No code checkpoints are available yet", "warning");
				return;
			}

			const visibleCandidates = candidates.slice(-100);
			const candidateItems = await Promise.all(
				visibleCandidates.map(async (candidate): Promise<RewindSelectorItem> => {
					const diff = await getCheckpointDiff(current.history, candidate.checkpoint, agentDir);
					notifyErrors(ctx, diff.errors, "Checkpoint comparison");
					return {
						id: candidate.entry.id,
						prompt: candidate.prompt,
						filesChanged: diff.changedFiles.length,
						additions: diff.additions,
						deletions: diff.deletions,
					};
				}),
			);
			const selectedItem = await ctx.ui.custom<RewindSelectorItem | undefined>(
				(_tui, theme, _keybindings, done) =>
					new RewindSelector(
						[
							...candidateItems,
							{ prompt: "(current)", filesChanged: 0, additions: 0, deletions: 0, current: true },
						],
						theme,
						done,
					),
			);
			if (!selectedItem?.id || selectedItem.current) return;
			const selected = visibleCandidates.find((candidate) => candidate.entry.id === selectedItem.id);
			if (!selected) return;

			const diff = await getCheckpointDiff(current.history, selected.checkpoint, agentDir);
			notifyErrors(ctx, diff.errors, "Checkpoint comparison");
			const count = diff.changedFiles.length;
			const both = `Restore code and conversation (${count} ${count === 1 ? "file" : "files"})`;
			const conversation = "Restore conversation only";
			const code = `Restore code only (${count} ${count === 1 ? "file" : "files"})`;
			const choices = count > 0 ? [both, conversation, code, "Cancel"] : ["Restore conversation (code already matches)", "Cancel"];
			const choice = await ctx.ui.select("Choose what to restore", choices);
			if (!choice || choice === "Cancel") return;

			let restoreResult: RestoreResult | undefined;
			const restoreCode = choice === both || choice === code;
			const restoreConversation = choice === both || choice === conversation || choice.startsWith("Restore conversation (");
			if (restoreCode) {
				restoreResult = await restoreCheckpoint(current.history, selected.checkpoint, agentDir);
				ctx.ui.notify(resultMessage(restoreResult), restoreResult.errors.length === 0 ? "info" : "warning");
				notifyErrors(ctx, restoreResult.errors, "Code restore");
			}
			if (!restoreConversation) return;

			suppressBranchPromptFor = selected.entry.id;
			const suffix = restoreResult ? ` and ${resultMessage(restoreResult)}` : "";
			const result = await branchConversation(
				ctx,
				selected.entry.id,
				selected.prompt,
				`Conversation rewound${suffix}`,
				restoreResult?.errors.length ? "warning" : "info",
			);
			if (result.cancelled) {
				suppressBranchPromptFor = undefined;
				ctx.ui.notify("Conversation rewind was cancelled", "warning");
			}
		} finally {
			rewindUiOpen = false;
		}
	}

	pi.on("session_shutdown", async () => {
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
	});

	pi.registerCommand("rewind", {
		description: "Restore code and/or conversation to an earlier user prompt",
		handler: rewindCommand,
	});
	pi.registerCommand("checkpoint", {
		description: "Alias for /rewind",
		handler: rewindCommand,
	});
}
