/** Checkout paths use forward slashes; keeps this module free of node:path. */
const join = (...parts: readonly string[]): string => parts.join("/");

const dirname = (path: string): string => path.slice(0, path.lastIndexOf("/"));

/** The five triage roles the generated label table covers. */
const LABEL_ROLES = [
    "needs-triage",
    "needs-info",
    "ready-for-agent",
    "ready-for-human",
    "wontfix",
] as const;

export type TriageLabels = Readonly<
    Record<(typeof LABEL_ROLES)[number], string>
>;

/** File-system operations skill injection needs; implemented in `adapters/`. */
export type SkillFileSystem = {
    readonly exists: (path: string) => Promise<boolean>;
    /** Names of the immediate subdirectories, empty when the path is absent. */
    readonly listDirectories: (path: string) => Promise<readonly string[]>;
    readonly copyTree: (from: string, to: string) => Promise<void>;
    readonly move: (from: string, to: string) => Promise<void>;
    readonly remove: (path: string) => Promise<void>;
    readonly makeDirectory: (path: string) => Promise<void>;
    readonly writeText: (path: string, contents: string) => Promise<void>;
    /** File contents, or `undefined` when the file is absent. */
    readonly readText: (path: string) => Promise<string | undefined>;
};

/** Where each harness discovers project skills, relative to the checkout. */
const SKILL_LOCATIONS: Readonly<Record<string, string>> = {
    claude: ".claude/skills",
    codex: ".agents/skills",
    pi: ".pi/skills",
    opencode: ".opencode/skills",
};

/** The project skills directory of a harness, or undefined when unknown. */
export const skillLocation = (harness: string): string | undefined =>
    SKILL_LOCATIONS[harness];

/** Where a displaced repository skill waits until the session ends. */
const SHADOW_DIRECTORY = ".ralphie-shadowed";

/**
 * How a prompt invokes a user-only skill in each harness: `/name`, `$name`
 * or `/skill:name`. OpenCode has no user syntax for skills, so it names the
 * skill for the model's own skill tool.
 */
export const skillInvocation = (harness: string, name: string): string => {
    switch (harness) {
        case "claude":
            return `/${name}`;
        case "codex":
            return `$${name}`;
        case "pi":
            return `/skill:${name}`;
        default:
            return `the ${name} skill`;
    }
};

const TRACKER_DOC = `# Issue tracker

Ralphie supplies the issue content in the prompt. Work from that text.

Do not use the \`gh\` CLI or any other tool to read, create, comment on, label
or close issues, and do not call the GitHub API. Ralphie performs every
change to the tracker itself.
`;

const labelsDoc = (labels: TriageLabels): string =>
    [
        "# Triage labels",
        "",
        "Skills speak in terms of five canonical triage roles. This table maps each role to the label used in this repository.",
        "",
        "| Role | Label in this tracker |",
        "| --- | --- |",
        ...LABEL_ROLES.map((role) => `| \`${role}\` | \`${labels[role]}\` |`),
        "",
        "When a skill mentions a role, use the corresponding label string.",
        "",
    ].join("\n");

/** Undoes a session's changes to the checkout. */
export type Release = () => Promise<void>;

export type SessionPreparation = (input: {
    readonly directory: string;
    readonly harness: string;
}) => Promise<Release>;

type Dependencies = {
    readonly fileSystem: SkillFileSystem;
    /** Directory whose subdirectories are skills (each holds a SKILL.md). */
    readonly skillsDirectory: string;
    readonly labels: TriageLabels;
};

const skillNames = async (
    fileSystem: SkillFileSystem,
    directory: string,
): Promise<readonly string[]> => {
    const found: string[] = [];
    for (const name of await fileSystem.listDirectories(directory)) {
        if (await fileSystem.exists(join(directory, name, "SKILL.md"))) {
            found.push(name);
        }
    }
    return found;
};

