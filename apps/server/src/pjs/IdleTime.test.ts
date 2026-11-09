import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as IdleTime from "./IdleTime.ts";

const IOREG_OUTPUT = `+-o IOHIDSystem  <class IOHIDSystem, id 0x100000412, registered, matched, active, busy 0 (0 ms), retain 12>
    {
      "HIDParameters" = {"HIDClickTime"=500000000,"HIDPointerAcceleration"=45875}
      "HIDIdleTime" = 183900000000
    }`;

const output = (stdout: string, code: number | null): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code === null ? null : ChildProcessSpawner.ExitCode(code),
  timedOut: code === null,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const readSeconds = (input: {
  readonly platform: NodeJS.Platform;
  readonly run: ProcessRunner.ProcessRunner["Service"]["run"];
}) =>
  Effect.flatMap(IdleTime.IdleTime, (idleTime) => idleTime.seconds).pipe(
    Effect.provide(
      IdleTime.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProcessRunner.ProcessRunner, { run: input.run }),
            Layer.succeed(HostProcess.Platform, input.platform),
          ),
        ),
      ),
    ),
  );

describe("IdleTime", () => {
  it("reads HIDIdleTime nanoseconds as whole seconds", () => {
    expect(IdleTime.parseHidIdleSeconds(IOREG_OUTPUT)).toEqual(Option.some(183));
    expect(IdleTime.parseHidIdleSeconds('"HIDIdleTime" = 999999999')).toEqual(Option.some(0));
    expect(IdleTime.parseHidIdleSeconds("no idle counter here")).toEqual(Option.none());
  });

  it.effect("asks ioreg on macOS and reports unknown when it cannot answer", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const answering =
        (result: ProcessRunner.ProcessRunOutput) => (input: ProcessRunner.ProcessRunInput) => {
          commands.push(`${input.command} ${input.args.join(" ")}`);
          return Effect.succeed(result);
        };

      expect(
        yield* readSeconds({ platform: "darwin", run: answering(output(IOREG_OUTPUT, 0)) }),
      ).toEqual(Option.some(183));
      expect(commands).toEqual(["ioreg -c IOHIDSystem"]);

      expect(
        yield* readSeconds({ platform: "darwin", run: answering(output(IOREG_OUTPUT, 1)) }),
      ).toEqual(Option.none());
      expect(yield* readSeconds({ platform: "darwin", run: answering(output("", null)) })).toEqual(
        Option.none(),
      );
      expect(
        yield* readSeconds({
          platform: "darwin",
          run: () =>
            Effect.fail(
              new ProcessRunner.ProcessTimeoutError({
                command: "ioreg",
                argumentCount: 2,
                timeoutMs: 2_000,
              }),
            ),
        }),
      ).toEqual(Option.none());

      commands.length = 0;
      expect(
        yield* readSeconds({ platform: "linux", run: answering(output(IOREG_OUTPUT, 0)) }),
      ).toEqual(Option.none());
      expect(commands).toEqual([]);
    }),
  );
});
