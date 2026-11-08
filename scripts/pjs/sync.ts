#!/usr/bin/env node

// Fork-only tool: rebuilds the `dogfood` worktree from the newest upstream release tag plus the
// branches in `pjs.branch`, builds T3 Code (PJS), and installs it. `--help` is the usage doc.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Bump when a change to the build or install steps should rebuild even if the inputs are unchanged. */
export const TOOL_VERSION = 2;

// Build configuration. Identity values (app id, product name, team id) come from the built
// checkout's packages/shared/src/forkIdentity.ts.
const BUILD = {
  clerkPasskeyRpDomains: "clerk.t3.codes",
  provisioningProfile: ".local/share/t3code-fork/signing/T3_Code_PJS_Developer_ID.provisionprofile",
  notaryKeychainProfile: "notary",
  script: "dist:desktop:dmg:arm64",
} as const;

const IDENTITY_BRANCH = "fork/identity";
const DOGFOOD_BRANCH = "dogfood";
const INSTALL_DIR = "/Applications";
const BRANCH_KEY = "pjs.branch";
const TRAIN_KEY = "pjs.train";

class SyncCommandError extends Schema.TaggedError<SyncCommandError>()("SyncCommandError", {
  command: Schema.String,
  cwd: Schema.String,
  operation: Schema.Literals(["spawn", "communicate", "exit"]),
  exitCode: Schema.optional(Schema.Number),
  stderr: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const detail = this.stderr?.trim() ? `\n${this.stderr.trim()}` : "";
    const code = this.exitCode === undefined ? "" : ` (exit ${this.exitCode})`;
    return `\`${this.command}\` failed in ${this.cwd} during "${this.operation}"${code}.${detail}`;
  }
}

