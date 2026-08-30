import type { GitResetTarget } from "./git-history.ts";

export interface RestoreAction {
	label: string;
	restoreCode: boolean;
	restoreConversation: boolean;
	resetGit: boolean;
	cancel?: boolean;
}

function countLabel(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

export function gitResetActionLabel(target: GitResetTarget, capitalize = false): string {
	const label = target.kind === "amended-commit"
		? "roll back amended commit"
		: `reset ${countLabel(target.commitCount, "commit", "commits")}`;
	return capitalize ? `${label[0]!.toUpperCase()}${label.slice(1)}` : label;
}

export function buildRestoreActions(filesChanged: number, resetTarget?: GitResetTarget): RestoreAction[] {
	const files = countLabel(filesChanged, "file", "files");
	const reset = resetTarget ? gitResetActionLabel(resetTarget) : undefined;
	const actions: RestoreAction[] = [];

	if (filesChanged > 0) {
		actions.push({
			label: `Restore code and conversation (${files})`,
			restoreCode: true,
			restoreConversation: true,
			resetGit: false,
		});
		if (reset) {
			actions.push({
				label: `Restore code and conversation, and ${reset}`,
				restoreCode: true,
				restoreConversation: true,
				resetGit: true,
			});
		}
		actions.push({
			label: "Restore conversation only",
			restoreCode: false,
			restoreConversation: true,
			resetGit: false,
		});
		actions.push({
			label: `Restore code only (${files})`,
			restoreCode: true,
			restoreConversation: false,
			resetGit: false,
		});
		if (reset) {
			actions.push({
				label: `Restore code and ${reset}`,
				restoreCode: true,
				restoreConversation: false,
				resetGit: true,
			});
		}
	} else {
		actions.push({
			label: "Restore conversation (code already matches)",
			restoreCode: false,
			restoreConversation: true,
			resetGit: false,
		});
		if (resetTarget && reset) {
			actions.push(
				{
					label: `Restore conversation and ${reset}`,
					restoreCode: true,
					restoreConversation: true,
					resetGit: true,
				},
				{
					label: `${gitResetActionLabel(resetTarget, true)} only`,
					restoreCode: true,
					restoreConversation: false,
					resetGit: true,
				},
			);
		}
	}

	actions.push({ label: "Cancel", restoreCode: false, restoreConversation: false, resetGit: false, cancel: true });
	return actions;
}
