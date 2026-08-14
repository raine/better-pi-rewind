import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	REWIND_ENTRY_TYPE,
	REWIND_ENTRY_VERSION,
	type Checkpoint,
	type CheckpointRecord,
	type CheckpointSnapshotRecord,
	type FileVersion,
	type RestoreResult,
} from "./types.ts";

interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface CaptureResult {
	files: Record<string, FileVersion>;
	errors: Array<{ path: string; error: string }>;
}

export interface DiffResult {
	changedFiles: string[];
	additions: number;
	deletions: number;
	errors: Array<{ path: string; error: string }>;
}

const SAFE_STORAGE_COMPONENT = /^[A-Za-z0-9._@-]+$/;

function isSafeStorageComponent(value: string): boolean {
	return value !== "." && value !== ".." && SAFE_STORAGE_COMPONENT.test(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFileVersion(value: unknown): value is FileVersion {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<FileVersion>;
	return (
		(candidate.backupFileName === null ||
			(typeof candidate.backupFileName === "string" && isSafeStorageComponent(candidate.backupFileName))) &&
		typeof candidate.storeId === "string" &&
		isSafeStorageComponent(candidate.storeId) &&
		(candidate.mode === undefined || typeof candidate.mode === "number")
	);
}

export function isCheckpointRecord(value: unknown): value is CheckpointRecord {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<CheckpointRecord>;
	if (
		candidate.version !== REWIND_ENTRY_VERSION ||
		(candidate.kind !== "snapshot" && candidate.kind !== "update") ||
		typeof candidate.userEntryId !== "string" ||
		typeof candidate.files !== "object" ||
		candidate.files === null
	) {
		return false;
	}
	if (!Object.values(candidate.files).every(isFileVersion)) return false;
	if (candidate.kind === "snapshot") {
		return (
			typeof candidate.prompt === "string" &&
			typeof candidate.cwd === "string" &&
			typeof candidate.timestamp === "string"
		);
	}
	return true;
}

export function recordsFromEntries(entries: readonly EntryLike[]): CheckpointRecord[] {
	const records: CheckpointRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== REWIND_ENTRY_TYPE) continue;
		if (isCheckpointRecord(entry.data)) records.push(entry.data);
	}
	return records;
}

export class CheckpointHistory {
	private readonly checkpoints = new Map<string, Checkpoint>();
	private readonly order: string[] = [];
	private readonly trackedFiles = new Set<string>();
	private readonly firstVersions = new Map<string, FileVersion>();

	constructor(records: readonly CheckpointRecord[] = []) {
		for (const record of records) this.apply(record);
	}

	apply(record: CheckpointRecord): void {
		if (record.kind === "snapshot") {
			const existing = this.checkpoints.get(record.userEntryId);
			const checkpoint: Checkpoint = {
				userEntryId: record.userEntryId,
				prompt: record.prompt,
				cwd: record.cwd,
				timestamp: record.timestamp,
				files: { ...record.files },
			};
			this.checkpoints.set(record.userEntryId, checkpoint);
			if (!existing) this.order.push(record.userEntryId);
		} else {
			const checkpoint = this.checkpoints.get(record.userEntryId);
			if (!checkpoint) return;
			Object.assign(checkpoint.files, record.files);
		}

		for (const [trackingPath, version] of Object.entries(record.files)) {
			this.trackedFiles.add(trackingPath);
			if (!this.firstVersions.has(trackingPath)) {
				this.firstVersions.set(trackingPath, version);
			}
		}
	}

	get(userEntryId: string): Checkpoint | undefined {
		return this.checkpoints.get(userEntryId);
	}

	list(): Checkpoint[] {
		return this.order.flatMap((id) => {
			const checkpoint = this.checkpoints.get(id);
			return checkpoint ? [checkpoint] : [];
		});
	}

	latest(): Checkpoint | undefined {
		const id = this.order.at(-1);
		return id ? this.checkpoints.get(id) : undefined;
	}

	getTrackedPaths(): string[] {
		return [...this.trackedFiles];
	}