class SyncSetupError extends Schema.TaggedError<SyncSetupError>()("SyncSetupError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

class SyncFileSystemError extends Schema.TaggedError<SyncFileSystemError>()("SyncFileSystemError", {
  operation: Schema.String,
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Could not ${this.operation} ${this.path}.`;
  }
}

/** Exit code 3 tells a wrapper script the sync needs a conflict resolved, not that it broke. */
class SyncConflictError extends Schema.TaggedError<SyncConflictError>()("SyncConflictError", {
  report: Schema.String,
}) {
  override readonly [Runtime.errorExitCode] = 3;
  override get message(): string {
    return this.report;
  }
}

/** Exit code 4: the build succeeded and waits for the app to quit. */
class SyncInstallBlockedError extends Schema.TaggedError<SyncInstallBlockedError>()(
  "SyncInstallBlockedError",
  { report: Schema.String },
) {
  override readonly [Runtime.errorExitCode] = 4;
  override get message(): string {
    return this.report;
  }
}

const Train = Schema.Literals(["nightly", "stable"]);
type Train = typeof Train.Type;

const TAG_PATTERNS = {
  nightly: /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/,
  stable: /^v(\d+)\.(\d+)\.(\d+)$/,
} as const;

const compareVersions = (left: ReadonlyArray<number>, right: ReadonlyArray<number>) => {
  for (const [index, part] of left.entries()) {
    const difference = part - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/** The newest tag on the train by version order; undefined when no tag matches. */
export const selectBaseTag = (train: Train, tags: ReadonlyArray<string>) => {
  let best: { readonly tag: string; readonly key: ReadonlyArray<number> } | undefined;
  for (const tag of tags) {
    const key = TAG_PATTERNS[train].exec(tag)?.slice(1).map(Number);
    if (key && (!best || compareVersions(key, best.key) > 0)) best = { tag, key };
  }
  return best?.tag;
};

const Flavor = Schema.Literals(["signed", "notarized"]);
type Flavor = typeof Flavor.Type;

const BuildRecord = Schema.Struct({
  toolVersion: Schema.Number,
  flavor: Flavor,
  baseTag: Schema.String,
  baseSha: Schema.String,
  branches: Schema.Array(Schema.Struct({ name: Schema.String, sha: Schema.String })),
  // From the built checkout's forkIdentity.ts, so installing later uses the identity of this build.
  appName: Schema.String,
  bundleId: Schema.String,
  installed: Schema.Boolean,
});
export type BuildRecord = typeof BuildRecord.Type;
export type BuildInputs = Omit<BuildRecord, "appName" | "bundleId" | "installed">;

type SyncAction = "build" | "install" | "up-to-date";

/** A notarized build satisfies a signed request; `installed` is tracked apart from the inputs. */
export const decideAction = (input: {
  readonly last: BuildRecord | undefined;
  readonly current: BuildInputs;
  readonly force: boolean;
  readonly install: boolean;
  readonly appPresent: boolean;
}): { readonly action: SyncAction; readonly reason: string } => {
  const { last, current } = input;
  if (input.force) return { action: "build", reason: "--force" };
  if (!last) return { action: "build", reason: "no earlier build recorded" };
  if (!input.appPresent) return { action: "build", reason: "the built app is missing" };
  if (last.toolVersion !== current.toolVersion)
    return { action: "build", reason: "the sync tool changed" };
  if (last.baseTag !== current.baseTag || last.baseSha !== current.baseSha)
    return { action: "build", reason: `base is now ${current.baseTag}` };
  const heads = (record: BuildInputs) =>
    record.branches.map(({ name, sha }) => `${name}@${sha}`).join("\n");
  if (heads(last) !== heads(current))
    return { action: "build", reason: "the branch list or a branch head changed" };
  if (current.flavor === "notarized" && last.flavor !== "notarized")
    return { action: "build", reason: "the last build was not notarized" };
  if (input.install && !last.installed)
    return { action: "install", reason: "the built app is not installed" };
  return { action: "up-to-date", reason: "base, branch heads, and tool are unchanged" };
};

export const conflictPrompt = (input: {
  readonly projectDir: string;
  readonly dogfoodDir: string;
  readonly baseTag: string;
  readonly branch: string;
  readonly mergedBefore: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
  /** Where the branch left upstream's history; undefined when upstream's head is unknown. */
  readonly upstreamMergeBase: string | undefined;
  readonly rerun: string;
}) =>
  [
    `WARNING: the pjs sync stopped. Branch ${input.branch} does not merge onto ${input.baseTag}, and git rerere has no recorded resolution for ${input.files.length === 1 ? "this file" : "these files"}.`,
    "Nothing was built or installed. Hand an agent this prompt:",
    "",
    "----------------------------------------------------------------",
    "Resolve a merge conflict in my T3 Code fork so the pjs sync can finish.",
    "",
    `Repository: ${input.projectDir} (Worktrunk bare layout: .bare holds the repository, worktrees are sibling folders)`,
    `Dogfood worktree: ${input.dogfoodDir} (branch ${DOGFOOD_BRANCH}; the sync resets it to the base tag and merges the branches in \`git config --get-all ${BRANCH_KEY}\`, in order)`,
    `Base tag: ${input.baseTag}`,
    `Branch that conflicts: ${input.branch}`,
    `Merged before it: ${input.mergedBefore.length > 0 ? input.mergedBefore.join(", ") : "none"}`,
    "Conflicting files:",
    ...input.files.map((file) => `- ${file}`),
    "",
    "git rerere (rerere.enabled; its cache is .bare/rr-cache, shared by every worktree) replays a recorded conflict resolution on later merges. This conflict has no recorded resolution yet.",
    "",
    "What to do:",
    `1. Resolve it in the branch, in the worktree where ${input.branch} is checked out (wt switch ${input.branch}): ${
      input.upstreamMergeBase === undefined
        ? `rebase it onto ${input.baseTag}`
        : `\`git rebase --onto ${input.baseTag} ${input.upstreamMergeBase} ${input.branch}\` (replays only the branch's own commits, not the upstream commits it was cut after)`
    }, fix the conflicts there, and commit.`,
    `   Or resolve it in dogfood so rerere records it. The sync left dogfood at ${input.baseTag} plus the branches merged before ${input.branch}: run \`git -C ${input.dogfoodDir} -c rerere.enabled=true merge refs/heads/${input.branch}\`, fix the conflicted files, \`git add\` them, and \`git commit --no-verify\`.`,
    `2. Rerun the sync: ${input.rerun}`,
    "Do not push, and do not delete branches.",
    "----------------------------------------------------------------",
  ].join("\n");

/** Environment of the desktop build; `undefined` entries are removed from the inherited environment. */
const buildEnvironment = (input: {
  readonly appleTeamId: string;
  readonly provisioningProfile: string;
  readonly notarize: boolean;
}) => ({
  GITHUB_REPOSITORY: undefined,
  T3CODE_DESKTOP_UPDATE_REPOSITORY: undefined,
  T3CODE_DESKTOP_SIGNED: "true",
  T3CODE_APPLE_TEAM_ID: input.appleTeamId,
  T3CODE_MACOS_PROVISIONING_PROFILE: input.provisioningProfile,
  T3CODE_CLERK_PASSKEY_RP_DOMAINS: BUILD.clerkPasskeyRpDomains,
  APPLE_KEYCHAIN_PROFILE: input.notarize ? BUILD.notaryKeychainProfile : undefined,
});

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const commandLine = (command: string, args: ReadonlyArray<string>) => [command, ...args].join(" ");

const capture = Effect.fn("pjsSync.capture")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const context = { command: commandLine(command, args), cwd } as const;
  const child = yield* spawner
    .spawn(ChildProcess.make(command, [...args], { cwd }))
    .pipe(
      Effect.mapError((cause) => new SyncCommandError({ ...context, operation: "spawn", cause })),
    );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collectText(child.stdout), collectText(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) => new SyncCommandError({ ...context, operation: "communicate", cause }),
    ),
  );
  return { exitCode, stdout, stderr };
}, Effect.scoped);

const gitProbe = (cwd: string, args: ReadonlyArray<string>) => capture("git", args, cwd);

export const git = Effect.fn("pjsSync.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const result = yield* gitProbe(cwd, args);
  if (result.exitCode !== 0) {
    return yield* new SyncCommandError({
      command: commandLine("git", args),
      cwd,
      operation: "exit",
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
  return result.stdout.trim();
});

const gitLines = Effect.fn("pjsSync.gitLines")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const output = yield* git(cwd, args);
  return output.split("\n").filter((line) => line.length > 0);
});

/** Runs a long command with its output on the terminal. */
const run = Effect.fn("pjsSync.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env?: Record<string, string | undefined> },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const context = { command: commandLine(command, args), cwd: options.cwd } as const;
  yield* Console.log(`+ ${context.command}`);
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make(command, [...args], {
        cwd: options.cwd,
        ...(options.env ? { env: options.env, extendEnv: true } : {}),
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      }),
    )
    .pipe(
      Effect.map(Number),
      Effect.mapError((cause) => new SyncCommandError({ ...context, operation: "spawn", cause })),
    );
  if (exitCode !== 0) {
    return yield* new SyncCommandError({ ...context, operation: "exit", exitCode });
  }
});

export interface Repository {
  /** The bare repository; its config is shared by every worktree. */
  readonly gitDir: string;
  /** The folder holding `.bare`, `mise.toml`, and the worktrees. */
  readonly projectDir: string;
  readonly dogfoodDir: string;
  readonly scriptPath: string;
  /** The checked-in copy the project folder's `mise.toml` is recreated from. */
  readonly toolchainTemplate: string;
}

