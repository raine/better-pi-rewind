import { stripVTControlCharacters } from "node:util";
import { relative } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { RestoreResult } from "./types.ts";

export function restoreSummary(result: RestoreResult, cwd: string): string {
	const count = result.changedFiles.length;
	const names = result.changedFiles.slice(0, 3).map((file) =>
		stripVTControlCharacters(truncateToWidth((relative(cwd, file) || file).replace(/\s+/g, " "), 40, "...")));
	if (count > 3) names.push(`and ${count - 3} more`);
	const files = names.length > 0 ? `: ${names.join(", ")}` : "";
	const errors = result.errors.length > 0 ? `, ${result.errors.length} failed` : "";
	return `${count} ${count === 1 ? "file" : "files"} restored${files}${errors}`;
}
