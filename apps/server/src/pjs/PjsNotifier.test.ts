import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadShell,
  type Project,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { DESKTOP_RENDERER_ORIGINS } from "../httpCors.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as IdleTime from "./IdleTime.ts";
import * as PjsNotifier from "./PjsNotifier.ts";

const WEBHOOK_URL = "https://hooks.example.test/v1/br_secret_token_123";
const CONFIG = JSON.stringify({ url: WEBHOOK_URL });
const APP_SCHEME = new URL(DESKTOP_RENDERER_ORIGINS[0]).protocol;
const now = DateTime.makeUnsafe(Date.parse("2026-11-08T12:00:00.000Z"));
const instanceId = ProviderInstanceId.make("codex");
const MAIN = ThreadId.make("thread:main");
const CHILD = ThreadId.make("thread:child");
const SIDE = ThreadId.make("thread:side");
const NATIVE = ThreadId.make("thread:native");
const ORPHAN = ThreadId.make("thread:orphan");
const ARCHIVED = ThreadId.make("thread:archived");
const CHILD_OF_ARCHIVED = ThreadId.make("thread:child-of-archived");

type ShellFields = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "projectId"
  | "title"
  | "lineage"
  | "creationSource"
  | "archivedAt"
  | "activityRunStatus"
  | "status"
>;

const shell = (overrides: Partial<ShellFields> = {}) =>
  ({
    id: MAIN,
    projectId: ProjectId.make("project:main"),
    title: "Fix login bug",
    lineage: { rootThreadId: MAIN, parentThreadId: null, relationshipToParent: null },
    creationSource: "web",
    archivedAt: null,
    activityRunStatus: null,
    status: "completed",
    ...overrides,
  }) as OrchestrationV2ThreadShell;

const subagent = (id: ThreadId, parentThreadId: ThreadId | null, title = "Subagent") =>
  shell({
    id,
    title,
    lineage: { rootThreadId: MAIN, parentThreadId, relationshipToParent: "subagent" },
  });
const sideChat = (id: ThreadId, parentThreadId: ThreadId, title = "Side chat") =>
  shell({
    id,
    title,
    lineage: { rootThreadId: MAIN, parentThreadId, relationshipToParent: "fork", sideChat: true },
  });

// The notifier reads only the title of a project and the state directory of the config.
const projectNamed = (title: string) => ({ title }) as Project;
const serverConfig = { stateDir: "/state" } as ServerConfig.ServerConfig["Service"];

const runUpdated = (
  status: OrchestrationV2Run["status"],
  runId = "run:1",
  threadId = MAIN,
  at = now,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${runId}:${status}`),
  type: "run.updated",
  threadId,
  occurredAt: now,
  payload: {
    id: RunId.make(runId),
    threadId,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    providerThreadId: null,
    userMessageId: MessageId.make("message:1"),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: now,
    completedAt: at,
    checkpointId: null,
    contextHandoffId: null,
  },
});

const requestUpdated = (
  kind: OrchestrationV2RuntimeRequest["kind"],
  status: OrchestrationV2RuntimeRequest["status"] = "pending",
  requestId = "request:1",
  threadId = MAIN,
  at = now,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${requestId}:${status}`),
  type: "runtime-request.updated",
  threadId,
  occurredAt: now,
  payload: {
    id: RuntimeRequestId.make(requestId),
    nodeId: NodeId.make("node:1"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind,
    status,
    responseCapability: { type: "message" },
    createdAt: at,
    resolvedAt: status === "pending" ? null : at,
  },
});

const openUrl = `${APP_SCHEME}//threads/environment-1/thread%3Amain`;
const payloadFor = (title: string, interruptionLevel: string) => ({
  title,
  message: "Fix login bug (t3code)",
  thread_id: "thread:main",
  open_url: openUrl,
  interruption_level: interruptionLevel,
});

