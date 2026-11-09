import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  conflictPrompt,
  finishBuild,
  decideAction,
  ensureDogfood,
  findDriftedBranches,
  findMergedBranches,
  forkDelta,
  git,
  installApp,
  iosBuildNumber,
  loadIdentity,
  mergeBranches,
  readState,
  recreateToolchainFile,
  replaceApp,
  selectBaseTag,
  toolchainStatus,
  TOOL_VERSION,
  uploadPhone,
  phoneBehind,
  writeState,
  type BuildInputs,
  type BuildRecord,
} from "./sync.ts";

/** Hooks export GIT_DIR and friends, and user config can sign commits or ignore fixture files. */
const sandbox = Effect.fn("sandbox")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs
    .makeTempDirectoryScoped({ prefix: "pjs-sync-" })
    .pipe(Effect.flatMap(fs.realPath));
  const config = path.join(root, "gitconfig");
  yield* fs.writeFileString(
    config,
    "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
  );
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const hermetic = ChildProcessSpawner.make((command) =>
    spawner.spawn(ChildProcess.setEnv(command, env)),
  );
  return { root, hermetic };
});

const inSandbox = <A, E, R>(body: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const { root, hermetic } = yield* sandbox();
    return yield* body(root).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, hermetic),
    );
  });

const repoWithFile = Effect.fn("repoWithFile")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(root, "repo");
  yield* fs.makeDirectory(dir);
  yield* git(dir, ["init", "-q"]);
  const commit = Effect.fn("commit")(function* (file: string, content: string, message: string) {
    yield* fs.writeFileString(path.join(dir, file), content);
    yield* git(dir, ["add", file]);
    yield* git(dir, ["commit", "-q", "-m", message]);
  });
  yield* commit("f.txt", "base\n", "base");
  return { dir, commit };
});

const changeFile = Effect.fn("changeFile")(function* (
  dir: string,
  file: string,
  content: string | Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(dir, file);
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* typeof content === "string"
    ? fs.writeFileString(target, content)
    : fs.writeFile(target, content);
  yield* git(dir, ["add", file]);
  yield* git(dir, ["commit", "-q", "-m", file]);
});

/** Stands in for lsappinfo, mise, ditto, and xcodebuild; records each invocation. */
function stubSpawner(
  running: boolean,
  onSpawn: (argv: ReadonlyArray<string>) => Effect.Effect<void, PlatformError.PlatformError> = () =>
    Effect.void,
  exitCodeFor: (argv: ReadonlyArray<string>) => number = () => 0,
) {
  const calls: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    const argv = ChildProcess.isStandardCommand(command)
      ? [command.command, ...command.args.map(String)]
      : [];
    calls.push(argv);
    const stdout = argv[0] === "lsappinfo" && running ? 'ASN:0x0-0x1:"Example"\n' : "";
    return onSpawn(argv).pipe(
      Effect.map(() =>
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCodeFor(argv))),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
  });
  return { calls, spawner };
}

const inputs: BuildInputs = {
  toolVersion: TOOL_VERSION,
  flavor: "signed",
  baseTag: "v0.1.8-nightly.20261108.4380",
  baseSha: "aaaa",
  branches: [{ name: "fork/identity", sha: "1111" }],
};
const built = { appName: "Example.app", bundleId: "com.example.app" };
const lastBuild: BuildRecord = { ...inputs, ...built, installed: true };
const decide = (overrides: Partial<Parameters<typeof decideAction>[0]> = {}) =>
  decideAction({
    last: lastBuild,
    current: inputs,
    force: false,
    install: true,
    appPresent: true,
    ...overrides,
  });