	getVersion(checkpoint: Checkpoint, trackingPath: string): FileVersion | undefined {
		return checkpoint.files[trackingPath] ?? this.firstVersions.get(trackingPath);
	}
}

export function makeTrackingPath(cwd: string, filePath: string): string {
	const absolutePath = resolve(cwd, filePath);
	const relativePath = relative(cwd, absolutePath);
	if (relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
		return relativePath;
	}
	if (relativePath === "") return ".";
	return absolutePath;
}

export function resolveTrackingPath(cwd: string, trackingPath: string): string {
	return isAbsolute(trackingPath) ? trackingPath : resolve(cwd, trackingPath);
}

function backupDirectory(agentDir: string, storeId: string): string {
	if (!isSafeStorageComponent(storeId)) throw new Error("Invalid checkpoint store ID");
	return join(agentDir, "file-history", storeId);
}

export function resolveBackupPath(agentDir: string, version: FileVersion): string | undefined {
	if (version.backupFileName === null) return undefined;
	if (!isSafeStorageComponent(version.backupFileName)) throw new Error("Invalid checkpoint backup name");
	return join(backupDirectory(agentDir, version.storeId), version.backupFileName);
}

function backupName(filePath: string): string {
	const pathHash = createHash("sha256").update(filePath).digest("hex").slice(0, 16);
	return `${pathHash}@${randomUUID()}`;
}

export async function captureFileVersion(filePath: string, agentDir: string, storeId: string): Promise<FileVersion> {
	let fileStats;
	try {
		fileStats = await stat(filePath);
	} catch (error) {
		if (isNotFound(error)) return { backupFileName: null, storeId };
		throw error;
	}
	if (!fileStats.isFile()) throw new Error("Checkpoint targets must be regular files");

	const fileName = backupName(filePath);
	const destination = join(backupDirectory(agentDir, storeId), fileName);
	await mkdir(backupDirectory(agentDir, storeId), { recursive: true });
	await copyFile(filePath, destination);
	await chmod(destination, fileStats.mode);
	return { backupFileName: fileName, mode: fileStats.mode, storeId };
}

export async function captureTrackedFiles(
	trackingPaths: readonly string[],
	cwd: string,
	agentDir: string,
	storeId: string,
): Promise<CaptureResult> {
	const files: Record<string, FileVersion> = {};
	const errors: CaptureResult["errors"] = [];
	await Promise.all(
		trackingPaths.map(async (trackingPath) => {
			const filePath = resolveTrackingPath(cwd, trackingPath);
			try {
				files[trackingPath] = await captureFileVersion(filePath, agentDir, storeId);
			} catch (error) {
				errors.push({ path: filePath, error: errorMessage(error) });
			}
		}),
	);
	return { files, errors };
}

async function hashFile(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

export async function fileDiffers(filePath: string, version: FileVersion, agentDir: string): Promise<boolean> {
	if (version.backupFileName === null) {
		try {
			await stat(filePath);
			return true;
		} catch (error) {
			if (isNotFound(error)) return false;
			throw error;
		}
	}

	const backupPath = resolveBackupPath(agentDir, version);
	if (!backupPath) return false;
	let currentStats;
	let backupStats;
	try {
		[currentStats, backupStats] = await Promise.all([stat(filePath), stat(backupPath)]);
	} catch (error) {
		if (isNotFound(error)) return true;
		throw error;
	}
	if (currentStats.mode !== backupStats.mode || currentStats.size !== backupStats.size) return true;
	const [currentHash, backupHash] = await Promise.all([hashFile(filePath), hashFile(backupPath)]);
	return currentHash !== backupHash;
}

export interface LineChanges {
	additions: number;
	deletions: number;
}

function textLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

export function countLineChanges(beforeText: string, afterText: string): LineChanges {
	if (beforeText === afterText) return { additions: 0, deletions: 0 };
	const before = textLines(beforeText);
	const after = textLines(afterText);
	const furthest = new Map<number, number>([[1, 0]]);
	const maximumDistance = before.length + after.length;

	for (let distance = 0; distance <= maximumDistance; distance += 1) {
		for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
			const down = furthest.get(diagonal + 1) ?? -1;
			const right = (furthest.get(diagonal - 1) ?? -1) + 1;
			let x = diagonal === -distance || (diagonal !== distance && right < down) ? down : right;
			let y = x - diagonal;
			while (x < before.length && y < after.length && before[x] === after[y]) {
				x += 1;
				y += 1;
			}
			furthest.set(diagonal, x);
			if (x >= before.length && y >= after.length) {
				return {
					additions: (distance + after.length - before.length) / 2,
					deletions: (distance + before.length - after.length) / 2,
				};
			}
		}
	}
	return { additions: after.length, deletions: before.length };
}

