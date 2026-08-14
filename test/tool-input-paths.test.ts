import assert from "node:assert/strict";
import test from "node:test";
import { toolInputPaths } from "../src/tool-input-paths.ts";

test("extracts Pi and OMP edit paths", () => {
	assert.deepEqual(toolInputPaths("edit", { path: "src/direct.ts" }), ["src/direct.ts"]);
	assert.deepEqual(
		toolInputPaths("edit", {
			input: [
				"*** Begin Patch",
				"[src/first.ts#A1B2]",
				"PUT 1.=1:",
				"+changed",
				"MV 'src/moved first.ts'",
				"[src/second.ts#c3d4]",
				"CUT 2.=2",
				"*** End Patch",
			].join("\n"),
		}),
		["src/first.ts", "src/second.ts", "src/moved first.ts"],
	);
	assert.deepEqual(
		toolInputPaths("edit", {
			input: [
				"*** Begin Patch",
				"*** Update File: src/old.ts",
				"*** Move to: src/new.ts",
				"*** Add File: src/created.ts",
				"*** End Patch",
			].join("\n"),
		}),
		["src/old.ts", "src/created.ts", "src/new.ts"],
	);
	assert.deepEqual(
		toolInputPaths("edit", { path: "src/file.ts", edits: [{ rename: "src/renamed.ts" }] }),
		["src/file.ts", "src/renamed.ts"],
	);
});

test("extracts write paths and ignores internal URLs", () => {
	assert.deepEqual(toolInputPaths("write", { path: "notes.txt" }), ["notes.txt"]);
	assert.deepEqual(toolInputPaths("write", { path: "conflict://123" }), []);
	assert.deepEqual(toolInputPaths("bash", { path: "ignored.txt" }), []);
});
