import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDevHubLoginArgs,
  buildDevHubProbeArgs,
  buildPoolFetchArgs,
  buildScratchOrgUpdateArgs,
  extractScratchUsername,
  parseBooleanInput,
  parsePositiveInteger,
  parseRequiredString,
  resolveInputEnvKeys,
  resolveSfpCommand,
} from "./pool";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("input parsing", () => {
  it("parses required strings", () => {
    expect(parseRequiredString(" value ", "pool-tag")).toBe("value");
  });

  it("throws for empty required strings", () => {
    expect(() => parseRequiredString("   ", "pool-tag")).toThrow('Input "pool-tag" is required.');
  });

  it("parses positive integers", () => {
    expect(parsePositiveInteger("30", "fetch-attempts")).toBe(30);
  });

  it("throws for non-positive integers", () => {
    expect(() => parsePositiveInteger("0", "fetch-attempts")).toThrow(
      'Input "fetch-attempts" must be a positive integer. Received "0".',
    );
  });

  it("parses booleans", () => {
    expect(parseBooleanInput("true", "set-default-target-org")).toBe(true);
    expect(parseBooleanInput("false", "set-default-target-org")).toBe(false);
  });

  it("throws for invalid booleans", () => {
    expect(() => parseBooleanInput("maybe", "set-default-target-org")).toThrow(
      'Input "set-default-target-org" must be either "true" or "false". Received "maybe".',
    );
  });
});

describe("output parsing", () => {
  it("extracts top-level username from JSON output", () => {
    const output = '{"status":0,"username":"user@example.com"}';
    expect(extractScratchUsername(output)).toBe("user@example.com");
  });

  it("extracts nested username from JSON output", () => {
    const output = '{"status":0,"result":{"username":"nested@example.com"}}';
    expect(extractScratchUsername(output)).toBe("nested@example.com");
  });

  it("returns null when username is missing", () => {
    const output = '{"status":0,"result":{}}';
    expect(extractScratchUsername(output)).toBeNull();
  });
});

describe("argument builders", () => {
  it("builds pool fetch args with devhub", () => {
    expect(buildPoolFetchArgs("ci-pool", "devhub")).toEqual([
      "pool:fetch",
      "-t",
      "ci-pool",
      "-v",
      "devhub",
      "--json",
    ]);
  });

  it("builds scratch update args without devhub", () => {
    expect(buildScratchOrgUpdateArgs("", "user@example.com", "Reserve")).toEqual([
      "data",
      "update",
      "record",
      "--sobject",
      "ScratchOrgInfo",
      "--where",
      "SignupUsername='user@example.com'",
      "--values",
      "Allocation_status__c='Reserve'",
    ]);
  });

  it("builds devhub probe args with and without alias", () => {
    expect(buildDevHubProbeArgs("devhub")).toEqual([
      "org",
      "display",
      "--target-org",
      "devhub",
      "--json",
    ]);
    expect(buildDevHubProbeArgs("")).toEqual(["org", "display", "--target-dev-hub", "--json"]);
  });

  it("builds devhub login args", () => {
    expect(buildDevHubLoginArgs("devhub", true)).toEqual([
      "org",
      "login",
      "sfdx-url",
      "--alias",
      "devhub",
      "--set-default-dev-hub",
      "--sfdx-url-stdin",
      "-",
    ]);
  });

  it("resolves input env keys including underscore variant", () => {
    expect(resolveInputEnvKeys("pool-tag")).toEqual(["INPUT_POOL-TAG", "INPUT_POOL_TAG"]);
  });
});

describe("sfp command resolution", () => {
  it("falls back to global sfp binary", () => {
    expect(resolveSfpCommand()).toBe("sfp");
  });
});
