import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A schema written where a CLI can read it, removed after the turn. */
export type SchemaFile = {
    readonly path: string;
    readonly dispose: () => Promise<void>;
};

/** Writes a JSON Schema document to a file for CLIs that take a path. */
export type SchemaFileWriter = {
    readonly write: (json: string) => Promise<SchemaFile>;
};

/** Schema files in a private temporary directory. */
export const makeTemporarySchemaFileWriter = (): SchemaFileWriter => ({
    write: async (json) => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-schema-"));
        const path = join(directory, "schema.json");
        await writeFile(path, json, "utf8");
        return {
            path,
            dispose: () => rm(directory, { recursive: true, force: true }),
        };
    },
});