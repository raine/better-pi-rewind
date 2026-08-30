import { execFile } from "node:child_process";
import type { GitCheckpoint } from "./types.ts";

interface GitCommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

export type GitResetTarget =
	| { kind: "descendant-commits"; commitCount: number }
	| { kind: "amended-commit" };

export type GitResetPlan =
	| {
		kind: "available";
		checkpoint: GitCheckpoint;
		currentHead: string;
		target: GitResetTarget;
	}
	| { kind: "unchanged" }
	| { kind: "unavailable"; reason: string };

const GIT_TIMEOUT_MS = 30_000;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function runGit(cwd: string, args: readonly string[]): Promise<GitCommandResult> {
	return new Promise((resolveResult) => {
		execFile(
			"git",
			["-C", cwd, ...args],
			{ encoding: "utf8", maxBuffer: 1024 * 1024, timeout: GIT_TIMEOUT_MS, windowsHide: true },
			(error, stdout, stderr) => {
				resolveResult({
					code: error ? (typeof error.code === "number" ? error.code : null) : 0,
					stdout: String(stdout),
					stderr: String(stderr),
					...(error ? { error } : {}),
				});
			},
		);
	});
}

function commandError(result: GitCommandResult, fallback: string): Error {
	const message = result.stderr.trim() || result.error?.message || fallback;
	return new Error(message);
}

export async function captureGitCheckpoint(cwd: string): Promise<GitCheckpoint | undefined> {
	const rootResult = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (rootResult.code !== 0) return undefined;
	const repositoryRoot = rootResult.stdout.trim();
	if (!repositoryRoot) return undefined;

	const [headResult, branchResult] = await Promise.all([
		runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD"]),
		runGit(repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"]),
	]);
	if (headResult.code !== 0) return undefined;
	const head = headResult.stdout.trim();
	if (!GIT_OBJECT_ID.test(head)) return undefined;

	return {
		repositoryRoot,
		head,
		branch: branchResult.code === 0 ? branchResult.stdout.trim() || null : null,
	};
}

async function wasImmediatelyAmended(
	repositoryRoot: string,
	checkpointHead: string,
	currentHead: string,
): Promise<boolean> {
	const reflogResult = await runGit(repositoryRoot, [
		"reflog",
		"show",
		"-2",
		"--format=%H%x00%gs",
		"HEAD",
	]);
	if (reflogResult.code !== 0) return false;
	const entries = reflogResult.stdout.trimEnd().split("\n");
	if (entries.length !== 2) return false;
	const [latestHead, latestAction] = entries[0]!.replace(/\r$/, "").split("\0", 2);
	const [previousHead] = entries[1]!.replace(/\r$/, "").split("\0", 1);
	return (
		latestHead === currentHead &&
		previousHead === checkpointHead &&
		/^commit \(amend\)(?::|$)/.test(latestAction ?? "")
	);
}

export async function getGitResetPlan(
	checkpoint: GitCheckpoint | undefined,
	cwd: string,
): Promise<GitResetPlan> {
	if (!checkpoint) return { kind: "unavailable", reason: "This checkpoint does not include Git state" };
	if (!GIT_OBJECT_ID.test(checkpoint.head)) {
		return { kind: "unavailable", reason: "The checkpoint Git object ID is invalid" };
	}
	const current = await captureGitCheckpoint(cwd);
	if (!current) return { kind: "unavailable", reason: "The current directory does not have a Git commit" };
	if (current.repositoryRoot !== checkpoint.repositoryRoot) {
		return { kind: "unavailable", reason: "The current Git repository differs from the checkpoint" };
	}
	if (current.branch !== checkpoint.branch) {
		return { kind: "unavailable", reason: "The current Git branch differs from the checkpoint" };
	}
	if (current.head === checkpoint.head) return { kind: "unchanged" };

	const ancestorResult = await runGit(current.repositoryRoot, [
		"merge-base",
		"--is-ancestor",
		checkpoint.head,
		current.head,
	]);
	if (ancestorResult.code === 1) {
		if (await wasImmediatelyAmended(current.repositoryRoot, checkpoint.head, current.head)) {
			return {
				kind: "available",
				checkpoint,
				currentHead: current.head,
				target: { kind: "amended-commit" },
			};
		}
		return { kind: "unavailable", reason: "The checkpoint commit is not an ancestor of HEAD" };
	}
	if (ancestorResult.code !== 0) {
		return { kind: "unavailable", reason: "Git history could not be compared" };
	}

	const countResult = await runGit(current.repositoryRoot, [
		"rev-list",
		"--count",
		`${checkpoint.head}..${current.head}`,
	]);
	if (countResult.code !== 0) {
		return { kind: "unavailable", reason: "Git commits could not be counted" };
	}
	const commitCount = Number.parseInt(countResult.stdout.trim(), 10);
	if (!Number.isSafeInteger(commitCount) || commitCount < 1) {
		return { kind: "unavailable", reason: "Git returned an invalid commit count" };
	}
	return {
		kind: "available",
		checkpoint,
		currentHead: current.head,
		target: { kind: "descendant-commits", commitCount },
	};
}

export async function resetGitCommits(
	plan: Extract<GitResetPlan, { kind: "available" }>,
	cwd: string,
): Promise<GitResetTarget> {
	if (!GIT_OBJECT_ID.test(plan.checkpoint.head)) throw new Error("The checkpoint Git object ID is invalid");
	const current = await captureGitCheckpoint(cwd);
	if (!current) throw new Error("The current directory does not have a Git commit");
	if (
		current.repositoryRoot !== plan.checkpoint.repositoryRoot ||
		current.branch !== plan.checkpoint.branch ||
		current.head !== plan.currentHead
	) {
		throw new Error("Git HEAD changed after the reset option was prepared");
	}

	const result = await runGit(current.repositoryRoot, [
		"reset",
		"--hard",
		"--no-recurse-submodules",
		plan.checkpoint.head,
	]);
	if (result.code !== 0) throw commandError(result, "Git reset failed");
	return plan.target;
}
