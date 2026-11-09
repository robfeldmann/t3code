import {
  isListedThreadLineage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { DESKTOP_RENDERER_ORIGINS } from "../httpCors.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as IdleTime from "./IdleTime.ts";

const CONFIG_FILE_NAME = "pjs-notify.json";
const REQUEST_TIMEOUT = "5 seconds";
const SEEN_LIMIT = 512;
const MAX_ANCESTOR_DEPTH = 8;
// Mobile and desktop builds share one URL scheme, and the desktop renderer origin carries it;
// the fork's identity branch changes it there.
const APP_SCHEME = new URL(DESKTOP_RENDERER_ORIGINS[0]).protocol.slice(0, -1);

const PjsNotifyConfig = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/)),
  idleSeconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(180)),
  ),
  notifyOnApproval: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  notifyOnInput: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  notifyOnCompletion: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  notifyOnFailure: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(PjsNotifyConfig));

// Blocking requests always send; finished turns wait until the Mac has been idle.
const NOTIFICATIONS = {
  approval: {
    title: "Approval needed",
    interruptionLevel: "time-sensitive",
    enabledBy: "notifyOnApproval",
    waitsForIdle: false,
  },
  input: {
    title: "Question",
    interruptionLevel: "time-sensitive",
    enabledBy: "notifyOnInput",
    waitsForIdle: false,
  },
  completed: {
    title: "Turn finished",
    interruptionLevel: "active",
    enabledBy: "notifyOnCompletion",
    waitsForIdle: true,
  },
  failed: {
    title: "Turn failed",
    interruptionLevel: "active",
    enabledBy: "notifyOnFailure",
    waitsForIdle: true,
  },
} as const;
type NotificationKind = keyof typeof NOTIFICATIONS;

// A live event is one transition worth a push; repeats of it (an updated or resolved request, a
// run reporting completed again) share its key. Work that finished before this process started
// is history even when a restart re-emits it, such as a checkpoint landing on an old run.
const classify = (
  event: OrchestrationV2DomainEvent,
  startedAt: DateTime.Utc,
): { readonly kind: NotificationKind; readonly key: string } | undefined => {
  switch (event.type) {
    case "run.updated": {
      const { id, status, completedAt } = event.payload;
      if (status !== "completed" && status !== "failed") return undefined;
      return completedAt !== null && DateTime.isLessThan(completedAt, startedAt)
        ? undefined
        : { kind: status, key: `run:${id}` };
    }
    case "runtime-request.updated": {
      const { id, kind, status, createdAt } = event.payload;
      if (
        status !== "pending" ||
        kind === "auth_refresh" ||
        kind === "dynamic_tool_call" ||
        DateTime.isLessThan(createdAt, startedAt)
      ) {
        return undefined;
      }
      return { kind: kind === "user_input" ? "input" : "approval", key: `request:${id}` };
    }
    default:
      return undefined;
  }
};

const describeFailure = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  if (HttpClientError.isHttpClientError(error)) {
    return {
      failure: error.reason._tag,
      ...(error.reason._tag === "StatusCodeError" ? { status: error.reason.response.status } : {}),
    };
  }
  return { failure: Cause.isTimeoutError(error) ? "Timeout" : "Unknown" };
};

