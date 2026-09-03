import { describe, expect, it } from "vitest";
import {
  associateTenantResources,
  deleteTenant,
  disassociateIdentity,
  ensureTenant,
  type SesTenantClient,
} from "../src/tenants.js";

const ARN = "arn:aws:ses:us-east-1:123456789012:tenant/team-1";
const named = (name: string) => Object.assign(new Error(name), { name });

/** Records every command; per-command answers or errors are injected. */
function fakeClient(behaviour: Record<string, unknown | Error> = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const client: SesTenantClient = {
    async send(command) {
      const name = command.constructor.name;
      calls.push({ name, input: (command as unknown as { input: Record<string, unknown> }).input });
      const answer = behaviour[name];
      if (answer instanceof Error) throw answer;
      return answer ?? {};
    },
  };
  return { client, calls };
}

describe("ensureTenant", () => {
  it("creates the tenant and reads the account id off its ARN", async () => {
    const { client, calls } = fakeClient({ CreateTenantCommand: { TenantArn: ARN } });
    expect(await ensureTenant(client, { tenantName: "team-1" })).toEqual({
      accountId: "123456789012",
    });
    expect(calls.map((c) => c.name)).toEqual(["CreateTenantCommand"]);
    expect(calls[0]?.input).toEqual({ TenantName: "team-1" });
  });

  it("adopts an existing tenant instead of failing", async () => {
    const { client, calls } = fakeClient({
      CreateTenantCommand: named("AlreadyExistsException"),
      GetTenantCommand: { Tenant: { TenantArn: ARN } },
    });
    expect(await ensureTenant(client, { tenantName: "team-1" })).toEqual({
      accountId: "123456789012",
    });
    expect(calls.map((c) => c.name)).toEqual(["CreateTenantCommand", "GetTenantCommand"]);
  });

  it("propagates other errors and refuses a response without an ARN", async () => {
    await expect(
      ensureTenant(fakeClient({ CreateTenantCommand: named("TooManyRequestsException") }).client, {
        tenantName: "team-1",
      }),
    ).rejects.toMatchObject({ name: "TooManyRequestsException" });
    await expect(ensureTenant(fakeClient().client, { tenantName: "team-1" })).rejects.toThrow(
      /no ARN/,
    );
  });
});

describe("associateTenantResources", () => {
  it("associates the identity and the configuration set by ARN, tolerating repeats", async () => {
    const { client, calls } = fakeClient();
    await associateTenantResources(client, {
      tenantName: "team-1",
      accountId: "123456789012",
      region: "sa-east-1",
      identity: "mail.acme.dev",
      configurationSet: "millionsend",
    });
    expect(calls.map((c) => c.input.ResourceArn)).toEqual([
      "arn:aws:ses:sa-east-1:123456789012:identity/mail.acme.dev",
      "arn:aws:ses:sa-east-1:123456789012:configuration-set/millionsend",
    ]);
    // Re-running is idempotent: AlreadyExists is the expected answer.
    const again = fakeClient({
      CreateTenantResourceAssociationCommand: named("AlreadyExistsException"),
    });
    await associateTenantResources(again.client, {
      tenantName: "team-1",
      accountId: "123456789012",
      region: "sa-east-1",
      identity: "mail.acme.dev",
    });
    expect(again.calls).toHaveLength(1);
  });
});

describe("disassociateIdentity / deleteTenant", () => {
  it("detaches the identity using the tenant's account id", async () => {
    const { client, calls } = fakeClient({ GetTenantCommand: { Tenant: { TenantArn: ARN } } });
    await disassociateIdentity(client, {
      tenantName: "team-1",
      region: "us-east-1",
      identity: "acme.dev",
    });
    expect(calls.map((c) => c.name)).toEqual([
      "GetTenantCommand",
      "DeleteTenantResourceAssociationCommand",
    ]);
    expect(calls[1]?.input).toEqual({
      TenantName: "team-1",
      ResourceArn: "arn:aws:ses:us-east-1:123456789012:identity/acme.dev",
    });
  });

  it("treats a tenant or association already gone as done", async () => {
    await expect(
      disassociateIdentity(fakeClient({ GetTenantCommand: named("NotFoundException") }).client, {
        tenantName: "team-1",
        region: "us-east-1",
        identity: "acme.dev",
      }),
    ).resolves.toBeUndefined();
    await expect(
      deleteTenant(fakeClient({ DeleteTenantCommand: named("NotFoundException") }).client, {
        tenantName: "team-1",
      }),
    ).resolves.toBeUndefined();
    await expect(
      deleteTenant(fakeClient({ DeleteTenantCommand: named("BadRequestException") }).client, {
        tenantName: "team-1",
      }),
    ).rejects.toMatchObject({ name: "BadRequestException" });
  });
});
