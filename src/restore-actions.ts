export interface RestoreAction {
	label: string;
	restoreCode: boolean;
	restoreConversation: boolean;
	resetCommits: boolean;
	cancel?: boolean;
}

function countLabel(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

export function buildRestoreActions(filesChanged: number, commitsToReset: number): RestoreAction[] {
	const files = countLabel(filesChanged, "file", "files");
	const commits = countLabel(commitsToReset, "commit", "commits");
	const actions: RestoreAction[] = [];

	if (filesChanged > 0) {
		actions.push({
			label: `Restore code and conversation (${files})`,
			restoreCode: true,
			restoreConversation: true,
			resetCommits: false,
		});
		if (commitsToReset > 0) {
			actions.push({
				label: `Restore code and conversation, and reset ${commits}`,
				restoreCode: true,
				restoreConversation: true,
				resetCommits: true,
			});
		}
		actions.push({
			label: "Restore conversation only",
			restoreCode: false,
			restoreConversation: true,
			resetCommits: false,
		});
		actions.push({
			label: `Restore code only (${files})`,
			restoreCode: true,
			restoreConversation: false,
			resetCommits: false,
		});
		if (commitsToReset > 0) {
			actions.push({
				label: `Restore code and reset ${commits}`,
				restoreCode: true,
				restoreConversation: false,
				resetCommits: true,
			});
		}
	} else {
		actions.push({
			label: "Restore conversation (code already matches)",
			restoreCode: false,
			restoreConversation: true,
			resetCommits: false,
		});
		if (commitsToReset > 0) {
			actions.push(
				{
					label: `Restore conversation and reset ${commits}`,
					restoreCode: true,
					restoreConversation: true,
					resetCommits: true,
				},
				{
					label: `Reset ${commits} only`,
					restoreCode: true,
					restoreConversation: false,
					resetCommits: true,
				},
			);
		}
	}

	actions.push({ label: "Cancel", restoreCode: false, restoreConversation: false, resetCommits: false, cancel: true });
	return actions;
}