async function readCurrentText(filePath: string): Promise<string> {
	try {
		return await readFile(filePath, "utf8");
	} catch (error) {
		if (isNotFound(error)) return "";
		throw error;
	}
}

async function readVersionText(version: FileVersion, agentDir: string): Promise<string> {
	const backupPath = resolveBackupPath(agentDir, version);
	return backupPath ? readFile(backupPath, "utf8") : "";
}

export async function getCheckpointDiff(
	history: CheckpointHistory,
	checkpoint: Checkpoint,
	agentDir: string,
): Promise<DiffResult> {
	const changedFiles: string[] = [];
	let additions = 0;
	let deletions = 0;
	const errors: DiffResult["errors"] = [];
	for (const trackingPath of history.getTrackedPaths()) {
		const version = history.getVersion(checkpoint, trackingPath);
		if (!version) continue;
		const filePath = resolveTrackingPath(checkpoint.cwd, trackingPath);
		try {
			if (await fileDiffers(filePath, version, agentDir)) {
				changedFiles.push(filePath);
				const [beforeText, afterText] = await Promise.all([
					readVersionText(version, agentDir),
					readCurrentText(filePath),
				]);
				const changes = countLineChanges(beforeText, afterText);
				additions += changes.additions;
				deletions += changes.deletions;
			}
		} catch (error) {
			errors.push({ path: filePath, error: errorMessage(error) });
		}
	}
	return { changedFiles, additions, deletions, errors };
}

async function restoreFile(filePath: string, version: FileVersion, agentDir: string): Promise<boolean> {
	if (version.backupFileName === null) {
		try {
			await unlink(filePath);
			return true;
		} catch (error) {
			if (isNotFound(error)) return false;
			throw error;
		}
	}
	if (!(await fileDiffers(filePath, version, agentDir))) return false;
	const source = resolveBackupPath(agentDir, version);
	if (!source) throw new Error("Checkpoint backup is missing");
	await mkdir(dirname(filePath), { recursive: true });
	await copyFile(source, filePath);
	if (version.mode !== undefined) await chmod(filePath, version.mode);
	return true;
}

export async function restoreCheckpoint(
	history: CheckpointHistory,
	checkpoint: Checkpoint,
	agentDir: string,
): Promise<RestoreResult> {
	const changedFiles: string[] = [];
	const errors: RestoreResult["errors"] = [];
	for (const trackingPath of history.getTrackedPaths()) {
		const version = history.getVersion(checkpoint, trackingPath);
		if (!version) continue;
		const filePath = resolveTrackingPath(checkpoint.cwd, trackingPath);
		try {
			if (await restoreFile(filePath, version, agentDir)) changedFiles.push(filePath);
		} catch (error) {
			errors.push({ path: filePath, error: errorMessage(error) });
		}
	}
	return { changedFiles, errors };
}

export function createSnapshotRecord(
	userEntryId: string,
	prompt: string,
	cwd: string,
	files: Record<string, FileVersion>,
): CheckpointSnapshotRecord {
	return {
		version: REWIND_ENTRY_VERSION,
		kind: "snapshot",
		userEntryId,
		prompt,
		cwd,
		timestamp: new Date().toISOString(),
		files,
	};
}
