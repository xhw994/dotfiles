/**
 * Flags when gohan re-provisions the managed OMP config or the model catalog
 * gains models, so personal.yml can be reviewed. Runs once, never starts a turn.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = join(homedir(), ".omp", "agent");
const MANAGED = ["config.yml", "models.yml"] as const;
const OVERLAY = join(AGENT_DIR, "personal.yml");
const STATE = join(AGENT_DIR, ".model-drift.json");
const THINKING_SUFFIX = /:(?:off|minimal|low|medium|high|xhigh|max|auto|inherit)$/;

type Snapshot = {
	managed: Record<string, string>;
	roles: string[];
	enabled: string[];
	models: string[];
};

type ModelRow = { provider?: unknown; id?: unknown; selector?: unknown };
type ModelsFacade = { list?: () => unknown[]; resolve?: (spec: string) => unknown };
type ExtensionContext = { agent?: { kind?: unknown }; models?: ModelsFacade };
type ExtensionPi = {
	on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => void;
	sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => void;
	logger?: { warn?: (message: string) => void };
};

const read = (path: string): string => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
};

/** Values of one top-level YAML key, flattened to one entry per scalar or list item. */
function section(text: string, key: string): string[] {
	const out: string[] = [];
	let inside = false;
	for (const line of text.split("\n")) {
		if (/^\S/.test(line)) {
			inside = line.startsWith(`${key}:`);
			continue;
		}
		if (!inside) continue;
		const value = line.trim();
		if (!value || value.startsWith("#")) continue;
		out.push(value.replace(/^-\s*/, ""));
	}
	return out;
}

function shift(before: string[], after: string[]): { added: string[]; removed: string[] } {
	const old = new Set(before);
	const now = new Set(after);
	return { added: after.filter(item => !old.has(item)), removed: before.filter(item => !now.has(item)) };
}

/** `provider/id`, preferring the catalog's own selector spelling. */
function modelLabel(row: unknown): string | undefined {
	if (!row || typeof row !== "object") return undefined;
	const model = row as ModelRow;
	if (typeof model.selector === "string") return model.selector;
	if (typeof model.provider === "string" && typeof model.id === "string") return `${model.provider}/${model.id}`;
	return undefined;
}

function snapshot(models: ModelsFacade | undefined): Snapshot {
	const managed = Object.fromEntries(MANAGED.map(file => [file, read(join(AGENT_DIR, file))]));
	const selectors = (models?.list?.() ?? [])
		.map(modelLabel)
		.filter((label): label is string => Boolean(label))
		.sort();
	return {
		managed: Object.fromEntries(Object.entries(managed).map(([file, text]) => [file, createHash("sha256").update(text).digest("hex")])),
		roles: section(managed["config.yml"], "modelRoles"),
		enabled: section(managed["config.yml"], "enabledModels"),
		models: selectors,
	};
}

function summary(label: string, list: string[]): string {
	const preview = list.slice(0, 2).join(", ");
	const more = list.length > 2 ? `, +${list.length - 2}` : "";
	return `${label}: ${list.length}${preview ? ` (${preview}${more})` : ""}`;
}

export default function modelDrift(pi: ExtensionPi): void {
	let reported = false;

	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx?.agent?.kind !== "main" || reported) return undefined;
		try {
			const now = snapshot(ctx?.models);
			const previous = (() => {
				try {
					return JSON.parse(readFileSync(STATE, "utf8")) as Snapshot;
				} catch {
					return undefined;
				}
			})();
			if (!previous) {
				writeFileSync(STATE, JSON.stringify(now, null, 2));
				return undefined;
			}

			const notes: string[] = [];
			const roles = shift(previous.roles, now.roles);
			const enabled = shift(previous.enabled, now.enabled);
			const catalogue = shift(previous.models, now.models);

			for (const file of MANAGED) {
				if (previous.managed?.[file] && previous.managed[file] !== now.managed[file]) {
					notes.push(`- ${file}: rewritten by gohan`);
				}
			}
			if (roles.added.length || roles.removed.length) {
				notes.push(`- baseline modelRoles: +${roles.added.length} / -${roles.removed.length}`);
				for (const line of [...roles.added, ...roles.removed].slice(0, 6)) notes.push(`    ${line}`);
			}
			if (enabled.added.length || enabled.removed.length) {
				notes.push(`- enabledModels: +${enabled.added.length} / -${enabled.removed.length}`);
				for (const line of [...enabled.added, ...enabled.removed].slice(0, 6)) notes.push(`    ${line}`);
			}
			if (catalogue.added.length) notes.push(`- ${summary("new models available", catalogue.added)}`);
			if (catalogue.removed.length) notes.push(`- ${summary("models gone", catalogue.removed)}`);

			const broken = section(read(OVERLAY), "modelRoles")
				.map(line => line.slice(line.indexOf(":") + 1).trim())
				.filter(selector => selector && !ctx?.models?.resolve?.(selector.replace(THINKING_SUFFIX, "")));
			if (broken.length) notes.push(`- overlay selectors that no longer resolve: ${broken.join(", ")}`);

			if (!notes.length) {
				writeFileSync(STATE, JSON.stringify(now, null, 2));
				return undefined;
			}

			notes.push(
				"",
				"Review unix/omp/personal.yml in ~/dotfiles (installed as ~/.omp/agent/personal.yml)",
				"against the new catalog: a pinned model may be superseded, repriced, or dropped.",
				broken.length ? "This notice repeats until every overlay selector resolves." : "Snapshot updated; this notice fires once per change.",
			);
			reported = true;
			// Commit immediately: turn_end does not fire in every mode, and a stale
			// snapshot only costs one extra notice.
			if (!broken.length) writeFileSync(STATE, JSON.stringify(now, null, 2));
			return {
				message: {
					customType: "model-drift",
					content: ["gohan's managed OMP config moved.", ...notes].join("\n"),
					display: true,
					attribution: "system",
				},
			};
		} catch (error) {
			pi.logger?.warn?.(`model-drift hook failed: ${String(error)}`);
			return undefined;
		}
	});
}