const resolveRepository = Effect.fn("pjsSync.resolveRepository")(function* () {
  const path = yield* Path.Path;
  const checkout = yield* path.fromFileUrl(new URL("../..", import.meta.url));
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url));
  const gitDir = yield* git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if ((yield* git(gitDir, ["rev-parse", "--is-bare-repository"])) !== "true") {
    return yield* new SyncSetupError({
      detail: `${gitDir} is not a bare repository. This tool expects the Worktrunk layout: .bare beside the worktrees.`,
    });
  }
  const projectDir = path.dirname(gitDir);
  return {
    gitDir,
    projectDir,
    dogfoodDir: path.join(projectDir, DOGFOOD_BRANCH),
    scriptPath,
    toolchainTemplate: path.join(path.dirname(scriptPath), "toolchain.toml"),
  } satisfies Repository;
});

const readConfigList = Effect.fn("pjsSync.readConfigList")(function* (gitDir: string, key: string) {
  const args = ["config", "--local", "--get-all", key];
  const result = yield* gitProbe(gitDir, args);
  if (result.exitCode === 0) return result.stdout.split("\n").filter((line) => line.length > 0);
  // Exit 1 means the key is unset.
  if (result.exitCode === 1) return [];
  return yield* new SyncCommandError({
    command: commandLine("git", args),
    cwd: gitDir,
    operation: "exit",
    exitCode: result.exitCode,
    stderr: result.stderr,
  });
});

/** The stored list in order; an empty list falls back to the identity branch. */
const readBranches = Effect.fn("pjsSync.readBranches")(function* (gitDir: string) {
  const stored = yield* readConfigList(gitDir, BRANCH_KEY);
  return {
    branches: stored.length > 0 ? stored : [IDENTITY_BRANCH],
    isDefault: stored.length === 0,
  };
});

const writeBranches = Effect.fn("pjsSync.writeBranches")(function* (
  gitDir: string,
  branches: ReadonlyArray<string>,
) {
  // Exit 5 means there was nothing to unset.
  yield* gitProbe(gitDir, ["config", "--local", "--unset-all", BRANCH_KEY]);
  for (const branch of branches) {
    yield* git(gitDir, ["config", "--local", "--add", BRANCH_KEY, branch]);
  }
});

const isTrain = Schema.is(Train);

const readTrain = Effect.fn("pjsSync.readTrain")(function* (gitDir: string) {
  const stored = (yield* readConfigList(gitDir, TRAIN_KEY)).at(-1);
  if (stored === undefined) return { train: "nightly" as Train, isDefault: true };
  if (!isTrain(stored)) {
    return yield* new SyncSetupError({
      detail: `${TRAIN_KEY} is "${stored}"; use "nightly" or "stable" (git config ${TRAIN_KEY} stable).`,
    });
  }
  return { train: stored, isDefault: false };
});

