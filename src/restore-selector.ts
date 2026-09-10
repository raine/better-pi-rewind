import type { Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { RestoreAction } from "./restore-actions.ts";

export interface RestoreDetails {
	prompt: string;
	timestamp: string;
	files: string[];
	additions: number;
	deletions: number;
	comparisonErrors: number;
}

export function relativeAge(timestamp: string, now = Date.now()): string | undefined {
	const time = Date.parse(timestamp);
	if (!Number.isFinite(time)) return undefined;
	const seconds = Math.max(0, Math.floor((now - time) / 1000));
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}

export class RestoreSelector implements Component {
	private readonly list: SelectList;
	private readonly details: RestoreDetails;
	private readonly actions: RestoreAction[];
	private readonly theme: Theme;

	constructor(
		details: RestoreDetails,
		actions: RestoreAction[],
		theme: Theme,
		done: (action: RestoreAction | undefined) => void,
	) {
		this.details = details;
		this.actions = actions;
		this.theme = theme;
		this.list = new SelectList(actions.map((action, index) => ({
			value: String(index), label: `${index + 1}. ${action.label}`,
		})), actions.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		this.list.onSelect = (item) => done(actions[Number(item.value)]);
		this.list.onCancel = () => done(undefined);
	}

	invalidate(): void { this.list.invalidate(); }
	handleInput(data: string): void { this.list.handleInput(data); }

	render(width: number): string[] {
		const { details, theme } = this;
		const action = this.actions[Number(this.list.getSelectedItem()?.value)];
		const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(1, width));
		const prompt = wrapTextWithAnsi(details.prompt.replace(/\s+/g, " ").trim(), Math.max(1, width - 4));
		const age = relativeAge(details.timestamp);
		const lines = [
			"", theme.bold(theme.fg("accent", "Rewind")), "",
			...wrap("Confirm you want to restore to the point before you sent this message:"), "",
			...prompt.slice(0, 4).map((line) => `${theme.fg("muted", "│")} ${line}`),
			...(prompt.length > 4 ? [theme.fg("muted", "│ ...")] : []),
			...(age ? [theme.fg("muted", `│ (${age})`)] : []), "",
		];
		if (action?.cancel) {
			lines.push(theme.fg("muted", "Nothing will be changed."));
		} else {
			lines.push(...wrap(theme.fg("muted", action?.restoreConversation
				? "The conversation will be rewound to this point."
				: "The conversation will be kept.")));
			if (action?.restoreCode && details.files.length > 0) {
				const stats = `${theme.fg("success", `+${details.additions}`)} ${theme.fg("error", `-${details.deletions}`)}`;
				lines.push(...wrap(`The code will be restored (${stats}) in:`));
				lines.push(...details.files.slice(0, 5).map((file) => theme.fg("muted", `  ${file}`)));
				if (details.files.length > 5) lines.push(theme.fg("muted", `  and ${details.files.length - 5} more files`));
			} else {
				lines.push(theme.fg("muted", details.files.length === 0
					? "Checkpointed code already matches." : "The current code will be kept."));
			}
			lines.push(...wrap(theme.fg(action?.resetGit ? "warning" : "muted", action?.resetGit
				? "Git history will be reset after an additional confirmation."
				: "Git history will be kept.")));
		}
		if (details.comparisonErrors > 0) lines.push(...wrap(theme.fg("warning", "Some files could not be compared. Change totals may be incomplete.")));
		lines.push("", ...this.list.render(Math.max(4, width)), "", ...wrap(theme.fg("dim", "↑↓ navigate  enter select  esc/ctrl+c cancel")));
		return lines.map((line) => truncateToWidth(line, Math.max(0, width), ""));
	}
}
