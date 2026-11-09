import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";

export class IdleTime extends Context.Service<
  IdleTime,
  {
    /** Seconds since the last keyboard or mouse input; none when the platform cannot say. */
    readonly seconds: Effect.Effect<Option.Option<number>>;
  }
>()("t3/pjs/IdleTime") {}

// ioreg reports HIDIdleTime in nanoseconds.
export const parseHidIdleSeconds = (ioregOutput: string): Option.Option<number> => {
  const nanoseconds = /"?HIDIdleTime"?\s*=\s*(\d+)/.exec(ioregOutput)?.[1];
  return nanoseconds === undefined
    ? Option.none()
    : Option.some(Math.floor(Number(nanoseconds) / 1_000_000_000));
};

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const runner = yield* ProcessRunner.ProcessRunner;
  const seconds =
    platform === "darwin"
      ? runner
          .run({
            command: "ioreg",
            args: ["-c", "IOHIDSystem"],
            timeout: "2 seconds",
            timeoutBehavior: "timedOutResult",
          })
          .pipe(
            Effect.map((result) =>
              result.code === 0 ? parseHidIdleSeconds(result.stdout) : Option.none(),
            ),
            Effect.orElseSucceed(() => Option.none<number>()),
          )
      : Effect.succeedNone;
  return IdleTime.of({ seconds });
});

export const layer = Layer.effect(IdleTime, make);
