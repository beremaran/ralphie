import { join } from "node:path";

import { parseRepositorySlug } from "../github/repository.ts";
import { RalphieError } from "../shared/error.ts";
import { resolveWorkspacePath } from "../workspace/workspace.ts";

const safeProjectName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const assertSafeProjectName = (name: string): string => {
  if (
    !safeProjectName.test(name) ||
    name === "." ||
    name === ".." ||
    name.toLowerCase() === ".ralphie"
  ) {
    throw new RalphieError({
      message:
        "Project names must be safe directory names containing only letters, numbers, dots, underscores, and hyphens.",
    });
  }
  return name;
};

export type ProjectRepositoryCheckout = {
  readonly repository: string;
  readonly repositoryPath: string;
  readonly branch: string;
};

export type PreparedProject = {
  readonly name: string;
  readonly path: string;
  readonly repositories: ReadonlyArray<ProjectRepositoryCheckout>;
};

export const multiRepositoryProjectPath = (
  workspace: string,
  project: string,
): string => join(resolveWorkspacePath(workspace), assertSafeProjectName(project));

export const singleRepositoryProjectPath = (
  workspace: string,
  repository: string,
): string => {
  const name = parseRepositorySlug(repository).name;
  if (name.toLowerCase() === ".ralphie") {
    throw new RalphieError({
      message: "Repository name .ralphie conflicts with Ralphie's run data.",
    });
  }
  return join(resolveWorkspacePath(workspace), name);
};

export const projectRepositoryPath = (
  workspace: string,
  project: string,
  repository: string,
): string => {
  const parsed = parseRepositorySlug(repository);
  return join(multiRepositoryProjectPath(workspace, project), parsed.name);
};

export const assertUniqueProjectRepositoryNames = (
  project: string,
  repositories: ReadonlyArray<string>,
): void => {
  const names = repositories.map((repository) =>
    parseRepositorySlug(repository).name.toLowerCase(),
  );
  if (new Set(names).size !== names.length) {
    throw new RalphieError({
      message: `Project ${project} contains repositories with duplicate clone directory names.`,
    });
  }
};
