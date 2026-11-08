import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { ForkIdentity } from "../../packages/shared/src/forkIdentity.ts";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: process.env.APP_VARIANT }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, ForkIdentity.appId, "com.t3tools.t3code", ForkIdentity.scheme],
  [
    "development",
    `${ForkIdentity.appId}.dev`,
    "com.t3tools.t3code.dev",
    `${ForkIdentity.scheme}-dev`,
  ],
  [
    "preview",
    `${ForkIdentity.appId}.preview`,
    "com.t3tools.t3code.preview",
    `${ForkIdentity.scheme}-preview`,
  ],
  ["production", ForkIdentity.appId, "com.t3tools.t3code", ForkIdentity.scheme],
])(
  "keeps the iOS and Android identifiers for APP_VARIANT=%j",
  async (value, iosIdentifier, androidPackage, scheme) => {
    const config = await loadConfig(value);
    expect(config.ios?.bundleIdentifier).toBe(iosIdentifier);
    expect(config.ios?.appleTeamId).toBe(ForkIdentity.appleTeamId);
    expect(config.scheme).toBe(scheme);
    expect(config.android?.package).toBe(androidPackage);
    const host = new URL(DEFAULT_HOSTED_APP_URL).host;
    expect(config.android?.intentFilters?.[0]?.data).toEqual([
      { scheme: "https", host, pathPrefix: "/threads/" },
    ]);
    expect(assetLinks.map((link) => link.target.package_name)).toContain(androidPackage);
  },
);

it("keeps the fork off T3's associated domains and OTA feed, with its own keychain group", async () => {
  const config = await loadConfig("production");
  expect(config.ios?.associatedDomains).toBeUndefined();
  expect(config.updates?.enabled).toBe(false);
  expect(config.updates?.url).toBeUndefined();
  expect(config.ios?.entitlements?.["keychain-access-groups"]).toEqual([
    `$(AppIdentifierPrefix)${ForkIdentity.appId}`,
  ]);
});
