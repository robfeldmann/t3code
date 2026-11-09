import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type Project,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as IdleTime from "./IdleTime.ts";
import * as PjsNotifier from "./PjsNotifier.ts";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const at = (offsetMs: number) => DateTime.makeUnsafe(NOW + offsetMs);
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for notifications"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestration = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "pjs-notify" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("pushes once per live transition from real events and thread shells", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const history = ThreadId.make("thread:history");
    const live = ThreadId.make("thread:live");
    for (const [threadId, title] of [
      [history, "History thread"],
      [live, "Live thread"],
    ] as const) {
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create-${threadId}`),
        threadId,
        projectId: ProjectId.make("project:live"),
        title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }

    let written = 0;
    const runEvent = (
      threadId: ThreadId,
      name: string,
      ordinal: number,
      completedAt: DateTime.Utc,
    ): OrchestrationV2DomainEvent => ({
      id: EventId.make(`event:${name}:${written++}`),
      type: "run.updated",
      threadId,
      occurredAt: completedAt,
      payload: {
        id: RunId.make(name),
        threadId,
        ordinal,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`message:${name}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: completedAt,
        startedAt: completedAt,
        completedAt,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    const requestEvent = (
      threadId: ThreadId,
      name: string,
      status: "pending" | "resolved",
      createdAt: DateTime.Utc,
    ): OrchestrationV2DomainEvent => ({
      id: EventId.make(`event:${name}:${status}:${written++}`),
      type: "runtime-request.updated",
      threadId,
      occurredAt: createdAt,
      payload: {
        id: RuntimeRequestId.make(name),
        nodeId: NodeId.make(`node:${name}`),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status,
        responseCapability: { type: "message" },
        createdAt,
        resolvedAt: status === "pending" ? null : createdAt,
      },
    });

    const posts: Array<Record<string, unknown>> = [];
    const expectedPosts = 3;
    const delivered = yield* Deferred.make<void>();
    // Only the title of a project and the state directory of the config are read.
    const layerFakes = Layer.mergeAll(
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeedSome({ title: "Live project" } as Project),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
      }),
      Layer.succeed(ServerConfig.ServerConfig, {
        stateDir: "/state",
      } as ServerConfig.ServerConfig["Service"]),
      Layer.succeed(IdleTime.IdleTime, { seconds: Effect.succeedNone }),
      Path.layer,
      FileSystem.layerNoop({
        readFileString: () =>
          Effect.succeed(JSON.stringify({ url: "https://hooks.example.test/v1/br_secret" })),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            posts.push(
              request.body._tag === "Uint8Array"
                ? JSON.parse(new TextDecoder().decode(request.body.body))
                : {},
            );
            if (posts.length === expectedPosts) yield* Deferred.succeed(delivered, undefined);
            return HttpClientResponse.fromWeb(request, Response.json({ success: true }));
          }),
        ),
      ),
    );

    // A copy of the real stream's recipe (read the latest sequence, then everything after it) that
    // signals once the read happened, so live events are safe to write. It keeps the test off the
    // scheduler's timing but means upstream's own stream wiring is not exercised here.
    const cutoffRead = yield* Deferred.make<void>();
    const signalling = Orchestrator.OrchestratorV2.of({
      ...orchestrator,
      streamDomainEvents: Stream.unwrap(
        Effect.gen(function* () {
          const latest = yield* eventSink.latestSequence();
          yield* Deferred.succeed(cutoffRead, undefined);
          return eventSink.stream({ afterSequence: latest });
        }),
      ).pipe(
        Stream.map((stored) => stored.event),
        Stream.orDie,
      ),
    });

    // Stamped as recent as live work, so only the copied stream's cutoff keeps them out.
    yield* eventSink.write({
      events: [
        requestEvent(history, "history-request", "pending", at(1)),
        runEvent(history, "history-run", 1, at(1)),
      ],
    });

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* PjsNotifier.start;
        yield* Deferred.await(cutoffRead);
        yield* eventSink.write({
          events: [
            requestEvent(live, "live-request", "pending", at(1)),
            requestEvent(live, "live-request", "pending", at(1)),
            requestEvent(live, "live-request", "resolved", at(1)),
            // A run that ended before the start reporting completed again, as when a checkpoint
            // lands after a restart.
            runEvent(live, "stale-run", 1, at(-60_000)),
            runEvent(live, "live-run", 2, at(1)),
            runEvent(live, "live-run", 2, at(1)),
            requestEvent(live, "last-request", "pending", at(1)),
          ],
        });
        yield* Deferred.await(delivered);
      }).pipe(
        Effect.provide(layerFakes),
        Effect.provideService(Orchestrator.OrchestratorV2, signalling),
      ),
    );

    expect(posts.map((post) => [post.title, post.thread_id])).toEqual([
      ["Approval needed", "thread:live"],
      ["Turn finished", "thread:live"],
      ["Approval needed", "thread:live"],
    ]);
    expect(posts[1]).toMatchObject({ message: "Live thread (Live project)" });
  }).pipe(Effect.provide(layerOrchestration)),
);
