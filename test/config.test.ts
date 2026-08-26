import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_REWIND_CONFIG, loadRewindConfig, REWIND_CONFIG_FILE } from "../src/config.ts";

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "better-pi-rewind-config-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	return { agentDir, cwd };
}

test("uses default rewind configuration when files are absent", async () => {
	const paths = await setup();
	assert.deepEqual(DEFAULT_REWIND_CONFIG, { activeRunEscapePresses: 1, escapeWindowMs: 500 });
	assert.deepEqual(
		await loadRewindConfig({ ...paths, configDirName: ".pi", projectTrusted: true }),
		DEFAULT_REWIND_CONFIG,
	);
});

test("merges trusted project configuration over user configuration", async () => {
	const paths = await setup();
	await writeFile(join(paths.agentDir, REWIND_CONFIG_FILE), JSON.stringify({ activeRunEscapePresses: 1, escapeWindowMs: 700 }));
	await writeFile(join(paths.cwd, ".pi", REWIND_CONFIG_FILE), JSON.stringify({ escapeWindowMs: 300 }));

	assert.deepEqual(await loadRewindConfig({ ...paths, configDirName: ".pi", projectTrusted: true }), {
		activeRunEscapePresses: 1,
		escapeWindowMs: 300,
	});
	assert.deepEqual(await loadRewindConfig({ ...paths, configDirName: ".pi", projectTrusted: false }), {
		activeRunEscapePresses: 1,
		escapeWindowMs: 700,
	});
});

test("rejects invalid rewind configuration", async () => {
	const paths = await setup();
	await writeFile(join(paths.agentDir, REWIND_CONFIG_FILE), JSON.stringify({ activeRunEscapePresses: 3 }));
	await assert.rejects(
		loadRewindConfig({ ...paths, configDirName: ".pi", projectTrusted: false }),
		/activeRunEscapePresses must be 1 or 2/,
	);
});