/** Add entries to the checkout's local exclude list so they are never staged. */
const exclude = async (
    fileSystem: SkillFileSystem,
    directory: string,
    entries: readonly string[],
): Promise<void> => {
    const infoDirectory = join(directory, ".git", "info");
    const file = join(infoDirectory, "exclude");
    const current = (await fileSystem.readText(file)) ?? "";
    const present = new Set(current.split("\n"));
    const missing = entries.filter((entry) => !present.has(entry));
    if (missing.length === 0) return;
    await fileSystem.makeDirectory(infoDirectory);
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    await fileSystem.writeText(
        file,
        `${current}${separator}${missing.join("\n")}\n`,
    );
};

/** Put back repository skills that an interrupted session displaced. */
const recoverShadowed = async (
    fileSystem: SkillFileSystem,
    shadowRoot: string,
    skillsRoot: string,
): Promise<void> => {
    for (const name of await fileSystem.listDirectories(shadowRoot)) {
        const target = join(skillsRoot, name);
        await fileSystem.remove(target);
        await fileSystem.move(join(shadowRoot, name), target);
    }
    await removeIfEmpty(fileSystem, shadowRoot);
};

type Layout = {
    readonly directory: string;
    readonly skillsRoot: string;
    readonly shadowRoot: string;
    readonly docsRoot: string;
    readonly excludes: readonly string[];
};

const layoutFor = (directory: string, location: string): Layout => {
    const parent = dirname(location);
    return {
        directory,
        skillsRoot: join(directory, location),
        shadowRoot: join(directory, parent, SHADOW_DIRECTORY),
        docsRoot: join(directory, "docs", "agents"),
        excludes: [`/${location}/`, `/${parent}/${SHADOW_DIRECTORY}/`],
    };
};

type Undo = Array<() => Promise<void>>;

/** Run recorded undo steps newest first, emptying the list. */
const undoAll = async (undo: Undo): Promise<void> => {
    for (const step of undo.splice(0).reverse()) await step();
};

/** Remove a directory Ralphie created, once nothing is left in it. */
const removeIfEmpty = async (
    fileSystem: SkillFileSystem,
    path: string,
): Promise<void> => {
    if ((await fileSystem.listDirectories(path)).length === 0) {
        await fileSystem.remove(path);
    }
};

/**
 * Create a directory and any missing parents inside the checkout, recording
 * undo steps that remove the ones Ralphie made, once they are empty again.
 */
const ensureDirectory = async (
    fileSystem: SkillFileSystem,
    layout: Layout,
    path: string,
    undo: Undo,
): Promise<void> => {
    const missing: string[] = [];
    for (
        let current = path;
        current.length > layout.directory.length &&
        !(await fileSystem.exists(current));
        current = dirname(current)
    ) {
        missing.push(current);
    }
    await fileSystem.makeDirectory(path);
    for (const created of missing.reverse()) {
        undo.push(async () => await removeIfEmpty(fileSystem, created));
    }
};

type GeneratedDoc = { readonly name: string; readonly contents: string };

/** Copy one skill in, setting a same-named repository skill aside first. */
const injectSkill = async (
    fileSystem: SkillFileSystem,
    layout: Layout,
    source: string,
    name: string,
    undo: Undo,
): Promise<void> => {
    const target = join(layout.skillsRoot, name);
    if (await fileSystem.exists(target)) {
        const shadowed = join(layout.shadowRoot, name);
        await ensureDirectory(fileSystem, layout, layout.shadowRoot, undo);
        await fileSystem.move(target, shadowed);
        undo.push(async () => {
            await fileSystem.remove(target);
            await fileSystem.move(shadowed, target);
        });
    } else {
        undo.push(async () => await fileSystem.remove(target));
    }
    await fileSystem.copyTree(source, target);
};

/** The generated docs the repository does not already have. */
const missingDocsIn = async (
    fileSystem: SkillFileSystem,
    docsRoot: string,
    docs: readonly GeneratedDoc[],
): Promise<readonly GeneratedDoc[]> => {
    const missing: GeneratedDoc[] = [];
    for (const doc of docs) {
        if (!(await fileSystem.exists(join(docsRoot, doc.name)))) {
            missing.push(doc);
        }
    }
    return missing;
};

