import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CheckpointHistory,
	captureFileVersion,
	createSnapshotRecord,
	getCheckpointDiff,
	isCheckpointRecord,
	makeTrackingPath,
	restoreCheckpoint,
} from "../src/file-history.ts";
import { REWIND_ENTRY_VERSION, type CheckpointUpdateRecord } from "../src/types.ts";

test("restores modified content and file permissions", async () => {
	const root = await mkdtemp(join(tmpdir(), "better-pi-rewind-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const filePath = join(cwd, "src", "example.txt");
	await mkdir(join(cwd, "src"), { recursive: true });
	await writeFile(filePath, "before\n");
	await chmod(filePath, 0o640);

	const trackingPath = makeTrackingPath(cwd, filePath);
	const version = await captureFileVersion(filePath, agentDir, "session-1");
	const snapshot = createSnapshotRecord("user-1", "change the file", cwd, { [trackingPath]: version });
	const history = new CheckpointHistory([snapshot]);

	await writeFile(filePath, "after\n");
	await chmod(filePath, 0o600);
	const diff = await getCheckpointDiff(history, history.get("user-1")!, agentDir);
	assert.deepEqual(diff.changedFiles, [filePath]);
	assert.deepEqual(diff.errors, []);

	const result = await restoreCheckpoint(history, history.get("user-1")!, agentDir);
	assert.deepEqual(result.changedFiles, [filePath]);
	assert.deepEqual(result.errors, []);
	assert.equal(await readFile(filePath, "utf8"), "before\n");
	assert.equal((await stat(filePath)).mode & 0o777, 0o640);
});

test("deletes a file that was absent at the checkpoint", async () => {
	const root = await mkdtemp(join(tmpdir(), "better-pi-rewind-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const filePath = join(cwd, "generated.txt");
	await mkdir(cwd, { recursive: true });

	const trackingPath = makeTrackingPath(cwd, filePath);
	const version = await captureFileVersion(filePath, agentDir, "session-2");
	const snapshot = createSnapshotRecord("user-2", "create a file", cwd, { [trackingPath]: version });
	const history = new CheckpointHistory([snapshot]);
	await writeFile(filePath, "generated\n");

	const result = await restoreCheckpoint(history, history.get("user-2")!, agentDir);
	assert.deepEqual(result.changedFiles, [filePath]);
	await assert.rejects(stat(filePath), { code: "ENOENT" });
});

test("uses the first tracked version for older checkpoints", async () => {
	const root = await mkdtemp(join(tmpdir(), "better-pi-rewind-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const filePath = join(cwd, "existing.txt");
	await mkdir(cwd, { recursive: true });
	await writeFile(filePath, "original\n");

	const oldSnapshot = createSnapshotRecord("user-old", "inspect the project", cwd, {});
	const newerSnapshot = createSnapshotRecord("user-new", "edit existing", cwd, {});
	const history = new CheckpointHistory([oldSnapshot, newerSnapshot]);
	const trackingPath = makeTrackingPath(cwd, filePath);
	const firstVersion = await captureFileVersion(filePath, agentDir, "session-3");
	const update: CheckpointUpdateRecord = {
		version: REWIND_ENTRY_VERSION,
		kind: "update",
		userEntryId: "user-new",
		files: { [trackingPath]: firstVersion },
	};
	history.apply(update);
	await writeFile(filePath, "changed\n");

	const result = await restoreCheckpoint(history, history.get("user-old")!, agentDir);
	assert.deepEqual(result.changedFiles, [filePath]);
	assert.equal(await readFile(filePath, "utf8"), "original\n");
});

test("rejects backup paths that escape checkpoint storage", () => {
	assert.equal(
		isCheckpointRecord({
			version: 1,
			kind: "snapshot",
			userEntryId: "user-1",
			prompt: "prompt",
			cwd: "/tmp/project",
			timestamp: new Date().toISOString(),
			files: { "a.txt": { backupFileName: "backup", storeId: ".." } },
		}),
		false,
	);
});

test("ignores duplicate tracking within one checkpoint", async () => {
	const cwd = "/tmp/project";
	const snapshot = createSnapshotRecord("user-1", "prompt", cwd, {
		"a.txt": { backupFileName: null, storeId: "session-1" },
	});
	const history = new CheckpointHistory([snapshot]);
	const update: CheckpointUpdateRecord = {
		version: REWIND_ENTRY_VERSION,
		kind: "update",
		userEntryId: "user-1",
		files: { "b.txt": { backupFileName: null, storeId: "session-1" } },
	};
	history.apply(update);

	assert.deepEqual(history.getTrackedPaths().sort(), ["a.txt", "b.txt"]);
	assert.equal(history.get("user-1")?.files["b.txt"]?.backupFileName, null);
});
