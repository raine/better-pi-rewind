import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	truncateToWidth,
	type Component,
} from "@earendil-works/pi-tui";

export interface RewindSelectorItem {
	id?: string;
	prompt: string;
	filesChanged: number;
	additions: number;
	deletions: number;
	current?: boolean;
}

export class RewindSelector implements Component {
	private selectedIndex: number;
	private readonly maxVisible = 8;
	private readonly items: RewindSelectorItem[];
	private readonly theme: Theme;
	private readonly done: (item: RewindSelectorItem | undefined) => void;

	constructor(
		items: RewindSelectorItem[],
		theme: Theme,
		done: (item: RewindSelectorItem | undefined) => void,
	) {
		this.items = items;
		this.theme = theme;
		this.done = done;
		this.selectedIndex = Math.max(0, items.length - 1);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = [
			"",
			this.theme.bold(this.theme.fg("accent", "Rewind")),
			"",
			"Restore the code and/or conversation to the point before...",
			"",
		];
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.items.length - this.maxVisible),
		);
		const endIndex = Math.min(this.items.length, startIndex + this.maxVisible);

		for (let index = startIndex; index < endIndex; index += 1) {
			const item = this.items[index];
			if (!item) continue;
			const selected = index === this.selectedIndex;
			const cursor = selected ? this.theme.fg("accent", "❯ ") : "  ";
			const label = item.current ? "(current)" : item.prompt.replace(/\s+/g, " ").trim();
			const availableWidth = Math.max(1, width - 2);
			const text = truncateToWidth(label, availableWidth, "...");
			lines.push(cursor + (selected ? this.theme.bold(this.theme.fg("accent", text)) : text));

			if (!item.current) {
				const stats = item.filesChanged === 0
					? "No code changes"
					: `${item.filesChanged} ${item.filesChanged === 1 ? "file" : "files"} changed ${this.theme.fg("success", `+${item.additions}`)} ${this.theme.fg("error", `-${item.deletions}`)}`;
				lines.push(`  ${this.theme.fg("muted", stats)}`);
			}
			lines.push("");
		}

		if (startIndex > 0 || endIndex < this.items.length) {
			lines.push(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.items.length})`));
		}
		return lines;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			this.done(this.items[this.selectedIndex]);
		} else if (keybindings.matches(data, "tui.select.cancel")) {
			this.done(undefined);
		}
	}
}
