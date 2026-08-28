import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	captureGitCheckpoint,
	getGitResetPlan,
	resetGitCommits,
} from "../src/git-history.ts";

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

async function createRepository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "better-pi-rewind-git-"));
	await mkdir(root, { recursive: true });
	await git(root, "init", "--initial-branch=main");
	await git(root, "config", "user.name", "Rewind Test");
	await git(root, "config", "user.email", "rewind@example.test");
	return root;
}

test("captures Git state and hard-resets descendant commits", async () => {
	const cwd = await createRepository();
	const filePath = join(cwd, "example.txt");
	await writeFile(filePath, "before\n");
	await git(cwd, "add", "example.txt");
	await git(cwd, "commit", "-m", "initial");

	const checkpoint = await captureGitCheckpoint(cwd);
	assert.ok(checkpoint);
	assert.equal(checkpoint.branch, "refs/heads/main");

	await writeFile(filePath, "committed after checkpoint\n");
	await git(cwd, "commit", "-am", "later");
	await writeFile(filePath, "uncommitted after later commit\n");

	const plan = await getGitResetPlan(checkpoint, cwd);
	assert.equal(plan.kind, "available");
	if (plan.kind !== "available") return;
	assert.equal(plan.commitCount, 1);
	assert.equal(await resetGitCommits(plan, cwd), 1);
	assert.equal(await git(cwd, "rev-parse", "HEAD"), checkpoint.head);
	assert.equal(await readFile(filePath, "utf8"), "before\n");
});

test("offers no reset when HEAD matches and rejects another branch", async () => {
	const cwd = await createRepository();
	await writeFile(join(cwd, "example.txt"), "before\n");
	await git(cwd, "add", "example.txt");
	await git(cwd, "commit", "-m", "initial");
	const checkpoint = await captureGitCheckpoint(cwd);
	assert.ok(checkpoint);
	assert.deepEqual(await getGitResetPlan(checkpoint, cwd), { kind: "unchanged" });

	await git(cwd, "switch", "-c", "other");
	await writeFile(join(cwd, "example.txt"), "other\n");
	await git(cwd, "commit", "-am", "other branch");
	const plan = await getGitResetPlan(checkpoint, cwd);
	assert.equal(plan.kind, "unavailable");
	if (plan.kind === "unavailable") assert.match(plan.reason, /branch differs/);
});

test("ignores directories outside Git repositories", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "better-pi-rewind-no-git-"));
	assert.equal(await captureGitCheckpoint(cwd), undefined);
});
