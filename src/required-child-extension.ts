/**
 * Register pi-cuttle as a required child extension for the parent session (#131).
 *
 * `cuttle/*` are virtual models registered with `pi.registerVirtualModel`. A child inherits the
 * parent's *providers* but not its virtual models, and a foreground child does not load the
 * parent's ambient extensions at all — so a child launched on an inherited `cuttle/local:high`
 * dies at preflight with `Model "cuttle/local:high" not found`, having spent nothing.
 *
 * `pi-subagents` exposes the remedy as a subpath export: the host registers a snapshot of the
 * extensions every child must load, and the launcher carries that snapshot into each child's
 * registry. Registering it here means the router fixes itself, and the operator no longer has to
 * keep an absolute path in sync in `~/.pi/agent/settings.json`.
 *
 * Every failure mode is soft. pi-cuttle does not depend on pi-subagents: if the package is absent,
 * the export is missing, or registration is rejected, the session still starts and the operator's
 * explicit `subagents.defaultSubagentOnlyExtensions` config (documented as the fallback) still
 * works. A router that refuses to load because an optional integration is missing would be a worse
 * bug than the one this fixes.
 */

/** The id pi-subagents records for this extension in `launchResolvedExtensions`. */
export const REQUIRED_CHILD_EXTENSION_ID = "pi-cuttle";

/** The exact child-extension shape pi-subagents' registry accepts. */
export interface RequiredChildExtensionEntry {
	id: string;
	path: string;
}

/** What pi-subagents' dispose handle looks like; only `dispose` is used. */
export interface RequiredChildExtensionHandle {
	dispose(): void;
}

/** The slice of `pi-subagents/required-child-extensions` this module relies on. */
export interface RequiredChildExtensionsModule {
	registerRequiredChildExtensions(input: {
		sessionId: string;
		extensions: readonly RequiredChildExtensionEntry[];
	}): RequiredChildExtensionHandle;
}

/** Injection seam so the registration logic is testable without pi-subagents installed. */
export type RequiredChildExtensionsImporter = () => Promise<RequiredChildExtensionsModule>;

/**
 * A variable specifier, deliberately: a literal would make TypeScript resolve this optional
 * integration at type-check time and fail the repo's `tsc --noEmit` when pi-subagents is not
 * installed. pi-cuttle has no runtime dependency on it.
 */
const PI_SUBAGENTS_MODULE = "pi-subagents/required-child-extensions";

const defaultImporter: RequiredChildExtensionsImporter = async () =>
	(await import(PI_SUBAGENTS_MODULE)) as RequiredChildExtensionsModule;

export interface RegisterRequiredChildExtensionOptions {
	/** The parent session whose children should load the router. */
	sessionId: string;
	/** Absolute path to this extension's entry module. */
	extensionPath: string;
	/** Override the module loader (tests). */
	importer?: RequiredChildExtensionsImporter;
	/** Debug sink; the router is otherwise silent. */
	log?: (message: string) => void;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Register one required-child-extension snapshot for `sessionId`.
 *
 * Returns the dispose handle on success, or `undefined` when registration could not happen —
 * every such path is logged and swallowed, never thrown.
 */
export async function registerRequiredChildExtension(
	options: RegisterRequiredChildExtensionOptions,
): Promise<RequiredChildExtensionHandle | undefined> {
	const { sessionId, extensionPath, importer = defaultImporter, log } = options;
	if (!sessionId) {
		log?.("required-child-extension skipped: no session id");
		return undefined;
	}
	if (!extensionPath) {
		log?.("required-child-extension skipped: no extension path");
		return undefined;
	}
	try {
		const module = await importer();
		if (typeof module?.registerRequiredChildExtensions !== "function") {
			log?.("required-child-extension unavailable: registerRequiredChildExtensions is not a function");
			return undefined;
		}
		const handle = module.registerRequiredChildExtensions({
			sessionId,
			extensions: [{ id: REQUIRED_CHILD_EXTENSION_ID, path: extensionPath }],
		});
		log?.(`required-child-extension registered id=${REQUIRED_CHILD_EXTENSION_ID} path=${extensionPath}`);
		return handle;
	} catch (error) {
		// Missing package, drifted API, rejected path, already-registered session — all soft.
		log?.(`required-child-extension registration failed: ${describe(error)}`);
		return undefined;
	}
}

export interface RequiredChildExtensionController {
	/**
	 * Register for `sessionId`, replacing only that session's previous snapshot.
	 *
	 * A resumed session reuses its id, and pi-subagents rejects a second live registration for the
	 * same id, so that id is disposed first. A different session in the same process is left alone:
	 * dropping it would make the other session's children miss the router again (#131).
	 */
	register(sessionId: string, extensionPath: string): Promise<void>;
	/**
	 * Dispose one session, or every session when `sessionId` is omitted.
	 * Safe to call repeatedly, including for a session that was never registered.
	 */
	dispose(sessionId?: string): void;
}

export function createRequiredChildExtensionController(
	deps: {
		importer?: RequiredChildExtensionsImporter;
		log?: (message: string) => void;
	} = {},
): RequiredChildExtensionController {
	const live = new Map<string, RequiredChildExtensionHandle>();

	const disposeOne = (sessionId: string): void => {
		const handle = live.get(sessionId);
		live.delete(sessionId);
		if (!handle) return;
		try {
			handle.dispose();
		} catch (error) {
			deps.log?.(`required-child-extension dispose failed: ${describe(error)}`);
		}
	};

	return {
		async register(sessionId: string, extensionPath: string): Promise<void> {
			disposeOne(sessionId);
			const handle = await registerRequiredChildExtension({
				sessionId,
				extensionPath,
				...(deps.importer ? { importer: deps.importer } : {}),
				...(deps.log ? { log: deps.log } : {}),
			});
			if (handle) live.set(sessionId, handle);
		},
		dispose(sessionId?: string): void {
			if (sessionId) {
				disposeOne(sessionId);
				return;
			}
			for (const id of [...live.keys()]) disposeOne(id);
		},
	};
}
