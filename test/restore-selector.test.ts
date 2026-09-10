import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { RestoreSelector, relativeAge } from "../src/restore-selector.ts";
import { buildRestoreActions } from "../src/restore-actions.ts";
import { restoreSummary } from "../src/restore-summary.ts";

const theme = { bold: (text: string) => text, fg: (_: string, text: string) => text } as Theme;

test("confirmation shows context and follows the selected action", () => {
	const actions = buildRestoreActions(1);
	let selected: unknown;
	const selector = new RestoreSelector({
		prompt: "do small change to some file", timestamp: new Date().toISOString(),
		files: ["README.md"], additions: 1, deletions: 1, comparisonErrors: 0,
	}, actions, theme, (action) => { selected = action; });
	const output = selector.render(100).join("\n");
	assert.match(output, /do small change to some file/);
	assert.match(output, /just now/);
	assert.match(output, /code will be restored \(\+1 -1\) in:\n  README.md/);
	selector.handleInput("\u001b[B");
	assert.match(selector.render(100).join("\n"), /current code will be kept/);
	selector.handleInput("\r");
	assert.equal(selected, actions[1]);
	selector.handleInput("\u001b");
	assert.equal(selected, undefined);
	for (const width of [1, 20, 80]) assert.ok(selector.render(width).every((line) => visibleWidth(line) <= width));
});

test("confirmation bounds long content and warns about incomplete comparisons", () => {
	const selector = new RestoreSelector({
		prompt: "long prompt ".repeat(100), timestamp: "invalid",
		files: Array.from({ length: 8 }, (_, i) => `src/${i}.ts`),
		additions: 10, deletions: 3, comparisonErrors: 1,
	}, buildRestoreActions(8), theme, () => {});
	const output = selector.render(80).join("\n");
	assert.match(output, /and 3 more files/);
	assert.match(output, /totals may be incomplete/);
	assert.ok(selector.render(80).length < 30);
});

test("relative age handles old, future, and invalid timestamps", () => {
	const now = Date.parse("2026-01-02T12:00:00Z");
	assert.equal(relativeAge("2026-01-02T11:59:00Z", now), "1m ago");
	assert.equal(relativeAge("2026-01-02T10:00:00Z", now), "2h ago");
	assert.equal(relativeAge("2026-01-01T12:00:00Z", now), "1d ago");
	assert.equal(relativeAge("2027-01-01", now), "just now");
	assert.equal(relativeAge("invalid", now), undefined);
});

test("restore summaries name files and bound long lists and paths", () => {
	assert.equal(restoreSummary({ changedFiles: ["/project/README.md"], errors: [] }, "/project"),
		"1 file restored: README.md");
	const output = restoreSummary({ changedFiles: ["a", "b", "c", "d"].map((f) => `/project/${f}`),
		errors: [{ path: "e", error: "failed" }] }, "/project");
	assert.equal(output, "4 files restored: a, b, c, and 1 more, 1 failed");
	assert.match(restoreSummary({ changedFiles: [`/project/${"x".repeat(100)}`], errors: [] }, "/project"), /\.\.\.$/);
	assert.equal(restoreSummary({ changedFiles: [], errors: [] }, "/project"), "0 files restored");
});
