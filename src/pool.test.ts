import { describe, expect, it } from "vitest";

import {
  buildAvailableOrgsSoql,
  buildClaimUrl,
  buildQueryUrl,
  buildReleaseArgs,
  parseDevHubAuth,
  shuffle,
  toHttpDate,
} from "./pool";

describe("parseDevHubAuth", () => {
  it("extracts accessToken, instanceUrl, username from sf org display --verbose --json output", () => {
    const output = JSON.stringify({
      status: 0,
      result: {
        accessToken: "00Dxx!AQ",
        instanceUrl: "https://devhub.my.salesforce.com",
        username: "devhub@example.com",
      },
    });
    expect(parseDevHubAuth(output)).toEqual({
      accessToken: "00Dxx!AQ",
      instanceUrl: "https://devhub.my.salesforce.com",
      username: "devhub@example.com",
    });
  });

  it("throws when accessToken is missing", () => {
    const output = JSON.stringify({
      result: { instanceUrl: "https://x", username: "u" },
    });
    expect(() => parseDevHubAuth(output)).toThrow(/accessToken/);
  });

  it("throws when instanceUrl is missing", () => {
    const output = JSON.stringify({
      result: { accessToken: "t", username: "u" },
    });
    expect(() => parseDevHubAuth(output)).toThrow(/instanceUrl/);
  });

  it("throws for invalid JSON", () => {
    expect(() => parseDevHubAuth("not json")).toThrow();
  });
});

describe("buildAvailableOrgsSoql", () => {
  it("includes pool tag, Available status, Active, and default limit", () => {
    const soql = buildAvailableOrgsSoql("ci");
    expect(soql).toContain("Allocation_status__c = 'Available'");
    expect(soql).toContain("Pooltag__c = 'ci'");
    expect(soql).toContain("Status = 'Active'");
    expect(soql).toContain("LIMIT 10");
    expect(soql).toContain("SfdxAuthUrl__c");
    expect(soql).toContain("LastModifiedDate");
  });

  it("respects custom limit", () => {
    expect(buildAvailableOrgsSoql("ci", 3)).toContain("LIMIT 3");
  });

  it("escapes single quotes in pool tag", () => {
    expect(buildAvailableOrgsSoql("pool'name")).toContain("Pooltag__c = 'pool\\'name'");
  });
});

describe("buildQueryUrl", () => {
  it("builds a query URL with encoded SOQL", () => {
    const url = buildQueryUrl("https://devhub.my.salesforce.com", "SELECT Id FROM ScratchOrgInfo");
    expect(url).toBe(
      "https://devhub.my.salesforce.com/services/data/v59.0/query?q=SELECT%20Id%20FROM%20ScratchOrgInfo",
    );
  });

  it("strips trailing slash from instanceUrl", () => {
    const url = buildQueryUrl("https://devhub.my.salesforce.com/", "SELECT Id FROM ScratchOrgInfo");
    expect(url).toMatch(/devhub\.my\.salesforce\.com\/services\/data\/v59\.0\/query/);
  });
});

describe("buildClaimUrl", () => {
  it("builds a sobject PATCH URL with record Id", () => {
    expect(buildClaimUrl("https://devhub.my.salesforce.com", "a0B000000XyZ")).toBe(
      "https://devhub.my.salesforce.com/services/data/v59.0/sobjects/ScratchOrgInfo/a0B000000XyZ",
    );
  });

  it("strips trailing slash from instanceUrl", () => {
    expect(buildClaimUrl("https://devhub.my.salesforce.com/", "a0B000000XyZ")).toBe(
      "https://devhub.my.salesforce.com/services/data/v59.0/sobjects/ScratchOrgInfo/a0B000000XyZ",
    );
  });
});

describe("toHttpDate", () => {
  it("converts a Salesforce ISO timestamp to RFC 7231 HTTP-Date", () => {
    expect(toHttpDate("2026-04-14T03:39:40.000+0000")).toBe("Tue, 14 Apr 2026 03:39:40 GMT");
  });

  it("throws on invalid date", () => {
    expect(() => toHttpDate("not-a-date")).toThrow(/Invalid LastModifiedDate/);
  });
});

describe("shuffle", () => {
  it("returns an array of the same length", () => {
    expect(shuffle([1, 2, 3, 4, 5])).toHaveLength(5);
  });

  it("returns the same elements", () => {
    const result = shuffle([1, 2, 3, 4, 5]);
    expect([...result].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not mutate the input array", () => {
    const input = [1, 2, 3];
    const before = [...input];
    shuffle(input);
    expect(input).toEqual(before);
  });

  it("returns an empty array unchanged", () => {
    expect(shuffle([])).toEqual([]);
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
