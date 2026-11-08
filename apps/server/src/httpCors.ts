import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import { ForkIdentity } from "@t3tools/shared/forkIdentity";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

export const DESKTOP_RENDERER_ORIGINS = [
  `${ForkIdentity.scheme}://app`,
  "t3code-dev://app",
] as const;
