function addPath(paths: Set<string>, value: unknown): void {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return;
	paths.add(trimmed);
}

function unquotePath(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function toolInputPaths(toolName: string, input: unknown): string[] {
	if (toolName !== "edit" && toolName !== "write") return [];
	if (typeof input !== "object" || input === null) return [];
	const record = input as Record<string, unknown>;
	const paths = new Set<string>();
	addPath(paths, record.path);

	if (toolName === "edit" && Array.isArray(record.edits)) {
		for (const edit of record.edits) {
			if (typeof edit === "object" && edit !== null) {
				addPath(paths, (edit as Record<string, unknown>).rename);
			}
		}
	}

	const editInput = record.input;
	if (toolName !== "edit" || typeof editInput !== "string") return [...paths];

	for (const match of editInput.matchAll(/^\[(.+)#[0-9a-f]{4}\]\s*$/gim)) {
		addPath(paths, match[1]);
	}
	for (const match of editInput.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gim)) {
		addPath(paths, match[1]);
	}
	for (const match of editInput.matchAll(/^\*\*\* Move to:\s*(.+?)\s*$/gim)) {
		addPath(paths, match[1]);
	}
	for (const match of editInput.matchAll(/^MV\s+(.+?)\s*$/gim)) {
		addPath(paths, unquotePath(match[1] ?? ""));
	}
	return [...paths];
}