it.layer(NodeServices.layer)("pjs sync", (it) => {
  it("picks the newest nightly by version order and ignores every other tag", () => {
    const tags = [
      "v0.1.8-nightly.20261108.999",
      "v0.1.8-nightly.20261108.4380",
      "v0.1.9-nightly.20261130.5000",
      "v0.1.10-nightly.20261201.1",
      "nightly-v0.9.9-nightly.20270101.1",
      "v0.9.9",
      "v0.9.9-preview.20270101.1",
      "v0.0.0-alpha.22",
      "v0-preview-cua-3f61c220f8c",
    ];
    assert.strictEqual(selectBaseTag("nightly", tags), "v0.1.10-nightly.20261201.1");
    assert.strictEqual(selectBaseTag("nightly", tags.slice(0, 2)), "v0.1.8-nightly.20261108.4380");
    assert.strictEqual(selectBaseTag("nightly", ["v0.1.8", "v0.0.0-alpha.1"]), undefined);
  });

  it("picks the newest plain release for the stable train", () => {
    const tags = [
      "v0.1.9",
      "v0.1.10",
      "v0.1.7",
      "v0.2.0-nightly.20261201.1",
      "v0.3.0-preview.20261201.1",
      "v0.0.0-alpha.22",
      "v1.0.0-rc.1",
    ];
    assert.strictEqual(selectBaseTag("stable", tags), "v0.1.10");
    assert.strictEqual(selectBaseTag("stable", ["v0.2.0-nightly.20261201.1"]), undefined);
  });

  it("skips only when the base, the branch heads, the tool, and the install state are unchanged", () => {
    assert.strictEqual(decide().action, "up-to-date");
    assert.strictEqual(decide({ last: undefined }).action, "build");
    assert.strictEqual(decide({ force: true }).action, "build");
    assert.strictEqual(decide({ appPresent: false }).action, "build");
    assert.strictEqual(
      decide({ current: { ...inputs, baseTag: "v0.1.8-nightly.20261109.1" } }).action,
      "build",
    );
    assert.strictEqual(decide({ current: { ...inputs, baseSha: "bbbb" } }).action, "build");
    assert.strictEqual(
      decide({ current: { ...inputs, toolVersion: TOOL_VERSION + 1 } }).action,
      "build",
    );
    assert.strictEqual(
      decide({ current: { ...inputs, branches: [{ name: "fork/identity", sha: "2222" }] } }).action,
      "build",
    );
    assert.strictEqual(
      decide({
        current: {
          ...inputs,
          branches: [...inputs.branches, { name: "feature/x", sha: "3333" }],
        },
      }).action,
      "build",
    );
    // A notarized build satisfies a signed request, not the reverse.
    assert.strictEqual(
      decide({ last: { ...lastBuild, flavor: "notarized" } }).action,
      "up-to-date",
    );
    assert.strictEqual(decide({ current: { ...inputs, flavor: "notarized" } }).action, "build");
  });

  it("installs a built app that was never installed, and skips that when installing is off", () => {
    const unfinished = { ...lastBuild, installed: false };
    assert.strictEqual(decide({ last: unfinished }).action, "install");
    assert.strictEqual(decide({ last: unfinished, install: false }).action, "up-to-date");
  });

  it.effect("detects branches the base already contains and never the identity branch", () =>
    inSandbox((root) =>
      Effect.gen(function* () {
        const { dir, commit } = yield* repoWithFile(root);
        yield* git(dir, ["tag", "v1"]);
        const branchFrom = Effect.fn("branchFrom")(function* (
          name: string,
          file: string,
          content: string,
        ) {
          yield* git(dir, ["checkout", "-q", "-b", name, "v1"]);
          yield* commit(file, content, name);
          yield* git(dir, ["checkout", "-q", "main"]);
        });
        yield* branchFrom("absorbed", "b.txt", "b\n");
        yield* branchFrom("kept", "c.txt", "c\n");
        yield* branchFrom("fork/identity", "d.txt", "d\n");
        yield* branchFrom("conflicting", "f.txt", "branch\n");
        yield* git(dir, ["branch", "contained", "v1"]);
        // Upstream landed the same files as new commits, as a squash merge does, and edited f.txt.
        yield* commit("b.txt", "b\n", "upstream b");
        yield* commit("d.txt", "d\n", "upstream d");
        yield* commit("f.txt", "upstream\n", "upstream f");
        yield* git(dir, ["tag", "v2"]);

        const merged = yield* findMergedBranches(dir, "refs/tags/v2", [
          "absorbed",
          "kept",
          "fork/identity",
          "conflicting",
          "contained",
        ]);
        assert.deepStrictEqual(merged, ["absorbed", "contained"]);
      }),
    ),
  );

  it.effect("reports only branches cut from upstream commits newer than the base tag", () =>
    inSandbox((root) =>
      Effect.gen(function* () {
        const { dir, commit } = yield* repoWithFile(root);
        yield* git(dir, ["tag", "v1"]);
        yield* commit("u.txt", "u\n", "unreleased upstream");
        const unreleased = yield* git(dir, ["rev-parse", "HEAD"]);
        const branchFrom = Effect.fn("branchFrom")(function* (name: string, start: string) {
          yield* git(dir, ["checkout", "-q", "-b", name, start]);
          yield* commit(`${name}.txt`, `${name}\n`, name);
          yield* git(dir, ["checkout", "-q", "main"]);
        });
        yield* branchFrom("from-main", "main");
        yield* branchFrom("from-tag", "v1");

        const drifted = yield* findDriftedBranches(dir, "refs/heads/main", "refs/tags/v1", [
          "from-main",
          "from-tag",
        ]);
        assert.deepStrictEqual(drifted, [
          { branch: "from-main", mergeBase: unreleased, commits: 1 },
        ]);
        assert.deepStrictEqual(
          yield* findDriftedBranches(dir, undefined, "refs/tags/v1", ["from-main"]),
          [],
        );
      }),
    ),
  );

  it.effect("commits a merge that rerere replays, and stops with the files when it cannot", () =>
    inSandbox((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { dir, commit } = yield* repoWithFile(root);
        const branchFrom = Effect.fn("branchFrom")(function* (name: string, content: string) {
          yield* git(dir, ["checkout", "-q", "-b", name, "main"]);
          yield* commit("f.txt", content, name);
          yield* git(dir, ["checkout", "-q", "main"]);
        });
        yield* branchFrom("a", "from a\n");
        yield* branchFrom("b", "from b\n");
        yield* git(dir, ["checkout", "-q", "-B", "dogfood", "main"]);

        const first = yield* mergeBranches(dir, ["a", "b"]);
        assert.deepStrictEqual(first, {
          _tag: "Conflict",
          branch: "b",
          files: ["f.txt"],
          mergedBefore: ["a"],
        });
        assert.strictEqual(yield* git(dir, ["status", "--porcelain"]), "");

        // Resolve the conflict by hand once; committing records the resolution for rerere.
        yield* git(dir, ["-c", "rerere.enabled=true", "merge", "-q", "refs/heads/b"]).pipe(
          Effect.ignore,
        );
        yield* fs.writeFileString(path.join(dir, "f.txt"), "resolved\n");
        yield* git(dir, ["add", "f.txt"]);
        yield* git(dir, ["-c", "rerere.enabled=true", "commit", "-q", "--no-edit"]);
        yield* git(dir, ["checkout", "-q", "-B", "dogfood", "main"]);

        const second = yield* mergeBranches(dir, ["a", "b"]);
        assert.deepStrictEqual(second, {
          _tag: "Merged",
          branches: [
            { branch: "a", replayed: false },
            { branch: "b", replayed: true },
          ],
        });
        assert.strictEqual(yield* fs.readFileString(path.join(dir, "f.txt")), "resolved\n");
        assert.strictEqual(yield* git(dir, ["status", "--porcelain"]), "");
      }),
    ),
  );

  it("names the repository, base, branch, files, rerere, and the way forward in the conflict prompt", () => {
    const prompt = conflictPrompt({
      projectDir: "/work/t3code",
      dogfoodDir: "/work/t3code/dogfood",
      baseTag: "v0.1.8-nightly.20261108.4380",
      branch: "feature/x",
      mergedBefore: ["fork/identity"],
      files: ["apps/web/a.ts", "packages/shared/b.ts"],
      upstreamMergeBase: "abc1234",
      rerun: "node /work/t3code/main/scripts/pjs/sync.ts",
    });
    for (const expected of [
      "WARNING",
      "/work/t3code",
      "/work/t3code/dogfood",
      "v0.1.8-nightly.20261108.4380",
      "Branch that conflicts: feature/x",
      "Merged before it: fork/identity",
      "- apps/web/a.ts",
      "- packages/shared/b.ts",
      "rerere",
      "git -C /work/t3code/dogfood -c rerere.enabled=true merge refs/heads/feature/x",
      "git rebase --onto v0.1.8-nightly.20261108.4380 abc1234 feature/x",
      "Rerun the sync: node /work/t3code/main/scripts/pjs/sync.ts",
    ]) {
      assert.include(prompt, expected);
    }
  });

  it.effect("replaces the previous app, and puts it back when the swap fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "pjs-sync-app-" });
      const app = (name: string, marker: string) =>
        Effect.gen(function* () {
          const dir = path.join(root, name);
          yield* fs.makeDirectory(dir, { recursive: true });
          yield* fs.writeFileString(path.join(dir, "marker"), marker);
          return dir;
        });
      const destination = yield* app("Applications/T3 Code (PJS).app", "old");
      const staged = yield* app("stage/T3 Code (PJS).app", "new");

      yield* replaceApp(staged, destination);
      assert.strictEqual(yield* fs.readFileString(path.join(destination, "marker")), "new");

      // A missing staged app fails the second move, after the previous app was set aside.
      yield* fs.makeDirectory(path.join(root, "empty-stage"));
      const failure = yield* replaceApp(
        path.join(root, "empty-stage/missing.app"),
        destination,
      ).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "SyncFileSystemError");
      assert.strictEqual(yield* fs.readFileString(path.join(destination, "marker")), "new");
    }),
  );

  it.effect("refuses to install over the app while it runs, and touches nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const destinationDir = yield* fs.makeTempDirectoryScoped({ prefix: "pjs-sync-apps-" });
      const stub = stubSpawner(true);

      const failure = yield* installApp("/build/Example.app", destinationDir, built).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, stub.spawner),
        Effect.flip,
      );

      assert.strictEqual(failure._tag, "SyncInstallBlockedError");
      assert.include(failure.message, "/build/Example.app");
      // The running-app check uses the bundle id recorded for the build being installed.
      assert.deepStrictEqual(stub.calls, [["lsappinfo", "find", "bundleid=com.example.app"]]);
      assert.deepStrictEqual(yield* fs.readDirectory(destinationDir), []);
      assert.isFalse(yield* fs.exists(path.join(destinationDir, "Example.app")));
    }),
  );

  it.effect(
    "recreates a missing toolchain file byte for byte, never overwrites, and flags a stale copy",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "pjs-sync-toolchain-" });
        const projectDir = path.join(root, "project");
        yield* fs.makeDirectory(projectDir);
        const template = path.join(root, "toolchain.toml");
        const content =
          "# template\r\n[tools]\r\nnode = '''{{ exec(command=\"a \\\"b\\\"\") }}'''\n";
        yield* fs.writeFileString(template, content);
        const file = path.join(projectDir, "mise.toml");
        const stub = stubSpawner(false);
        const recreate = recreateToolchainFile(projectDir, template).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, stub.spawner),
        );

        assert.strictEqual(yield* toolchainStatus(projectDir, template), "missing");
        yield* recreate;
        assert.strictEqual(yield* fs.readFileString(file), content);
        assert.deepStrictEqual(stub.calls, [["mise", "trust", file]]);
        assert.strictEqual(yield* toolchainStatus(projectDir, template), "same");

        yield* fs.writeFileString(file, "# edited by hand\n");
        assert.strictEqual(yield* toolchainStatus(projectDir, template), "differs");
        const failure = yield* recreate.pipe(Effect.flip);
        assert.strictEqual(failure._tag, "SyncFileSystemError");
        assert.strictEqual(yield* fs.readFileString(file), "# edited by hand\n");
        assert.strictEqual(stub.calls.length, 1);
      }),
  );

  it.effect("refuses a dirty or mid-merge dogfood and leaves it untouched", () =>
    inSandbox((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { dir } = yield* repoWithFile(root);
        yield* git(dir, ["tag", "v1"]);
        const dogfoodDir = path.join(root, "dogfood");
        yield* git(dir, ["worktree", "add", "-q", "-b", "dogfood", dogfoodDir, "v1"]);
        yield* fs.writeFileString(path.join(dogfoodDir, "own.txt"), "own\n");
        yield* git(dogfoodDir, ["add", "own.txt"]);
        yield* git(dogfoodDir, ["commit", "-q", "-m", "own"]);
        const head = yield* git(dogfoodDir, ["rev-parse", "HEAD"]);
        const refusal = ensureDogfood(
          { gitDir: dir, projectDir: root, dogfoodDir, scriptPath: "", toolchainTemplate: "" },
          "v1",
        ).pipe(Effect.flip);

        const stray = path.join(dogfoodDir, "stray.txt");
        yield* fs.writeFileString(stray, "x\n");
        const dirty = yield* refusal;
        assert.strictEqual(dirty._tag, "SyncSetupError");
        assert.include(dirty.message, "uncommitted changes");
        assert.strictEqual(yield* git(dogfoodDir, ["rev-parse", "HEAD"]), head);
        assert.isTrue(yield* fs.exists(stray));
        yield* fs.remove(stray);

        // A merge stopped before its commit leaves a clean status, so only MERGE_HEAD shows it.
        const empty = yield* git(dogfoodDir, [
          "commit-tree",
          "HEAD^{tree}",
          "-p",
          "HEAD",
          "-m",
          "empty",
        ]);
        yield* git(dir, ["branch", "same", empty]);
        yield* git(dogfoodDir, ["merge", "-q", "--no-ff", "--no-commit", "same"]);
        assert.strictEqual(yield* git(dogfoodDir, ["status", "--porcelain"]), "");
        const merging = yield* refusal;
        assert.strictEqual(merging._tag, "SyncSetupError");
        assert.include(merging.message, "unfinished merge");
        assert.strictEqual(yield* git(dogfoodDir, ["rev-parse", "HEAD"]), head);
        assert.strictEqual(
          yield* git(dogfoodDir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]),
          empty,
        );
      }),
    ),
  );

  it.effect(
    "records a finished build before installing it, so a refused or skipped install is finished later",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "pjs-sync-install-" });
        const stateFile = path.join(root, "state", "sync.json");
        const destinationDir = path.join(root, "Applications");
        yield* fs.makeDirectory(destinationDir);
        const fresh: BuildRecord = {
          ...lastBuild,
          baseTag: "v0.1.9-nightly.20261201.1",
          installed: false,
        };
        const stubFor = (running: boolean) =>
          stubSpawner(running, (argv) =>
            argv[0] === "ditto"
              ? fs.makeDirectory(argv[2] ?? "", { recursive: true })
              : Effect.void,
          );
        const finish = (
          spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
          install: boolean,
        ) =>
          finishBuild(stateFile, fresh, "/build/Example.app", destinationDir, install).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );

        // The app is running: the install is refused, and the new build is on record as not installed.
        const refused = yield* finish(stubFor(true).spawner, true).pipe(Effect.flip);
        assert.strictEqual(refused._tag, "SyncInstallBlockedError");
        const recorded = yield* readState(stateFile);
        assert.strictEqual(recorded?.baseTag, fresh.baseTag);
        assert.strictEqual(recorded?.installed, false);

        // The next run installs that build without rebuilding it.
        const next = decide({ last: recorded, current: { ...inputs, baseTag: fresh.baseTag } });
        assert.strictEqual(next.action, "install");
        const quiet = stubFor(false);
        yield* finish(quiet.spawner, true);
        assert.strictEqual((yield* readState(stateFile))?.installed, true);
        assert.isTrue(yield* fs.exists(path.join(destinationDir, "Example.app")));
        assert.isFalse(quiet.calls.some((argv) => argv[0] === "mise"));

        // --no-install records the build too, and touches nothing else.
        yield* fs.remove(stateFile);
        const skipped = stubFor(true);
        yield* finish(skipped.spawner, false);
        assert.strictEqual((yield* readState(stateFile))?.installed, false);
        assert.deepStrictEqual(skipped.calls, []);
      }),
  );

  it.effect("reads the build's identity from forkIdentity.ts and stops clearly without it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Node caches an imported module by path, so each case gets its own checkout.
      const checkoutWith = Effect.fn("checkoutWith")(function* (source: string | undefined) {
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "pjs-sync-identity-" });
        if (source !== undefined) {
          const directory = path.join(checkout, "packages/shared/src");
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* fs.writeFileString(path.join(directory, "forkIdentity.ts"), source);
        }
        return checkout;
      });

      const complete = yield* checkoutWith(
        'export const ForkIdentity = { appId: "com.example.app", appleTeamId: "TEAM123456", productName: "Example (X)", scheme: "x" } as const;\n',
      );
      assert.deepStrictEqual(yield* loadIdentity(complete), {
        appId: "com.example.app",
        appleTeamId: "TEAM123456",
        appName: "Example (X).app",
      });

      const missing = yield* loadIdentity(yield* checkoutWith(undefined)).pipe(Effect.flip);
      assert.strictEqual(missing._tag, "SyncSetupError");
      assert.include(missing.message, "fork/identity");

      const partial = yield* loadIdentity(
        yield* checkoutWith('export const ForkIdentity = { appId: "com.example.app" } as const;\n'),
      ).pipe(Effect.flip);
      assert.strictEqual(partial._tag, "SyncSetupError");
    }),
  );

  it.effect("records an upload only when every step went through", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "pjs-sync-upload-" });
      const mobileDir = path.join(root, "dogfood/apps/mobile");
      const iosDir = path.join(root, "state/ios");
      const stateFile = path.join(root, "state/sync.json");
      const previous: BuildRecord = {
        ...lastBuild,
        phone: { delta: "d0", fingerprint: "f0" },
        testflight: {
          buildNumber: "1",
          uploadedAt: DateTime.makeUnsafe("2026-11-01T00:00:00Z"),
          baseTag: lastBuild.baseTag,
          head: "h0",
          delta: "d0",
          fingerprint: "f0",
        },
      };
      yield* writeState(stateFile, previous);
      yield* fs.makeDirectory(path.join(iosDir, "Old-1.xcarchive"), { recursive: true });
      // expo prebuild --clean replaces ios/ with a fresh project.
      const prebuild = Effect.fn("prebuild")(function* (workspaces: ReadonlyArray<string>) {
        const ios = path.join(mobileDir, "ios");
        yield* fs.remove(ios, { recursive: true, force: true });
        yield* fs.makeDirectory(ios, { recursive: true });
        for (const workspace of workspaces) yield* fs.makeDirectory(path.join(ios, workspace));
      });
      const upload = (options: { workspaces: ReadonlyArray<string>; failing?: string }) => {
        const stub = stubSpawner(
          false,
          (argv) => (argv.includes("prebuild") ? prebuild(options.workspaces) : Effect.void),
          (argv) => (options.failing && argv.includes(options.failing) ? 1 : 0),
        );
        const result = uploadPhone({
          stateFile,
          record: previous,
          mobileDir,
          iosDir,
          buildNumber: "202611090001",
          teamId: "TEAM123456",
          inputs: { delta: "d1", fingerprint: "f1" },
          head: "h1",
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, stub.spawner));
        return { stub, result };
      };
      const recordedBuild = Effect.map(
        readState(stateFile),
        (record) => record?.testflight?.buildNumber,
      );

      // A failing archive stops before the upload step, and the earlier record stands.
      const failing = upload({ workspaces: ["Example.xcworkspace"], failing: "archive" });
      assert.strictEqual((yield* failing.result.pipe(Effect.flip))._tag, "SyncCommandError");
      assert.isFalse(failing.stub.calls.some((argv) => argv.includes("-exportArchive")));
      assert.strictEqual(yield* recordedBuild, "1");

      // The project name is the one workspace the prebuild leaves; none or several is an error.
      for (const workspaces of [[], ["A.xcworkspace", "B.xcworkspace"]]) {
        const unclear = upload({ workspaces });
        const error = yield* unclear.result.pipe(Effect.flip);
        assert.strictEqual(error._tag, "SyncSetupError");
        assert.include(error.message, "expected exactly one");
        assert.isFalse(unclear.stub.calls.some((argv) => argv.includes("xcodebuild")));
      }
      assert.strictEqual(yield* recordedBuild, "1");

      const ok = upload({ workspaces: ["Example.xcworkspace"] });
      yield* ok.result;
      assert.isTrue(ok.stub.calls.some((argv) => argv.includes("-exportArchive")));
      const archive = ok.stub.calls.find((argv) => argv.includes("archive"));
      assert.deepStrictEqual(archive?.slice(4, 9), [
        "archive",
        "-workspace",
        "ios/Example.xcworkspace",
        "-scheme",
        "Example",
      ]);
      const recorded = yield* readState(stateFile);
      assert.strictEqual(recorded?.testflight?.buildNumber, "202611090001");
      assert.deepStrictEqual(recorded?.phone, { delta: "d1", fingerprint: "f1" });
      assert.isFalse(yield* fs.exists(path.join(iosDir, "Old-1.xcarchive")));
    }),
  );

  it("names every reason the phone build is behind, and none when it is current", () => {
    const uploadedAt = DateTime.makeUnsafe("2026-11-08T22:14:04Z");
    const upload = {
      buildNumber: "2",
      uploadedAt,
      baseTag: "v0.1.8-nightly.20261108.4380",
      head: "765d924226",
      delta: "d1",
      fingerprint: "f1",
    };
    const day = 86_400_000;
    const afterDays = (days: number) => DateTime.toEpochMillis(uploadedAt) + days * day;
    const behind = (overrides: Partial<Parameters<typeof phoneBehind>[0]> = {}) =>
      phoneBehind({
        upload,
        current: { delta: "d1", fingerprint: "f1" },
        nowMillis: afterDays(5),
        uploadBaseMillis: 0,
        desktopBaseMillis: 0,
        ...overrides,
      });

    assert.deepStrictEqual(behind(), []);
    assert.deepStrictEqual(behind({ upload: undefined, nowMillis: afterDays(400) }), []);
    // Without the dogfood's current inputs there is nothing to compare, so only time can speak.
    assert.deepStrictEqual(behind({ current: undefined }), []);

    assert.deepStrictEqual(behind({ current: { delta: "d2", fingerprint: "f1" } }), [
      "the fork's changes to the phone's inputs differ",
    ]);
    assert.deepStrictEqual(behind({ current: { delta: "d1", fingerprint: "f2" } }), [
      "the native fingerprint differs",
    ]);

    // TestFlight keeps a build 90 days: the line appears once fewer than 10 days remain.
    assert.deepStrictEqual(behind({ nowMillis: afterDays(80) }), []);
    assert.deepStrictEqual(behind({ nowMillis: afterDays(81) }), ["it expires in 9 days"]);
    assert.deepStrictEqual(behind({ nowMillis: afterDays(91) }), ["it has expired"]);

    assert.deepStrictEqual(behind({ desktopBaseMillis: 14 * day }), []);
    assert.deepStrictEqual(behind({ desktopBaseMillis: 15 * day }), [
      "its base is 15 days older than the desktop build's",
    ]);
    assert.deepStrictEqual(
      behind({ desktopBaseMillis: 40 * day, uploadBaseMillis: undefined }),
      [],
    );

    assert.strictEqual(
      behind({
        current: { delta: "d2", fingerprint: "f2" },
        nowMillis: afterDays(85),
        desktopBaseMillis: 20 * day,
      }).length,
      4,
    );
  });

  it("numbers builds by UTC minute", () => {
    assert.strictEqual(iosBuildNumber(DateTime.makeUnsafe("2026-11-08T19:30:45Z")), "202611081930");
    assert.strictEqual(iosBuildNumber(DateTime.makeUnsafe("2027-01-02T03:04:00Z")), "202701020304");
    // 19:30 in New York is already the next day in UTC.
    assert.strictEqual(
      iosBuildNumber(DateTime.makeUnsafe("2026-11-08T19:30:00-05:00")),
      "202611090030",
    );
  });

  it.effect("hashes only the fork's own changes to the phone's inputs, text or binary", () =>
    inSandbox((root) =>
      Effect.gen(function* () {
        const { dir } = yield* repoWithFile(root);
        yield* changeFile(dir, "apps/mobile/a.txt", "a\n");
        yield* changeFile(dir, "apps/mobile/icon.bin", new Uint8Array([0, 1, 2, 3]));
        yield* git(dir, ["tag", "base"]);
        const delta = forkDelta(dir, "refs/tags/base");

        const unchanged = yield* delta;
        // Only the desktop, the server, the web client, and the repository's own scripts changed.
        for (const file of [
          "apps/server/b.txt",
          "apps/desktop/c.txt",
          "apps/web/d.txt",
          "scripts/build-desktop-artifact.ts",
        ]) {
          yield* changeFile(dir, file, "other\n");
          assert.strictEqual(yield* delta, unchanged, file);
        }

        yield* changeFile(dir, "scripts/lib/shared.ts", "shared\n");
        const shared = yield* delta;
        assert.notStrictEqual(shared, unchanged);
        assert.strictEqual(yield* delta, shared);

        yield* changeFile(dir, "apps/mobile/a.txt", "fork\n");
        const text = yield* delta;
        assert.notStrictEqual(text, shared);

        yield* changeFile(dir, "apps/mobile/icon.bin", new Uint8Array([0, 1, 2, 4]));
        assert.notStrictEqual(yield* delta, text);
      }),
    ),
  );

  it.effect("gives the same delta for the same fork change on a base upstream has edited", () =>
    inSandbox((root) =>
      Effect.gen(function* () {
        const { dir } = yield* repoWithFile(root);
        const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
        const withLine20 = (text: string) =>
          lines.map((line, index) => (index === 19 ? text : line));
        yield* changeFile(dir, "apps/mobile/app.txt", `${lines.join("\n")}\n`);
        yield* git(dir, ["tag", "t1"]);
        yield* git(dir, ["checkout", "-q", "-b", "fork-on-t1"]);
        yield* changeFile(dir, "apps/mobile/app.txt", `${withLine20("fork").join("\n")}\n`);
        const forkCommit = yield* git(dir, ["rev-parse", "HEAD"]);
        const onT1 = yield* forkDelta(dir, "refs/tags/t1");

        // Upstream prepends lines to the same file: new blob id, shifted line numbers.
        yield* git(dir, ["checkout", "-q", "main"]);
        yield* changeFile(dir, "apps/mobile/app.txt", `top\ntop\ntop\n${lines.join("\n")}\n`);
        yield* git(dir, ["tag", "t2"]);
        yield* git(dir, ["checkout", "-q", "-b", "fork-on-t2"]);
        yield* git(dir, ["cherry-pick", forkCommit]);

        assert.strictEqual(yield* forkDelta(dir, "refs/tags/t2"), onT1);
      }),
    ),
  );
});
