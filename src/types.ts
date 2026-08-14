export const REWIND_ENTRY_TYPE = "better-pi-rewind.file-history";
export const REWIND_ENTRY_VERSION = 1;

export interface FileVersion {
	backupFileName: string | null;
	mode?: number;
	storeId: string;
}

export interface CheckpointSnapshotRecord {
	version: typeof REWIND_ENTRY_VERSION;
	kind: "snapshot";
	userEntryId: string;
	prompt: string;
	cwd: string;
	timestamp: string;
	files: Record<string, FileVersion>;
}

export interface CheckpointUpdateRecord {
	version: typeof REWIND_ENTRY_VERSION;
	kind: "update";
	userEntryId: string;
	files: Record<string, FileVersion>;
}

export type CheckpointRecord = CheckpointSnapshotRecord | CheckpointUpdateRecord;

export interface Checkpoint {
	userEntryId: string;
	prompt: string;
	cwd: string;
	timestamp: string;
	files: Record<string, FileVersion>;
}

export interface RestoreResult {
	changedFiles: string[];
	errors: Array<{ path: string; error: string }>;
}
