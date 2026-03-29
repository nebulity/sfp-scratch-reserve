import { describe, expect, it } from "vitest";

import { buildPoolFetchArgs, buildReleaseArgs, extractScratchUsername } from "./pool";

describe("extractScratchUsername", () => {
  it("extracts top-level username", () => {
    expect(extractScratchUsername('{"username":"user@example.com"}')).toBe("user@example.com");
  });

  it("extracts nested username under result", () => {
    expect(extractScratchUsername('{"result":{"username":"nested@example.com"}}')).toBe(
      "nested@example.com",
    );
  });

  it("prefers top-level username over nested", () => {
    expect(
      extractScratchUsername(
        '{"username":"top@example.com","result":{"username":"nested@example.com"}}',
      ),
    ).toBe("top@example.com");
  });

  it("returns null for missing username", () => {
    expect(extractScratchUsername('{"status":0}')).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(extractScratchUsername("not json")).toBeNull();
  });

  it("returns null for empty username", () => {
    expect(extractScratchUsername('{"username":"  "}')).toBeNull();
  });
});

describe("buildPoolFetchArgs", () => {
  it("builds args with all options", () => {
    expect(buildPoolFetchArgs("ci-pool", "devhub", "scratch", true)).toEqual([
      "pool",
      "fetch",
      "-t",
      "ci-pool",
      "-v",
      "devhub",
      "-a",
      "scratch",
      "-d",
      "--json",
    ]);
  });

  it("builds args without optional flags", () => {
    expect(buildPoolFetchArgs("ci-pool", "", "", false)).toEqual([
      "pool",
      "fetch",
      "-t",
      "ci-pool",
      "--json",
    ]);
  });
});

describe("buildReleaseArgs", () => {
  it("builds release args with devhub alias", () => {
    expect(buildReleaseArgs("devhub", "user@example.com")).toEqual([
      "data",
      "update",
      "record",
      "--target-org",
      "devhub",
      "--sobject",
      "ScratchOrgInfo",
      "--where",
      "SignupUsername='user@example.com'",
      "--values",
      "Allocation_status__c='Available'",
    ]);
  });

  it("builds release args without devhub alias", () => {
    expect(buildReleaseArgs("", "user@example.com")).toEqual([
      "data",
      "update",
      "record",
      "--sobject",
      "ScratchOrgInfo",
      "--where",
      "SignupUsername='user@example.com'",
      "--values",
      "Allocation_status__c='Available'",
    ]);
  });

  it("escapes single quotes in username", () => {
    const args = buildReleaseArgs("", "user'name@example.com");
    expect(args).toContain("SignupUsername='user\\'name@example.com'");
  });
});
