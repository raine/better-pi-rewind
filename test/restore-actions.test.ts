import assert from "node:assert/strict";
import test from "node:test";
import { buildRestoreActions } from "../src/restore-actions.ts";

test("adds commit reset variants when commits followed the checkpoint", () => {
	const actions = buildRestoreActions(2, { kind: "descendant-commits", commitCount: 3 });
	assert.deepEqual(actions.map((action) => action.label), [
		"Restore code and conversation (2 files)",
		"Restore code and conversation, and reset 3 commits",
		"Restore conversation only",
		"Restore code only (2 files)",
		"Restore code and reset 3 commits",
		"Cancel",
	]);
	assert.deepEqual(
		actions.filter((action) => action.resetGit).map((action) => [action.restoreCode, action.restoreConversation]),
		[[true, true], [true, false]],
	);
});

test("offers commit-only reset choices when checkpointed code matches", () => {
	const actions = buildRestoreActions(0, { kind: "descendant-commits", commitCount: 1 });
	assert.deepEqual(actions.map((action) => action.label), [
		"Restore conversation (code already matches)",
		"Restore conversation and reset 1 commit",
		"Reset 1 commit only",
		"Cancel",
	]);
	assert.equal(actions[2]?.restoreCode, true);
});

test("adds amended commit rollback variants", () => {
	assert.deepEqual(buildRestoreActions(1, { kind: "amended-commit" }).map((action) => action.label), [
		"Restore code and conversation (1 file)",
		"Restore code and conversation, and roll back amended commit",
		"Restore conversation only",
		"Restore code only (1 file)",
		"Restore code and roll back amended commit",
		"Cancel",
	]);
	assert.deepEqual(buildRestoreActions(0, { kind: "amended-commit" }).map((action) => action.label), [
		"Restore conversation (code already matches)",
		"Restore conversation and roll back amended commit",
		"Roll back amended commit only",
		"Cancel",
	]);
});

test("preserves the restore menu when Git history already matches", () => {
	assert.deepEqual(buildRestoreActions(1).map((action) => action.label), [
		"Restore code and conversation (1 file)",
		"Restore conversation only",
		"Restore code only (1 file)",
		"Cancel",
	]);
});
