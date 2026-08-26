import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const REWIND_CONFIG_FILE = "better-pi-rewind.json";

export interface RewindConfig {
	activeRunEscapePresses: 1 | 2;
	escapeWindowMs: number;
}

export const DEFAULT_REWIND_CONFIG: RewindConfig = {
	activeRunEscapePresses: 1,
	escapeWindowMs: 500,
};

function parseConfig(value: unknown, filePath: string): Partial<RewindConfig> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${filePath} must contain a JSON object`);
	}

	const input = value as Record<string, unknown>;
	const config: Partial<RewindConfig> = {};
	if (input.activeRunEscapePresses !== undefined) {
		if (input.activeRunEscapePresses !== 1 && input.activeRunEscapePresses !== 2) {
			throw new Error(`${filePath}: activeRunEscapePresses must be 1 or 2`);
		}
		config.activeRunEscapePresses = input.activeRunEscapePresses;
	}
	if (input.escapeWindowMs !== undefined) {
		if (!Number.isInteger(input.escapeWindowMs) || (input.escapeWindowMs as number) < 50 || (input.escapeWindowMs as number) > 5000) {
			throw new Error(`${filePath}: escapeWindowMs must be an integer from 50 to 5000`);
		}
		config.escapeWindowMs = input.escapeWindowMs as number;
	}
	return config;
}

async function readConfig(filePath: string): Promise<Partial<RewindConfig>> {
	try {
		return parseConfig(JSON.parse(await readFile(filePath, "utf8")), filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

export async function loadRewindConfig(options: {
	agentDir: string;
	cwd: string;
	configDirName: string;
	projectTrusted: boolean;
}): Promise<RewindConfig> {
	const userConfig = await readConfig(join(options.agentDir, REWIND_CONFIG_FILE));
	const projectConfig = options.projectTrusted
		? await readConfig(join(options.cwd, options.configDirName, REWIND_CONFIG_FILE))
		: {};
	return { ...DEFAULT_REWIND_CONFIG, ...userConfig, ...projectConfig };
}