const branchHead = Effect.fn("pjsSync.branchHead")(function* (gitDir: string, branch: string) {
  const result = yield* gitProbe(gitDir, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}^{commit}`,
  ]);
  if (result.exitCode !== 0) {
    return yield* new SyncSetupError({
      detail: `${branch} is not a local branch of ${gitDir}. Create it, or drop it from the list with --remove ${branch}.`,
    });
  }
  return result.stdout.trim();
});

/** Branches whose merge into the base changes nothing were absorbed upstream. The identity branch never is. */
export const findMergedBranches = Effect.fn("pjsSync.findMergedBranches")(function* (
  gitDir: string,
  baseRef: string,
  branches: ReadonlyArray<string>,
) {
  const baseTree = yield* git(gitDir, ["rev-parse", `${baseRef}^{tree}`]);
  const merged: Array<string> = [];
  for (const branch of branches) {
    if (branch === IDENTITY_BRANCH) continue;
    const args = ["merge-tree", "--write-tree", "--no-messages", baseRef, `refs/heads/${branch}`];
    const result = yield* gitProbe(gitDir, args);
    // Exit 1 means the merge conflicts, so the branch still has changes of its own.
    if (result.exitCode > 1) {
      return yield* new SyncCommandError({
        command: commandLine("git", args),
        cwd: gitDir,
        operation: "exit",
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }
    if (result.exitCode === 0 && result.stdout.split("\n")[0] === baseTree) merged.push(branch);
  }
  return merged;
});

/** Upstream's current head: `upstream/HEAD` when set, else `upstream/main`. */
const upstreamHeadRef = Effect.fn("pjsSync.upstreamHeadRef")(function* (gitDir: string) {
  for (const ref of ["refs/remotes/upstream/HEAD", "refs/remotes/upstream/main"]) {
    const result = yield* gitProbe(gitDir, ["rev-parse", "--verify", "--quiet", ref]);
    if (result.exitCode === 0) return ref;
  }
  return undefined;
});

/** Where the branch left upstream's history; undefined without an upstream head or a common ancestor. */
const upstreamMergeBase = Effect.fn("pjsSync.upstreamMergeBase")(function* (
  gitDir: string,
  upstreamRef: string | undefined,
  branch: string,
) {
  if (upstreamRef === undefined) return undefined;
  const result = yield* gitProbe(gitDir, ["merge-base", upstreamRef, `refs/heads/${branch}`]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
});

/**
 * Branches cut from upstream commits newer than the base: merging them brings those commits into
 * dogfood, so the build is not the base plus the branch's own changes.
 */
export const findDriftedBranches = Effect.fn("pjsSync.findDriftedBranches")(function* (
  gitDir: string,
  upstreamRef: string | undefined,
  baseRef: string,
  branches: ReadonlyArray<string>,
) {
  const drifted: Array<{ branch: string; mergeBase: string; commits: number }> = [];
  for (const branch of branches) {
    const mergeBase = yield* upstreamMergeBase(gitDir, upstreamRef, branch);
    if (mergeBase === undefined) continue;
    const args = ["merge-base", "--is-ancestor", mergeBase, baseRef];
    const ancestor = yield* gitProbe(gitDir, args);
    if (ancestor.exitCode === 0) continue;
    if (ancestor.exitCode !== 1) {
      return yield* new SyncCommandError({
        command: commandLine("git", args),
        cwd: gitDir,
        operation: "exit",
        exitCode: ancestor.exitCode,
        stderr: ancestor.stderr,
      });
    }
    const commits = Number(yield* git(gitDir, ["rev-list", "--count", `${baseRef}..${mergeBase}`]));
    drifted.push({ branch, mergeBase, commits });
  }
  return drifted;
});

type MergeResult =
  | {
      readonly _tag: "Merged";
      readonly branches: ReadonlyArray<{ readonly branch: string; readonly replayed: boolean }>;
    }
  | {
      readonly _tag: "Conflict";
      readonly branch: string;
      readonly files: ReadonlyArray<string>;
      readonly mergedBefore: ReadonlyArray<string>;
    };

/**
 * Merges each branch into the checked-out dogfood branch. A stopped merge whose every conflict
 * rerere replayed is committed; any other stopped merge is aborted and reported.
 */
export const mergeBranches = Effect.fn("pjsSync.mergeBranches")(function* (
  dogfoodDir: string,
  branches: ReadonlyArray<string>,
) {
  const merged: Array<{ readonly branch: string; readonly replayed: boolean }> = [];
  for (const branch of branches) {
    const args = [
      "-c",
      "rerere.enabled=true",
      "-c",
      "rerere.autoUpdate=true",
      "merge",
      "--no-edit",
      "--no-verify",
      "-q",
      "-m",
      `Merge branch '${branch}' into ${DOGFOOD_BRANCH}`,
      `refs/heads/${branch}`,
    ];
    const result = yield* gitProbe(dogfoodDir, args);
    if (result.exitCode === 0) {
      merged.push({ branch, replayed: false });
      continue;
    }
    const merging = yield* gitProbe(dogfoodDir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    if (merging.exitCode !== 0) {
      return yield* new SyncCommandError({
        command: commandLine("git", args),
        cwd: dogfoodDir,
        operation: "exit",
        exitCode: result.exitCode,
        stderr: result.stderr || result.stdout,
      });
    }
    const unresolved = yield* gitLines(dogfoodDir, ["diff", "--name-only", "--diff-filter=U"]);
    if (unresolved.length === 0) {
      yield* git(dogfoodDir, ["commit", "--no-edit", "--no-verify", "-q"]);
      merged.push({ branch, replayed: true });
      continue;
    }
    yield* git(dogfoodDir, ["merge", "--abort"]);
    return {
      _tag: "Conflict",
      branch,
      files: unresolved,
      mergedBefore: merged.map((entry) => entry.branch),
    } satisfies MergeResult;
  }
  return { _tag: "Merged", branches: merged } satisfies MergeResult;
});

const fileSystemError = (operation: string, path: string) =>
  Effect.mapError((cause: unknown) => new SyncFileSystemError({ operation, path, cause }));

/** Compares the project folder's mise.toml with the checked-in template. */
export const toolchainStatus = Effect.fn("pjsSync.toolchainStatus")(function* (
  projectDir: string,
  template: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(projectDir, "mise.toml");
  if (!(yield* fs.exists(file).pipe(fileSystemError("check", file)))) return "missing" as const;
  const [current, wanted] = yield* Effect.all([
    fs.readFileString(file).pipe(fileSystemError("read", file)),
    fs.readFileString(template).pipe(fileSystemError("read", template)),
  ]);
  return current === wanted ? ("same" as const) : ("differs" as const);
});

/** Copies the template to the project folder byte for byte and trusts it; never overwrites. */
export const recreateToolchainFile = Effect.fn("pjsSync.recreateToolchainFile")(function* (
  projectDir: string,
  template: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(projectDir, "mise.toml");
  const bytes = yield* fs.readFile(template).pipe(fileSystemError("read", template));
  yield* fs.writeFile(file, bytes, { flag: "wx" }).pipe(fileSystemError("write", file));
  yield* run("mise", ["trust", file], { cwd: projectDir });
});

const statePath = Effect.fn("pjsSync.statePath")(function* () {
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const configured = environment.XDG_STATE_HOME?.trim();
  const stateHome =
    configured && path.isAbsolute(configured) ? configured : path.join(home, ".local/state");
  return path.join(stateHome, "t3code-pjs", "sync.json");
});

const BuildRecordJson = fromJsonStringPretty(BuildRecord);
const decodeBuildRecord = Schema.decodeUnknownEffect(BuildRecordJson);
const encodeBuildRecord = Schema.encodeEffect(BuildRecordJson);

/** An unreadable or outdated state file counts as no earlier build. */
export const readState = Effect.fn("pjsSync.readState")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const record = yield* fs
    .readFileString(file)
    .pipe(Effect.flatMap(decodeBuildRecord), Effect.option);
  return Option.getOrUndefined(record);
});

export const writeState = Effect.fn("pjsSync.writeState")(function* (
  file: string,
  record: BuildRecord,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(file);
  const text = yield* encodeBuildRecord(record).pipe(fileSystemError("encode", file));
  yield* fs
    .makeDirectory(directory, { recursive: true })
    .pipe(fileSystemError("create", directory));
  const staged = `${file}.tmp`;
  yield* fs.writeFileString(staged, `${text}\n`).pipe(fileSystemError("write", staged));
  yield* fs.rename(staged, file).pipe(fileSystemError("replace", file));
});

const isAppRunning = Effect.fn("pjsSync.isAppRunning")(function* (bundleId: string) {
  const args = ["find", `bundleid=${bundleId}`];
  const result = yield* capture("lsappinfo", args, "/");
  if (result.exitCode !== 0) {
    return yield* new SyncCommandError({
      command: commandLine("lsappinfo", args),
      cwd: "/",
      operation: "exit",
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
  return result.stdout.trim().length > 0;
});

/** Moves `staged` to `destination`, keeping the previous app beside it until the move succeeds. */
export const replaceApp = Effect.fn("pjsSync.replaceApp")(function* (
  staged: string,
  destination: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const previous = path.join(path.dirname(staged), "previous.app");
  const hadPrevious = yield* fs.exists(destination).pipe(fileSystemError("check", destination));
  if (hadPrevious) {
    yield* fs.rename(destination, previous).pipe(fileSystemError("move aside", destination));
  }
  yield* fs.rename(staged, destination).pipe(
    fileSystemError("replace", destination),
    Effect.onError(() =>
      hadPrevious ? fs.rename(previous, destination).pipe(Effect.ignore) : Effect.void,
    ),
  );
});

/** Copies the app beside its destination and renames it into place; never replaces a running app. */
export const installApp = Effect.fn("pjsSync.installApp")(function* (
  source: string,
  destinationDir: string,
  identity: { readonly appName: string; readonly bundleId: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const destination = path.join(destinationDir, identity.appName);
  if (yield* isAppRunning(identity.bundleId)) {
    return yield* new SyncInstallBlockedError({
      report: [
        `WARNING: ${identity.appName} is running, so ${destination} was not replaced.`,
        `The new build is at ${source}.`,
        "To finish: quit the app, then rerun this command; it installs the built app without rebuilding.",
      ].join("\n"),
    });
  }
  const stageDir = yield* fs
    .makeTempDirectory({ directory: destinationDir, prefix: ".pjs-install-" })
    .pipe(fileSystemError("create a staging folder in", destinationDir));
  const staged = path.join(stageDir, identity.appName);
  yield* Effect.gen(function* () {
    // ditto keeps symlinks, extended attributes, and the code signature that fs.copy would break.
    yield* run("ditto", [source, staged], { cwd: destinationDir });
    yield* replaceApp(staged, destination);
  }).pipe(
    Effect.ensuring(fs.remove(stageDir, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
  return destination;
});

/** Installs the built app and records it as installed; a refused install leaves the record as built. */
export const installBuilt = Effect.fn("pjsSync.installBuilt")(function* (
  stateFile: string,
  record: BuildRecord,
  source: string,
  destinationDir: string,
) {
  yield* installApp(source, destinationDir, record);
  const installed = { ...record, installed: true };
  yield* writeState(stateFile, installed);
  return installed;
});

export const ensureDogfood = Effect.fn("pjsSync.ensureDogfood")(function* (
  repo: Repository,
  baseTag: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* fs.exists(repo.dogfoodDir).pipe(fileSystemError("check", repo.dogfoodDir));
  if (exists) {
    const registered = (yield* gitLines(repo.gitDir, ["worktree", "list", "--porcelain"]))
      .filter((line) => line.startsWith("worktree "))
      .map((line) => path.resolve(line.slice("worktree ".length)));
    if (!registered.includes(repo.dogfoodDir)) {
      return yield* new SyncSetupError({
        detail: `${repo.dogfoodDir} exists but is not a worktree of ${repo.gitDir}. Move it away first.`,
      });
    }
    const dirty = yield* git(repo.dogfoodDir, ["status", "--porcelain"]);
    const merging = yield* gitProbe(repo.dogfoodDir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    if (dirty.length > 0 || merging.exitCode === 0) {
      return yield* new SyncSetupError({
        detail: `${repo.dogfoodDir} has uncommitted changes or an unfinished merge; commit or discard them first (git -C ${repo.dogfoodDir} merge --abort ends a merge).`,
      });
    }
    yield* git(repo.dogfoodDir, ["checkout", "-q", "-B", DOGFOOD_BRANCH, `refs/tags/${baseTag}`]);
    return;
  }
  // Drops the record of a worktree folder that was deleted by hand.
  yield* git(repo.gitDir, ["worktree", "prune"]);
  yield* run(
    "git",
    ["worktree", "add", "-B", DOGFOOD_BRANCH, repo.dogfoodDir, `refs/tags/${baseTag}`],
    { cwd: repo.gitDir },
  );
});

const ForkIdentity = Schema.Struct({
  appId: Schema.NonEmptyString,
  appleTeamId: Schema.NonEmptyString,
  productName: Schema.NonEmptyString,
});
const decodeIdentityModule = Schema.decodeUnknownEffect(Schema.Struct({ ForkIdentity }));

/** The identity of the checkout about to be built, read from its forkIdentity.ts. */
export const loadIdentity = Effect.fn("pjsSync.loadIdentity")(function* (dogfoodDir: string) {
  const path = yield* Path.Path;
  const file = path.join(dogfoodDir, "packages/shared/src/forkIdentity.ts");
  const url = yield* path.toFileUrl(file).pipe(Effect.orDie);
  // Node strips the types, so the .ts file loads directly.
  const module = yield* Effect.tryPromise({ try: () => import(url.href), catch: String }).pipe(
    Effect.flatMap(decodeIdentityModule),
    Effect.mapError(
      (cause) =>
        new SyncSetupError({
          detail: `Could not read appId, appleTeamId, and productName from ${file} (is ${IDENTITY_BRANCH} in the list?): ${String(cause)}`,
        }),
    ),
  );
  const { appId, appleTeamId, productName } = module.ForkIdentity;
  return { appId, appleTeamId, appName: `${productName}.app` };
});

const extractBuiltApp = Effect.fn("pjsSync.extractBuiltApp")(function* (
  dogfoodDir: string,
  identity: { readonly appId: string; readonly appName: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const releaseDir = path.join(dogfoodDir, "release");
  const entries = yield* fs.readDirectory(releaseDir).pipe(fileSystemError("read", releaseDir));
  const archives = entries.filter((entry) => entry.endsWith(".zip"));
  const [archive] = archives;
  if (archives.length !== 1 || archive === undefined) {
    return yield* new SyncSetupError({
      detail: `Expected one .zip in ${releaseDir} after the build, found ${archives.length}.`,
    });
  }
  // electron-builder copies only the dmg and zip out of its staging folder; the zip holds the app.
  yield* run("ditto", ["-x", "-k", path.join(releaseDir, archive), releaseDir], {
    cwd: dogfoodDir,
  });
  const app = path.join(releaseDir, identity.appName);
  const plist = path.join(app, "Contents", "Info.plist");
  const { stdout } = yield* capture(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist],
    dogfoodDir,
  );
  const bundleId = stdout.trim();
  if (bundleId !== identity.appId) {
    return yield* new SyncSetupError({
      detail: `${app} has bundle id "${bundleId}", but forkIdentity.ts says ${identity.appId}.`,
    });
  }
  return app;
});

const buildApp = Effect.fn("pjsSync.buildApp")(function* (
  dogfoodDir: string,
  identity: { readonly appId: string; readonly appleTeamId: string; readonly appName: string },
  notarize: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  // A stale zip or app would otherwise pass for this build's output.
  const releaseDir = path.join(dogfoodDir, "release");
  yield* fs
    .remove(releaseDir, { recursive: true, force: true })
    .pipe(fileSystemError("remove", releaseDir));
  yield* run("mise", ["exec", "--", "vp", "run", BUILD.script], {
    cwd: dogfoodDir,
    env: buildEnvironment({
      appleTeamId: identity.appleTeamId,
      provisioningProfile: path.join(home, BUILD.provisioningProfile),
      notarize,
    }),
  });
  return yield* extractBuiltApp(dogfoodDir, identity);
});

const describeBaseChange = Effect.fn("pjsSync.describeBaseChange")(function* (
  gitDir: string,
  last: BuildRecord | undefined,
  baseTag: string,
) {
  if (!last) return `${baseTag} (first build)`;
  if (last.baseTag === baseTag) return `${baseTag} (unchanged)`;
  const count = yield* gitProbe(gitDir, [
    "rev-list",
    "--count",
    `refs/tags/${last.baseTag}..refs/tags/${baseTag}`,
  ]);
  const commits =
    count.exitCode === 0
      ? `${Number(count.stdout.trim())} upstream commits`
      : "upstream commit count unknown";
  return `${last.baseTag} -> ${baseTag} (${commits})`;
});

interface SyncOptions {
  readonly list: boolean;
  readonly add: ReadonlyArray<string>;
  readonly remove: ReadonlyArray<string>;
  readonly check: boolean;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly notarize: boolean;
  readonly noInstall: boolean;
}

const configureBranches = Effect.fn("pjsSync.configureBranches")(function* (
  repo: Repository,
  options: SyncOptions,
) {
  const { branches: current, isDefault } = yield* readBranches(repo.gitDir);
  const absent = options.remove.filter((branch) => !current.includes(branch));
  if (absent.length > 0) {
    return yield* new SyncSetupError({
      detail: `Not on the list: ${absent.join(", ")}. The list is: ${current.join(", ")}.`,
    });
  }
  for (const branch of options.add) yield* branchHead(repo.gitDir, branch);
  const kept = current.filter((branch) => !options.remove.includes(branch));
  const added = options.add.filter(
    (branch, index, all) => !kept.includes(branch) && all.indexOf(branch) === index,
  );
  const next = [...kept, ...added];
  if (next.length === 0) {
    return yield* new SyncSetupError({
      detail: `Removing that leaves no branch, and an empty list falls back to ${IDENTITY_BRANCH}.`,
    });
  }
  const changed = next.join("\n") !== current.join("\n");
  if (changed) yield* writeBranches(repo.gitDir, next);
  const { train, isDefault: trainIsDefault } = yield* readTrain(repo.gitDir);
  yield* Console.log(
    `train: ${train}${trainIsDefault ? ` (default; change with: git config ${TRAIN_KEY} stable)` : ""}`,
  );
  yield* Console.log(
    `branches, merged in this order${isDefault && !changed ? " (default; none stored)" : ""}:`,
  );
  for (const branch of next) yield* Console.log(`  ${branch}`);
});

const listTags = (gitDir: string) => gitLines(gitDir, ["tag", "--list", "v*"]);

const checkOutdated = Effect.fn("pjsSync.checkOutdated")(function* (repo: Repository) {
  const { train } = yield* readTrain(repo.gitDir);
  // Offline or rejected fetches fall back to the tags already here; the check stays quiet.
  yield* gitProbe(repo.gitDir, [
    "fetch",
    "--quiet",
    "--force",
    "upstream",
    "refs/tags/*:refs/tags/*",
  ]);
  const baseTag = selectBaseTag(train, yield* listTags(repo.gitDir));
  if (baseTag === undefined) return;
  const last = yield* statePath().pipe(Effect.flatMap(readState));
  if (last?.baseTag !== baseTag) {
    yield* Console.log(
      `t3code-pjs: ${baseTag} available (${last ? `built from ${last.baseTag}` : "not built yet"})`,
    );
  } else if (!last.installed) {
    yield* Console.log(`t3code-pjs: ${baseTag} built, not installed`);
  }
});

const sync = Effect.fn("pjsSync.sync")(function* (repo: Repository, options: SyncOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const flavor: Flavor = options.notarize ? "notarized" : "signed";
  const install = !options.noInstall;
  const stateFile = yield* statePath();

  const toolchain = path.join(repo.projectDir, "mise.toml");
  const toolchainState = yield* toolchainStatus(repo.projectDir, repo.toolchainTemplate);
  if (toolchainState === "differs") {
    yield* Console.error(
      `t3code-pjs: WARNING: ${toolchain} differs from ${repo.toolchainTemplate}; update whichever is stale.`,
    );
  } else if (toolchainState === "missing") {
    if (options.dryRun) {
      yield* Console.log(`would recreate ${toolchain}`);
    } else {
      yield* recreateToolchainFile(repo.projectDir, repo.toolchainTemplate);
      yield* Console.log(`recreated ${toolchain}`);
    }
  }

  const { train } = yield* readTrain(repo.gitDir);
  const { branches: listed } = yield* readBranches(repo.gitDir);
  if (options.dryRun) {
    yield* Console.log("dry run: not fetching; using the tags fetched earlier");
  } else {
    yield* run("git", ["fetch", "--quiet", "--force", "--tags", "upstream"], { cwd: repo.gitDir });
  }
  const baseTag = selectBaseTag(train, yield* listTags(repo.gitDir));
  if (baseTag === undefined) {
    return yield* new SyncSetupError({
      detail: `No upstream tag matches the ${train} train. Check the \`upstream\` remote.`,
    });
  }
  const baseRef = `refs/tags/${baseTag}`;
  const baseSha = yield* git(repo.gitDir, ["rev-parse", `${baseRef}^{commit}`]);

  const absorbed = yield* findMergedBranches(repo.gitDir, baseRef, listed);
  const branches = listed.filter((branch) => !absorbed.includes(branch));
  for (const branch of absorbed) {
    yield* Console.log(
      `${options.dryRun ? "would drop" : "dropped"} ${branch} from ${BRANCH_KEY}: ${baseTag} already contains it. Delete the branch when ready: git -C ${repo.gitDir} branch -D ${branch}`,
    );
  }
  if (absorbed.length > 0 && !options.dryRun) yield* writeBranches(repo.gitDir, branches);

  const heads = yield* Effect.forEach(branches, (name) =>
    branchHead(repo.gitDir, name).pipe(Effect.map((sha) => ({ name, sha }))),
  );
  const upstreamRef = yield* upstreamHeadRef(repo.gitDir);
  const drifted = yield* findDriftedBranches(repo.gitDir, upstreamRef, baseRef, branches);
  for (const { branch, mergeBase, commits } of drifted) {
    yield* Console.error(
      `t3code-pjs: WARNING: ${branch} is based on ${commits} upstream commit${commits === 1 ? "" : "s"} newer than ${baseTag}, so dogfood includes them.\n  Fix: wt switch ${branch}, then git rebase --onto ${baseTag} ${mergeBase} ${branch}; or wait for the next nightly; or cut new branches from the tag: wt switch --create <name> --base ${baseTag}`,
    );
  }

  const current = {
    toolVersion: TOOL_VERSION,
    flavor,
    baseTag,
    baseSha,
    branches: heads,
  } satisfies BuildInputs;
  const last = yield* readState(stateFile);
  const releaseApp = (appName: string) => path.join(repo.dogfoodDir, "release", appName);
  const appPresent = last
    ? yield* fs.exists(releaseApp(last.appName)).pipe(fileSystemError("check", last.appName))
    : false;
  const decision = decideAction({ last, current, force: options.force, install, appPresent });
  const baseChange = yield* describeBaseChange(repo.gitDir, last, baseTag);
  const summarize = (appName: string) =>
    [
      `  base      ${baseChange}`,
      `  branches  ${heads.map(({ name, sha }) => `${name} @ ${sha.slice(0, 10)}`).join(", ")}`,
      `  app       ${releaseApp(appName)}`,
      `  installed ${install ? path.join(INSTALL_DIR, appName) : "no (--no-install)"}`,
    ].join("\n");
  // Until a build runs, the app's name is not known from forkIdentity.ts.
  const knownAppName = last?.appName ?? "<productName>.app";

  if (decision.action === "up-to-date") {
    yield* Console.log(`up to date: ${decision.reason}\n${summarize(knownAppName)}`);
    return;
  }
  if (options.dryRun) {
    const hasWorktree = yield* fs.exists(repo.dogfoodDir);
    const worktree = `  worktree  ${repo.dogfoodDir} (${hasWorktree ? "reset to the base tag" : "would be created"})`;
    yield* Console.log(
      [
        `plan: ${decision.action} (${decision.reason}); ${flavor}, train ${train}`,
        ...(decision.action === "build" ? [worktree] : []),
        summarize(knownAppName),
      ].join("\n"),
    );
    return;
  }

  const finish = Effect.fn("pjsSync.finish")(function* (record: BuildRecord, verb: string) {
    const result = install
      ? yield* installBuilt(stateFile, record, releaseApp(record.appName), INSTALL_DIR)
      : record;
    yield* Console.log(`${verb}:\n${summarize(result.appName)}`);
  });
  if (decision.action === "install" && last) return yield* finish(last, "installed");

  yield* ensureDogfood(repo, baseTag);
  const merge = yield* mergeBranches(
    repo.dogfoodDir,
    heads.map(({ name }) => name),
  );
  if (merge._tag === "Conflict") {
    return yield* new SyncConflictError({
      report: conflictPrompt({
        projectDir: repo.projectDir,
        dogfoodDir: repo.dogfoodDir,
        baseTag,
        branch: merge.branch,
        mergedBefore: merge.mergedBefore,
        files: merge.files,
        upstreamMergeBase: yield* upstreamMergeBase(repo.gitDir, upstreamRef, merge.branch),
        rerun: `node ${repo.scriptPath}`,
      }),
    });
  }
  for (const { branch, replayed } of merge.branches) {
    yield* Console.log(`merged ${branch}${replayed ? " (recorded resolution)" : ""}`);
  }
  yield* run("mise", ["exec", "--", "vp", "i"], { cwd: repo.dogfoodDir });
  const identity = yield* loadIdentity(repo.dogfoodDir);
  yield* buildApp(repo.dogfoodDir, identity, options.notarize);
  const built = {
    ...current,
    appName: identity.appName,
    bundleId: identity.appId,
    installed: false,
  } satisfies BuildRecord;
  yield* writeState(stateFile, built);
  yield* finish(built, "built");
});

