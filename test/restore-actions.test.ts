import assert from "node:assert/strict";
import test from "node:test";
import { buildRestoreActions } from "../src/restore-actions.ts";

test("adds commit reset variants when commits followed the checkpoint", () => {
	const actions = buildRestoreActions(2, 3);
	assert.deepEqual(actions.map((action) => action.label), [
		"Restore code and conversation (2 files)",
		"Restore code and conversation, and reset 3 commits",
		"Restore conversation only",
		"Restore code only (2 files)",
		"Restore code and reset 3 commits",
		"Cancel",
	]);
	assert.deepEqual(
		actions.filter((action) => action.resetCommits).map((action) => [action.restoreCode, action.restoreConversation]),
		[[true, true], [true, false]],
	);
});

test("offers commit-only reset choices when checkpointed code matches", () => {
	const actions = buildRestoreActions(0, 1);
	assert.deepEqual(actions.map((action) => action.label), [
		"Restore conversation (code already matches)",
		"Restore conversation and reset 1 commit",
		"Reset 1 commit only",
		"Cancel",
	]);
	assert.equal(actions[2]?.restoreCode, true);
});

test("preserves the restore menu when no commits can be reset", () => {
	assert.deepEqual(buildRestoreActions(1, 0).map((action) => action.label), [
		"Restore code and conversation (1 file)",
		"Restore conversation only",
		"Restore code only (1 file)",
		"Cancel",
	]);
});
