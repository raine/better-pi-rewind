import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { RewindSelector } from "../src/rewind-selector.ts";

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as Theme;

test("renders Claude-style rewind entries and selects current", () => {
	const selector = new RewindSelector(
		[
			{ prompt: "change the project", filesChanged: 2, additions: 14, deletions: 3 },
			{ prompt: "inspect the result", filesChanged: 0, additions: 0, deletions: 0 },
			{ prompt: "(current)", filesChanged: 0, additions: 0, deletions: 0, current: true },
		],
		theme,
		() => {},
	);
	const output = selector.render(100).join("\n");

	assert.match(output, /Rewind/);
	assert.match(output, /Restore the code and\/or conversation to the point before/);
	assert.match(output, /2 files changed \+14 -3/);
	assert.match(output, /No code changes/);
	assert.match(output, /❯ \(current\)/);
});
