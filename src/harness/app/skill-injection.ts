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
};

type Layout = {
    readonly skillsRoot: string;
    readonly shadowRoot: string;
    readonly docsRoot: string;
    readonly excludes: readonly string[];
};

const layoutFor = (directory: string, location: string): Layout => {
    const parent = dirname(location);
    return {
        skillsRoot: join(directory, location),
        shadowRoot: join(directory, parent, SHADOW_DIRECTORY),
        docsRoot: join(directory, "docs", "agents"),
        excludes: [`/${location}/`, `/${parent}/${SHADOW_DIRECTORY}/`],
    };
};

type Undo = Array<() => Promise<void>>;

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
        await fileSystem.makeDirectory(layout.shadowRoot);
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
    docsRoot: string,
    docs: readonly GeneratedDoc[],
    undo: Undo,
): Promise<void> => {
    for (const doc of docs) {
        const file = join(docsRoot, doc.name);
        await fileSystem.makeDirectory(docsRoot);
        await fileSystem.writeText(file, doc.contents);
        undo.push(async () => await fileSystem.remove(file));
    }
};

/**
 * Make Ralphie's skills visible to a harness session.
 *
 * Skills are copied into the harness's project skills directory. A repository
 * skill with the same name is moved aside for the session and restored on
 * release, so Ralphie's copy wins while other repository skills stay
 * available. Everything added is listed in `.git/info/exclude`. Generated
 * `docs/agents` files exist only where the repository lacks its own.
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
        await fileSystem.makeDirectory(layout.skillsRoot);
        for (const name of await skillNames(fileSystem, deps.skillsDirectory)) {
            await injectSkill(
                fileSystem,
                layout,
                join(deps.skillsDirectory, name),
                name,
                undo,
            );
        }
        await writeDocs(fileSystem, layout.docsRoot, missingDocs, undo);
    };
    return async ({ directory, harness }) => {
        const location = skillLocation(harness);
        if (location === undefined) return async () => {};
        const undo: Undo = [];
        const release: Release = async () => {
            for (const step of undo.splice(0).reverse()) await step();
        };
        try {
            await prepare(directory, location, undo);
            return release;
        } catch (error) {
            await release();
            throw error;
        }
    };
};