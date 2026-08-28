import {
	CONFIG_DIR_NAME,
	getAgentDir,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { DEFAULT_REWIND_CONFIG, loadRewindConfig, type RewindConfig } from "../src/config.ts";
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
import {
	captureGitCheckpoint,
	getGitResetPlan,
	resetGitCommits,
	type GitResetPlan,
} from "../src/git-history.ts";
import { registerBeforeBranchHandler, rewindConversation } from "../src/host-adapter.ts";
import { RewindSelector, type RewindSelectorItem } from "../src/rewind-selector.ts";
import { buildRestoreActions } from "../src/restore-actions.ts";
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

function commitResetMessage(count: number): string {
	return `${count} ${count === 1 ? "commit" : "commits"} reset`;
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
	let lastEscapeWasActive = false;
	let rewindUiOpen = false;
	let config: RewindConfig = DEFAULT_REWIND_CONFIG;

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

	async function resetCheckpointCommits(
		ctx: ExtensionContext,
		plan: Extract<GitResetPlan, { kind: "available" }>,
	): Promise<number | undefined> {
		const count = plan.commitCount;
		const confirmed = await ctx.ui.confirm(
			`Hard-reset ${count} ${count === 1 ? "commit" : "commits"}?`,
			"This runs git reset --hard. Uncommitted working tree and index changes may be discarded. Checkpointed files are restored afterward.",
		);
		if (!confirmed) return undefined;
		try {
			const resetCount = await resetGitCommits(plan, ctx.cwd);
			ctx.ui.notify(commitResetMessage(resetCount), "info");
			return resetCount;
		} catch (error) {
			ctx.ui.notify(`Git reset failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		rebuildState(ctx);
		removeTerminalInputListener?.();
		lastEscapeTime = 0;
		lastEscapeWasActive = false;
		try {
			config = await loadRewindConfig({
				agentDir,
				cwd: ctx.cwd,
				configDirName: CONFIG_DIR_NAME,
				projectTrusted: ctx.isProjectTrusted(),
			});
		} catch (error) {
			config = DEFAULT_REWIND_CONFIG;
			const message = error instanceof Error ? error.message : "invalid configuration";
			ctx.ui.notify(`better-pi-rewind: ${message}`, "warning");
		}
		if (ctx.mode !== "tui") return;
		removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
			if (data !== "") {
				lastEscapeTime = 0;
				return undefined;
			}
			if (rewindUiOpen) {
				lastEscapeTime = 0;
				return undefined;
			}

			const now = Date.now();
			const active = !ctx.isIdle();
			const isDoubleEscape = now - lastEscapeTime < config.escapeWindowMs && lastEscapeWasActive === active;
			if (active) {
				if (config.activeRunEscapePresses === 1) {
					lastEscapeTime = 0;
					return undefined;
				}
				if (isDoubleEscape) {
					lastEscapeTime = 0;
					return undefined;
				}
				lastEscapeTime = now;
				lastEscapeWasActive = true;
				return { consume: true };
			}

			if (ctx.ui.getEditorText().trim()) {
				lastEscapeTime = 0;
				return undefined;
			}
			if (!isDoubleEscape) {
				lastEscapeTime = now;
				lastEscapeWasActive = false;
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

		const [captured, git] = await Promise.all([
			captureTrackedFiles(current.history.getTrackedPaths(), ctx.cwd, agentDir, current.storeId),
			captureGitCheckpoint(ctx.cwd),
		]);
		const record = createSnapshotRecord(entry.id, prompt, ctx.cwd, captured.files, git);
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

		const [diff, gitPlan] = await Promise.all([
			getCheckpointDiff(current.history, checkpoint, agentDir),
			getGitResetPlan(checkpoint.git, ctx.cwd),
		]);
		notifyErrors(ctx, diff.errors, "Checkpoint comparison");
		const fileCount = diff.changedFiles.length;
		const commitCount = gitPlan.kind === "available" ? gitPlan.commitCount : 0;
		if (fileCount === 0 && commitCount === 0) return;

		const files = `${fileCount} changed ${fileCount === 1 ? "file" : "files"}`;
		const commits = `${commitCount} ${commitCount === 1 ? "commit" : "commits"}`;
		const restoreFiles = `Restore ${files}`;
		const restoreAndReset = `Restore ${files} and reset ${commits}`;
		const resetOnly = `Reset ${commits}`;
		const choices = fileCount > 0
			? [restoreFiles, ...(commitCount > 0 ? [restoreAndReset] : []), "Keep current code", "Cancel branch"]
			: [resetOnly, "Keep current code and commits", "Cancel branch"];
		const choice = await ctx.ui.select("Restore code with conversation?", choices);
		if (choice === "Cancel branch" || choice === undefined) return { cancel: true };
		if (choice === "Keep current code" || choice === "Keep current code and commits") return;

		const resetCommits = choice === restoreAndReset || choice === resetOnly;
		if (resetCommits && gitPlan.kind === "available") {
			const resetCount = await resetCheckpointCommits(ctx, gitPlan);
			if (resetCount === undefined) return { cancel: true };
		}
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

			const [diff, gitPlan] = await Promise.all([
				getCheckpointDiff(current.history, selected.checkpoint, agentDir),
				getGitResetPlan(selected.checkpoint.git, ctx.cwd),
			]);
			notifyErrors(ctx, diff.errors, "Checkpoint comparison");
			const commitCount = gitPlan.kind === "available" ? gitPlan.commitCount : 0;
			const actions = buildRestoreActions(diff.changedFiles.length, commitCount);
			const choice = await ctx.ui.select("Choose what to restore", actions.map((action) => action.label));
			const action = actions.find((candidate) => candidate.label === choice);
			if (!action || action.cancel) return;

			let resetCount: number | undefined;
			if (action.resetCommits && gitPlan.kind === "available") {
				resetCount = await resetCheckpointCommits(ctx, gitPlan);
				if (resetCount === undefined) return;
			}

			let restoreResult: RestoreResult | undefined;
			if (action.restoreCode) {
				restoreResult = await restoreCheckpoint(current.history, selected.checkpoint, agentDir);
				ctx.ui.notify(resultMessage(restoreResult), restoreResult.errors.length === 0 ? "info" : "warning");
				notifyErrors(ctx, restoreResult.errors, "Code restore");
			}
			if (!action.restoreConversation) return;

			suppressBranchPromptFor = selected.entry.id;
			const effects = [
				...(resetCount === undefined ? [] : [commitResetMessage(resetCount)]),
				...(restoreResult ? [resultMessage(restoreResult)] : []),
			];
			const suffix = effects.length > 0 ? ` and ${effects.join(" and ")}` : "";
			const result = await rewindConversation(
				ctx,
				selected.entry.id,
				selected.prompt,
				`Conversation rewound${suffix}`,
				restoreResult?.errors.length ? "warning" : "info",
			);
			suppressBranchPromptFor = undefined;
			if (result.cancelled) ctx.ui.notify("Conversation rewind was cancelled", "warning");
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