const writeDocs = async (
    fileSystem: SkillFileSystem,
    layout: Layout,
    docs: readonly GeneratedDoc[],
    undo: Undo,
): Promise<void> => {
    for (const doc of docs) {
        const file = join(layout.docsRoot, doc.name);
        await ensureDirectory(fileSystem, layout, layout.docsRoot, undo);
        await fileSystem.writeText(file, doc.contents);
        undo.push(async () => await fileSystem.remove(file));
    }
};

type Prepared = {
    /** Sessions currently holding this directory's preparation. */
    holders: number;
    /** Locations already prepared; later sessions reuse them. */
    readonly locations: Set<string>;
    /** Every change made, undone by the last release. */
    readonly undo: Undo;
};

/**
 * Make Ralphie's skills visible to a harness session.
 *
 * Skills are copied into the harness's project skills directory. A repository
 * skill with the same name is moved aside for the session and restored on
 * release, so Ralphie's copy wins while other repository skills stay
 * available. Everything added is listed in `.git/info/exclude`. Generated
 * `docs/agents` files exist only where the repository lacks its own.
 *
 * Sessions may overlap in one working directory (parallel reviewers). The
 * first prepares, later ones reuse that preparation, and the last release
 * restores the checkout. Work per directory is serialised, so preparation
 * and restoration never interleave.
 */
export const makeSessionPreparation = (
    deps: Dependencies,
): SessionPreparation => {
    const { fileSystem } = deps;
    const generatedDocs: readonly GeneratedDoc[] = [
        { name: "issue-tracker.md", contents: TRACKER_DOC },
        { name: "triage-labels.md", contents: labelsDoc(deps.labels) },
    ];
    const prepare = async (
        directory: string,
        location: string,
        undo: Undo,
    ): Promise<void> => {
        const layout = layoutFor(directory, location);
        await recoverShadowed(fileSystem, layout.shadowRoot, layout.skillsRoot);
        const missingDocs = await missingDocsIn(
            fileSystem,
            layout.docsRoot,
            generatedDocs,
        );
        await exclude(fileSystem, directory, [
            ...layout.excludes,
            ...missingDocs.map((doc) => `/docs/agents/${doc.name}`),
        ]);
        if (!(await fileSystem.exists(layout.skillsRoot))) {
            await fileSystem.makeDirectory(layout.skillsRoot);
            undo.push(
                async () => await removeIfEmpty(fileSystem, layout.skillsRoot),
            );
        }
        for (const name of await skillNames(fileSystem, deps.skillsDirectory)) {
            await injectSkill(
                fileSystem,
                layout,
                join(deps.skillsDirectory, name),
                name,
                undo,
            );
        }
        await writeDocs(fileSystem, layout, missingDocs, undo);
    };
    const states = new Map<string, Prepared>();
    const tails = new Map<string, Promise<unknown>>();
    /** Run `work` after everything queued earlier for the same directory. */
    const serialised = async <T>(
        directory: string,
        work: () => Promise<T>,
    ): Promise<T> => {
        const result = (tails.get(directory) ?? Promise.resolve()).then(
            work,
            work,
        );
        const tail = result.catch(() => {});
        tails.set(directory, tail);
        void tail.then(() => {
            if (tails.get(directory) === tail) tails.delete(directory);
        });
        return await result;
    };
    const acquire = async (directory: string, location: string) => {
        const state = states.get(directory) ?? {
            holders: 0,
            locations: new Set<string>(),
            undo: [],
        };
        if (!state.locations.has(location)) {
            const undo: Undo = [];
            try {
                await prepare(directory, location, undo);
            } catch (error) {
                await undoAll(undo);
                throw error;
            }
            state.undo.push(...undo);
            state.locations.add(location);
        }
        state.holders += 1;
        states.set(directory, state);
    };
    const drop = async (directory: string): Promise<void> => {
        const state = states.get(directory);
        if (state === undefined) return;
        state.holders -= 1;
        if (state.holders > 0) return;
        states.delete(directory);
        await undoAll(state.undo);
    };
    return async ({ directory, harness }) => {
        const location = skillLocation(harness);
        if (location === undefined) return async () => {};
        await serialised(directory, () => acquire(directory, location));
        let released = false;
        return async () => {
            if (released) return;
            released = true;
            await serialised(directory, () => drop(directory));
        };
    };
};