export const start = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const idleTime = yield* IdleTime.IdleTime;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const configPath = path.join(serverConfig.stateDir, CONFIG_FILE_NAME);

  // The file text a warning was last logged for: the config is re-read per event, and one broken
  // file must warn once, not once per event.
  const warnedFor = yield* Ref.make<string | undefined>(undefined);
  const warnOnce = (fingerprint: string, problem: string) =>
    Ref.getAndSet(warnedFor, fingerprint).pipe(
      Effect.flatMap((previous) =>
        previous === fingerprint
          ? Effect.void
          : Effect.logWarning(`${CONFIG_FILE_NAME} ${problem}; PJS notifications are off`, {
              path: configPath,
            }),
      ),
      Effect.as(Option.none<typeof PjsNotifyConfig.Type>()),
    );
  const readConfig = fileSystem.readFileString(configPath).pipe(
    Effect.flatMap((text) =>
      decodeConfig(text).pipe(
        Effect.tap(() => Ref.set(warnedFor, undefined)),
        Effect.asSome,
        Effect.catchTags({ SchemaError: () => warnOnce(text, "is invalid") }),
      ),
    ),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound"
          ? Ref.set(warnedFor, undefined).pipe(Effect.as(Option.none()))
          : warnOnce(error.reason._tag, "cannot be read"),
    }),
  );

  const seen = new Set<string>();
  const firstSighting = (key: string) => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > SEEN_LIMIT) {
      const [oldest] = seen;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  };

  // Untraced: the notify span is the tracing boundary, and a failed span would record the URL.
  const deliver = Effect.fnUntraced(function* (url: string, payload: Record<string, string>) {
    yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson(payload),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap((response) => response.text),
      Effect.timeout(REQUEST_TIMEOUT),
      // Client spans record the URL, and the webhook secret is in its path.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    );
  });

  // Subagents and side chats show under their parent, so a blocked child asks where it is listed.
  const listedAncestor = Effect.fn("PjsNotifier.listedAncestor")(function* (
    child: OrchestrationV2ThreadShell,
  ) {
    let thread = child;
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
      if (isListedThreadLineage(thread.lineage)) return thread;
      const parentId = thread.lineage.parentThreadId;
      const parent = parentId === null ? null : yield* orchestrator.getThreadShell(parentId);
      if (parent === null) return null;
      thread = parent;
    }
    return null;
  });

  const notify = Effect.fn("PjsNotifier.notify")(
    function* (event: OrchestrationV2DomainEvent, kind: NotificationKind) {
      const config = yield* readConfig;
      const notification = NOTIFICATIONS[kind];
      if (Option.isNone(config) || !config.value[notification.enabledBy]) return;
      const source = yield* orchestrator.getThreadShell(event.threadId);
      if (source === null || source.archivedAt !== null) return;
      // Turn ends belong to listed threads.
      if (!isListedThreadLineage(source.lineage) && notification.waitsForIdle) return;
      const thread = yield* listedAncestor(source);
      // A follow-up run means the thread has not gone idle.
      if (
        thread === null ||
        thread.archivedAt !== null ||
        (notification.waitsForIdle &&
          (thread.activityRunStatus != null || thread.status === "queued"))
      ) {
        return;
      }
      if (notification.waitsForIdle) {
        const idleSeconds = yield* idleTime.seconds;
        if (Option.isSome(idleSeconds) && idleSeconds.value < config.value.idleSeconds) return;
      }
      const [environmentId, project] = yield* Effect.all([
        serverEnvironment.getEnvironmentId,
        projects.getById(thread.projectId).pipe(Effect.orElseSucceed(() => Option.none())),
      ]);
      const listedMessage = Option.isSome(project)
        ? `${thread.title} (${project.value.title})`
        : thread.title;
      yield* deliver(config.value.url, {
        title: notification.title,
        message: thread === source ? listedMessage : `${listedMessage} · asked by ${source.title}`,
        thread_id: thread.id,
        open_url: `${APP_SCHEME}://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(thread.id)}`,
        interruption_level: notification.interruptionLevel,
      });
    },
    (effect, event, kind) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("PJS notification failed", {
            kind,
            threadId: event.threadId,
            ...describeFailure(cause),
          }),
        ),
      ),
  );

  // streamDomainEvents starts at the latest sequence, so stored history is never replayed.
  yield* forkParked(
    Effect.gen(function* () {
      const startedAt = yield* DateTime.now;
      yield* Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        const transition = classify(event, startedAt);
        return transition !== undefined && firstSighting(transition.key)
          ? notify(event, transition.kind)
          : Effect.void;
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("PJS notification event stream failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );
});

export const layer = Layer.effectDiscard(start).pipe(
  Layer.provide(IdleTime.layer),
  Layer.provide(ProcessRunner.layer),
);