const resolveMode = Effect.fn("pjsSync.resolveMode")(function* (options: SyncOptions) {
  const configuring = options.list || options.add.length > 0 || options.remove.length > 0;
  const syncFlags = [
    options.dryRun && "--dry-run",
    options.force && "--force",
    options.notarize && "--notarize",
    options.noInstall && "--no-install",
  ].filter((flag) => flag !== false);
  if (configuring && (options.check || syncFlags.length > 0)) {
    return yield* new SyncSetupError({
      detail: "--list, --add, and --remove cannot be combined with other flags.",
    });
  }
  if (options.check && syncFlags.length > 0) {
    return yield* new SyncSetupError({ detail: "--check cannot be combined with other flags." });
  }
  return configuring ? "configure" : options.check ? "check" : "sync";
});

const program = Effect.fn("pjsSync.program")(function* (options: SyncOptions) {
  const mode = yield* resolveMode(options);
  const repo = yield* resolveRepository();
  if (mode === "configure") return yield* configureBranches(repo, options);
  if (mode === "check") return yield* checkOutdated(repo);
  return yield* sync(repo, options);
});

const HELP = [
  "Rebuild and install T3 Code (PJS) from the newest upstream release plus this fork's branches.",
  "",
  "A sync fetches upstream (with tags), picks the base tag on the train, resets the `dogfood` worktree",
  "(made beside .bare when missing) to it, and merges each listed branch in order, with git rerere",
  "replaying recorded conflict resolutions. Then it runs `vp i` and the signed desktop build there and",
  "installs the app that the build's packages/shared/src/forkIdentity.ts names into /Applications,",
  "copied beside it and renamed into place. It does nothing when the base tag, the branch heads, and",
  "this tool match the last build, recorded in $XDG_STATE_HOME/t3code-pjs/sync.json (default",
  "~/.local/state).",
  "",
  "It warns when a branch was cut from upstream commits newer than the base tag (dogfood then includes",
  "them) and prints the fix, and when the project folder's mise.toml differs from the checked-in",
  "scripts/pjs/toolchain.toml; a missing mise.toml is recreated from it and trusted. A branch whose",
  "merge into the base changes nothing, because upstream absorbed it, is dropped from the list (never",
  "fork/identity) and its delete command is printed.",
  "",
  "Config, in the repository's git config (shared by every worktree):",
  `  ${BRANCH_KEY}  branch to merge; several are merged in the order stored; default ${IDENTITY_BRANCH}`,
  `  ${TRAIN_KEY}   nightly (default): newest v*-nightly.* tag; stable: newest plain vX.Y.Z tag`,
  "",
  "Exit codes: 0 done or up to date; 1 failure; 3 a branch conflicts and rerere has no recorded",
  "resolution (a warning with a prompt for an agent is printed); 4 built, but the app is running, so it",
  "was not installed (quit it and rerun to install without rebuilding).",
].join("\n");

