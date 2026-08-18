import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface BeforeBranchEvent {
	entryId: string;
}

interface BeforeForkEvent extends BeforeBranchEvent {
	position: "before" | "after";
}

interface BranchResult {
	cancelled: boolean;
}

interface OmpCommandContext {
	branch(entryId: string): Promise<BranchResult>;
}

interface PiCommandContext {
	navigateTree(entryId: string): Promise<BranchResult>;
}

type BeforeBranchHandler = (
	event: BeforeBranchEvent,
	ctx: ExtensionContext,
) => Promise<{ cancel?: boolean } | undefined>;

type EventApi = {
	on(
		event: string,
		handler: (event: BeforeForkEvent | BeforeBranchEvent, ctx: ExtensionContext) => Promise<{ cancel?: boolean } | undefined>,
	): void;
};

export function registerBeforeBranchHandler(pi: ExtensionAPI, handler: BeforeBranchHandler): void {
	const events = pi as unknown as EventApi;
	events.on("session_before_fork", async (event, ctx) => {
		const forkEvent = event as BeforeForkEvent;
		if (forkEvent.position !== "before") return undefined;
		return handler(forkEvent, ctx);
	});
	events.on("session_before_branch", handler);
}

export async function rewindConversation(
	ctx: ExtensionCommandContext,
	entryId: string,
	prompt: string,
	notification: string,
	notificationType: "info" | "warning",
): Promise<BranchResult> {
	const candidate = ctx as ExtensionCommandContext & {
		navigateTree?: PiCommandContext["navigateTree"];
		branch?: OmpCommandContext["branch"];
	};
	if (typeof candidate.navigateTree === "function") {
		const result = await candidate.navigateTree(entryId);
		if (!result.cancelled) {
			ctx.ui.setEditorText(prompt);
			ctx.ui.notify(notification, notificationType);
		}
		return result;
	}
	if (typeof candidate.branch === "function") {
		return candidate.branch(entryId);
	}
	throw new Error("The host does not provide an in-place conversation navigation API");
}