interface Scenario {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  /** Successive reads of pjs-notify.json; undefined is a missing file, the last entry repeats. */
  readonly configs?: ReadonlyArray<string | undefined>;
  readonly idleSeconds?: Option.Option<number>;
  readonly shells?: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly project?: Option.Option<Project>;
  readonly respond?: (attempt: number) => Effect.Effect<Response>;
  /** Epoch milliseconds the notifier starts at; earlier transitions are history. */
  readonly startAt?: number;
  readonly beforeTimeout?: Effect.Effect<void>;
}

const run = (scenario: Scenario) => {
  const posts: Array<{
    url: string;
    method: string;
    headers: unknown;
    body: Record<string, unknown>;
  }> = [];
  const logs: Array<{ level: string; message: unknown }> = [];
  const spans: Array<unknown> = [];
  const configs = scenario.configs ?? [CONFIG];
  let reads = 0;
  const shells = new Map((scenario.shells ?? [shell()]).map((entry) => [entry.id, entry]));
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      // Failed exits are recorded too: the trace file serializes their cause, message included.
      span.end = (endTime, exit) => {
        end(endTime, exit);
        spans.push({
          name: span.name,
          attributes: Object.fromEntries(span.attributes),
          failure: exit._tag === "Failure" ? Cause.pretty(exit.cause) : undefined,
        });
      };
      return span;
    },
  });
  const logger = Logger.make(({ logLevel, message }) => {
    logs.push({ level: logLevel, message });
  });

  return Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    const dependencies = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.fromIterable(scenario.events).pipe(
          Stream.ensuring(Deferred.succeed(done, undefined)),
        ),
        getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeed(scenario.project ?? Option.some(projectNamed("t3code"))),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
      }),
      Layer.succeed(ServerConfig.ServerConfig, serverConfig),
      Layer.succeed(IdleTime.IdleTime, {
        seconds: Effect.succeed(scenario.idleSeconds ?? Option.none()),
      }),
      Path.layer,
      FileSystem.layerNoop({
        readFileString: (path) =>
          Effect.suspend(() => {
            const text = configs[Math.min(reads++, configs.length - 1)];
            return path === "/state/pjs-notify.json" && text !== undefined
              ? Effect.succeed(text)
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "readFileString",
                  }),
                );
          }),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            const attempt = posts.length;
            const body: Record<string, unknown> =
              request.body._tag === "Uint8Array"
                ? JSON.parse(new TextDecoder().decode(request.body.body))
                : {};
            posts.push({
              url: request.url,
              method: request.method,
              headers: request.headers,
              body,
            });
            const response = yield* (
              scenario.respond?.(attempt) ??
                Effect.succeed(Response.json({ success: true }, { status: 202 }))
            );
            return HttpClientResponse.fromWeb(request, response);
          }),
        ),
      ),
    );
    if (scenario.startAt !== undefined) yield* TestClock.setTime(scenario.startAt);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* PjsNotifier.start;
        if (scenario.beforeTimeout !== undefined) {
          yield* scenario.beforeTimeout;
          yield* TestClock.adjust("5 seconds");
        }
        yield* Deferred.await(done);
      }).pipe(Effect.provide(dependencies)),
    );
    const warnings = logs.filter((entry) => entry.level === "Warn").map((entry) => entry.message);
    // Neither logs nor spans may carry the webhook secret.
    expect(JSON.stringify([logs, spans])).not.toContain("br_secret_token_123");
    return { posts, warnings };
  }).pipe(
    Effect.provide(
      Layer.merge(
        Logger.layer([logger], { mergeWithExisting: false }),
        Layer.succeed(References.MinimumLogLevel, "Info"),
      ),
    ),
    Effect.withTracer(tracer),
  );
};

interface Delivered {
  readonly posts: ReadonlyArray<{ readonly body: Record<string, unknown> }>;
}
const bodies = (result: Delivered) => result.posts.map((post) => post.body);
const titles = (result: Delivered) => result.posts.map((post) => post.body.title);