const pjsSyncCommand = Command.make("pjs-sync", {
  list: Flag.Boolean("list").pipe(
    Flag.withDescription("Print the train and the branch list, then exit."),
    Flag.withDefault(false),
  ),
  add: Flag.String("add").pipe(
    Flag.withDescription("Append a local branch to the list, then exit; repeatable."),
    Flag.atLeast(0),
  ),
  remove: Flag.String("remove").pipe(
    Flag.withDescription("Remove a branch from the list, then exit; repeatable."),
    Flag.atLeast(0),
  ),
  check: Flag.Boolean("check").pipe(
    Flag.withDescription(
      "Fetch tags; print one line only if a newer base than the last build exists.",
    ),
    Flag.withDefault(false),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the plan without fetching or changing anything."),
    Flag.withDefault(false),
  ),
  force: Flag.Boolean("force").pipe(
    Flag.withDescription("Rebuild even when nothing changed."),
    Flag.withDefault(false),
  ),
  notarize: Flag.Boolean("notarize").pipe(
    Flag.withDescription("Also notarize, with the `notary` keychain profile."),
    Flag.withDefault(false),
  ),
  noInstall: Flag.Boolean("no-install").pipe(
    Flag.withDescription("Build, but leave the app in dogfood/release."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(HELP),
  Command.withHandler((options) =>
    program(options).pipe(
      Effect.tapError((error) => Console.error(`t3code-pjs: ${error.message}`)),
    ),
  ),
);

if (import.meta.main) {
  Command.run(pjsSyncCommand, { version: String(TOOL_VERSION) }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
}