describe("PjsNotifier", () => {
  it.effect("posts each kind of event to the webhook with its brrr payload", () =>
    Effect.gen(function* () {
      const result = yield* run({
        events: [
          requestUpdated("command", "pending", "request:approval"),
          requestUpdated("user_input", "pending", "request:question"),
          runUpdated("completed", "run:ok"),
          runUpdated("failed", "run:bad"),
        ],
      });
      expect(bodies(result)).toEqual([
        payloadFor("Approval needed", "time-sensitive"),
        payloadFor("Question", "time-sensitive"),
        payloadFor("Turn finished", "active"),
        payloadFor("Turn failed", "active"),
      ]);
      expect(result.posts.map((post) => [post.method, post.url])).toEqual(
        Array.from({ length: 4 }, () => ["POST", WEBHOOK_URL]),
      );
      expect(result.posts[0]?.headers).toMatchObject({ "content-type": "application/json" });
      expect(result.warnings).toEqual([]);
    }),
  );

  it.effect("names only the thread when its project is unknown", () =>
    Effect.gen(function* () {
      const result = yield* run({
        events: [requestUpdated("file-change")],
        project: Option.none(),
      });
      expect(bodies(result)).toEqual([
        { ...payloadFor("Approval needed", "time-sensitive"), message: "Fix login bug" },
      ]);
    }),
  );

  it.effect("sends approvals and questions at once, however recently the Mac was used", () =>
    Effect.gen(function* () {
      const result = yield* run({
        events: [
          requestUpdated("permission", "pending", "request:approval"),
          requestUpdated("user_input", "pending", "request:question"),
        ],
        idleSeconds: Option.some(0),
      });
      expect(titles(result)).toEqual(["Approval needed", "Question"]);
    }),
  );

  it.effect.each([
    { idle: Option.some(179), sends: false },
    { idle: Option.some(180), sends: true },
    { idle: Option.some(4_000), sends: true },
    { idle: Option.none<number>(), sends: true },
  ])("sends turn ends only after the idle threshold: $idle", ({ idle, sends }) =>
    Effect.gen(function* () {
      const result = yield* run({
        events: [runUpdated("completed", "run:ok"), runUpdated("failed", "run:bad")],
        idleSeconds: idle,
      });
      expect(result.posts).toHaveLength(sends ? 2 : 0);
    }),
  );

  it.effect("takes the idle threshold from the config file", () =>
    Effect.gen(function* () {
      const result = yield* run({
        events: [runUpdated("completed")],
        configs: [JSON.stringify({ url: WEBHOOK_URL, idleSeconds: 30 })],
        idleSeconds: Option.some(40),
      });
      expect(result.posts).toHaveLength(1);
    }),
  );

  it.effect("honors each per-event switch", () =>
    Effect.gen(function* () {
      const events = [
        requestUpdated("command", "pending", "request:approval"),
        requestUpdated("user_input", "pending", "request:question"),
        runUpdated("completed", "run:ok"),
        runUpdated("failed", "run:bad"),
      ];
      const titlesWith = (overrides: Record<string, boolean>) =>
        run({ events, configs: [JSON.stringify({ url: WEBHOOK_URL, ...overrides })] }).pipe(
          Effect.map(titles),
        );
      expect(yield* titlesWith({ notifyOnApproval: false })).toEqual([
        "Question",
        "Turn finished",
        "Turn failed",
      ]);
      expect(yield* titlesWith({ notifyOnInput: false })).toEqual([
        "Approval needed",
        "Turn finished",
        "Turn failed",
      ]);
      expect(yield* titlesWith({ notifyOnCompletion: false })).toEqual([
        "Approval needed",
        "Question",
        "Turn failed",
      ]);
      expect(yield* titlesWith({ notifyOnFailure: false })).toEqual([
        "Approval needed",
        "Question",
        "Turn finished",
      ]);
    }),
  );

  it.effect("stays silent without a config file", () =>
    Effect.gen(function* () {
      const result = yield* run({
        events: [requestUpdated("command"), runUpdated("completed")],
        configs: [undefined],
      });
      expect(result.posts).toEqual([]);
      expect(result.warnings).toEqual([]);
    }),
  );

  it.effect.each([
    { name: "malformed JSON", text: '{"url": ' },
    { name: "no url", text: JSON.stringify({ idleSeconds: 10 }) },
    { name: "a url that is not http(s)", text: JSON.stringify({ url: "brrr.now/secret" }) },
    { name: "a negative idle time", text: JSON.stringify({ url: WEBHOOK_URL, idleSeconds: -1 }) },
    {
      name: "a switch that is not a boolean",
      text: JSON.stringify({ url: WEBHOOK_URL, notifyOnApproval: "yes" }),
    },
  ])("warns once and stays off for an invalid config file: $name", ({ text }) =>
    Effect.gen(function* () {
      const result = yield* run({
        events: [requestUpdated("command", "pending", "request:1"), runUpdated("failed")],
        configs: [text],
      });
      expect(result.posts).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    }),
  );

  it.effect("applies edits to the config file without a restart", () =>
    Effect.gen(function* () {
      const result = yield* run({
        events: [
          requestUpdated("command", "pending", "request:1"),
          requestUpdated("command", "pending", "request:2"),
          requestUpdated("command", "pending", "request:3"),
          requestUpdated("command", "pending", "request:4"),
          requestUpdated("command", "pending", "request:5"),
        ],
        configs: [
          '{"url": "https://hooks.example.test/v1/br_secret_token_123"',
          '{"url": "https://hooks.example.test/v1/br_secret_token_123"',
          CONFIG,
          JSON.stringify({ url: WEBHOOK_URL, notifyOnApproval: false }),
          undefined,
        ],
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.posts).toHaveLength(1);
    }),
  );

  it.effect("sends one push per runtime request and per run, never for their updates", () =>
    Effect.gen(function* () {
      const result = yield* run({
        events: [
          requestUpdated("command", "pending", "request:1"),
          requestUpdated("command", "pending", "request:1"),
          requestUpdated("command", "resolved", "request:1"),
          requestUpdated("user_input", "pending", "request:2"),
          requestUpdated("user_input", "expired", "request:2"),
          requestUpdated("auth_refresh", "pending", "request:3"),
          requestUpdated("dynamic_tool_call", "pending", "request:4"),
          runUpdated("running", "run:1"),
          runUpdated("completed", "run:1"),
          runUpdated("completed", "run:1"),
          runUpdated("interrupted", "run:2"),
          runUpdated("cancelled", "run:3"),
          runUpdated("rolled_back", "run:4"),
          runUpdated("failed", "run:5"),
          runUpdated("failed", "run:5"),
        ],
      });
      expect(titles(result)).toEqual([
        "Approval needed",
        "Question",
        "Turn finished",
        "Turn failed",
      ]);
    }),
  );

  it.effect("treats work that finished before the notifier started as history", () =>
    Effect.gen(function* () {
      const started = DateTime.add(now, { minutes: 1 });
      const result = yield* run({
        startAt: DateTime.toEpochMillis(started),
        events: [
          requestUpdated("command", "pending", "request:old", MAIN, now),
          runUpdated("completed", "run:old", MAIN, now),
          runUpdated("failed", "run:old-failure", MAIN, now),
          requestUpdated("command", "pending", "request:live", MAIN, started),
          runUpdated("completed", "run:live", MAIN, started),
        ],
      });
      expect(titles(result)).toEqual(["Approval needed", "Turn finished"]);
    }),
  );

  it.effect("ignores turn ends of subagents and side chats, and anything in dead threads", () =>
    Effect.gen(function* () {
      const missing = ThreadId.make("thread:missing");
      const result = yield* run({
        events: [
          runUpdated("completed", "run:1", CHILD),
          runUpdated("failed", "run:2", SIDE),
          requestUpdated("command", "pending", "request:3", ARCHIVED),
          runUpdated("completed", "run:3", ARCHIVED),
          requestUpdated("command", "pending", "request:4", missing),
          runUpdated("completed", "run:4", missing),
          runUpdated("completed", "run:5", MAIN),
        ],
        shells: [
          shell(),
          subagent(CHILD, MAIN),
          sideChat(SIDE, MAIN),
          shell({ id: ARCHIVED, archivedAt: now }),
        ],
      });
      expect(titles(result)).toEqual(["Turn finished"]);
    }),
  );

  it.effect("rolls what blocks a subagent or side chat up to the thread it is listed under", () =>
    Effect.gen(function* () {
      const nested = ThreadId.make("thread:nested");
      const gone = ThreadId.make("thread:gone");
      const childOfGone = ThreadId.make("thread:child-of-gone");
      const loopA = ThreadId.make("thread:loop-a");
      const loopB = ThreadId.make("thread:loop-b");
      const result = yield* run({
        events: [
          requestUpdated("command", "pending", "request:1", CHILD),
          requestUpdated("user_input", "pending", "request:2", nested),
          requestUpdated("permission", "pending", "request:3", SIDE),
          requestUpdated("user_input", "pending", "request:4", NATIVE),
          requestUpdated("command", "pending", "request:5", ORPHAN),
          requestUpdated("command", "pending", "request:6", childOfGone),
          requestUpdated("command", "pending", "request:7", CHILD_OF_ARCHIVED),
          requestUpdated("command", "pending", "request:8", loopA),
        ],
        idleSeconds: Option.some(0),
        shells: [
          shell(),
          shell({ id: ARCHIVED, archivedAt: now }),
          subagent(CHILD, MAIN, "Research sources"),
          subagent(nested, CHILD, "Check the docs"),
          sideChat(SIDE, MAIN, "Side question"),
          shell({ ...subagent(NATIVE, MAIN, "Native helper"), creationSource: "provider" }),
          subagent(ORPHAN, null),
          subagent(childOfGone, gone),
          subagent(CHILD_OF_ARCHIVED, ARCHIVED),
          subagent(loopA, loopB),
          subagent(loopB, loopA),
        ],
      });
      expect(bodies(result)).toEqual([
        {
          ...payloadFor("Approval needed", "time-sensitive"),
          message: "Fix login bug (t3code) · asked by Research sources",
        },
        {
          ...payloadFor("Question", "time-sensitive"),
          message: "Fix login bug (t3code) · asked by Check the docs",
        },
        {
          ...payloadFor("Approval needed", "time-sensitive"),
          message: "Fix login bug (t3code) · asked by Side question",
        },
        {
          ...payloadFor("Question", "time-sensitive"),
          message: "Fix login bug (t3code) · asked by Native helper",
        },
      ]);
    }),
  );

  it.effect("holds a turn end back while a follow-up run keeps the thread busy", () =>
    Effect.gen(function* () {
      const events = [runUpdated("completed", "run:1"), requestUpdated("command")];
      const running = yield* run({
        events,
        shells: [shell({ activityRunStatus: "running", status: "running" })],
      });
      expect(titles(running)).toEqual(["Approval needed"]);
      const queued = yield* run({ events, shells: [shell({ status: "queued" })] });
      expect(titles(queued)).toEqual(["Approval needed"]);
    }),
  );

  it.effect("logs a failed delivery without the webhook URL and keeps notifying", () =>
    Effect.gen(function* () {
      const result = yield* run({
        events: [
          requestUpdated("command", "pending", "request:1"),
          requestUpdated("command", "pending", "request:2"),
        ],
        respond: (attempt) =>
          Effect.succeed(
            attempt === 0
              ? Response.json({ error: "bad webhook" }, { status: 403 })
              : Response.json({ success: true }, { status: 202 }),
          ),
      });
      expect(result.posts).toHaveLength(2);
      expect(result.warnings).toEqual([
        [
          "PJS notification failed",
          { kind: "approval", threadId: MAIN, failure: "StatusCodeError", status: 403 },
        ],
      ]);
    }),
  );

  it.effect("gives up on a webhook that does not answer within a few seconds", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const result = yield* run({
        events: [
          requestUpdated("command", "pending", "request:1"),
          requestUpdated("command", "pending", "request:2"),
        ],
        respond: (attempt) =>
          attempt === 0
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(Response.json({ success: true }, { status: 202 })),
        beforeTimeout: Deferred.await(started),
      });
      expect(result.posts).toHaveLength(2);
      expect(result.warnings).toEqual([
        ["PJS notification failed", { kind: "approval", threadId: MAIN, failure: "Timeout" }],
      ]);
    }),
  );
});
