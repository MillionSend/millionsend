import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  PutConfigurationSetDeliveryOptionsCommand,
  UpdateConfigurationSetEventDestinationCommand,
} from "@aws-sdk/client-sesv2";
import { describe, expect, it } from "vitest";
import {
  applyDomainConfiguration,
  type DomainConfiguration,
  domainConfigurationSetName,
  ensureDomainConfigurationSet,
  type SesConfigClient,
} from "../src/domain-config.js";

const BASE: DomainConfiguration = {
  domainName: "updates.example.com",
  region: "us-east-1",
  snsTopicArn: "arn:aws:sns:us-east-1:123456789012:millionsend-events",
  tlsMode: "opportunistic",
};

function fakeClient(respond: (command: object) => unknown = () => ({})) {
  const calls: object[] = [];
  const client: SesConfigClient = {
    async send(command) {
      calls.push(command);
      return respond(command);
    },
  };
  return { client, calls };
}

function commandOf<T>(calls: object[], ctor: new (...args: never[]) => T): T {
  const found = calls.find((c) => c instanceof ctor);
  if (!found) throw new Error(`no ${ctor.name} sent`);
  return found as T;
}

describe("domainConfigurationSetName", () => {
  it("sanitizes the domain into a deterministic name", () => {
    expect(domainConfigurationSetName("Updates.Example.com")).toBe(
      "millionsend-updates-example-com",
    );
  });
});

describe("applyDomainConfiguration", () => {
  it("maps enforced tlsMode to TlsPolicy REQUIRE", async () => {
    const { client, calls } = fakeClient();
    await applyDomainConfiguration(client, { ...BASE, tlsMode: "enforced" });
    expect(commandOf(calls, PutConfigurationSetDeliveryOptionsCommand).input).toEqual({
      ConfigurationSetName: "millionsend-updates-example-com",
      TlsPolicy: "REQUIRE",
    });
  });

  it("maps opportunistic tlsMode to TlsPolicy OPTIONAL", async () => {
    const { client, calls } = fakeClient();
    await applyDomainConfiguration(client, { ...BASE, tlsMode: "opportunistic" });
    expect(commandOf(calls, PutConfigurationSetDeliveryOptionsCommand).input.TlsPolicy).toBe(
      "OPTIONAL",
    );
  });

  it("subscribes to delivery events only — never OPEN or CLICK (app-layer owns engagement)", async () => {
    const { client, calls } = fakeClient();
    await applyDomainConfiguration(client, BASE);
    const types = commandOf(calls, UpdateConfigurationSetEventDestinationCommand).input
      .EventDestination?.MatchingEventTypes;
    expect(types).not.toContain("OPEN");
    expect(types).not.toContain("CLICK");
    expect(types).toEqual([
      "SEND",
      "DELIVERY",
      "DELIVERY_DELAY",
      "BOUNCE",
      "COMPLAINT",
      "REJECT",
      "RENDERING_FAILURE",
    ]);
  });

  it("never touches tracking options (no custom redirect domain, SES stays out of the body)", async () => {
    const { client, calls } = fakeClient();
    await applyDomainConfiguration(client, BASE);
    expect(calls.map((c) => c.constructor.name)).not.toContain(
      "PutConfigurationSetTrackingOptionsCommand",
    );
  });

  it("creates the event destination when it does not yet exist", async () => {
    const { client, calls } = fakeClient((command) => {
      if (command instanceof UpdateConfigurationSetEventDestinationCommand) {
        throw Object.assign(new Error("not found"), { name: "NotFoundException" });
      }
      return {};
    });
    await applyDomainConfiguration(client, BASE);
    expect(
      commandOf(calls, CreateConfigurationSetEventDestinationCommand).input.EventDestination,
    ).toBeDefined();
  });
});

describe("ensureDomainConfigurationSet", () => {
  it("creates the set then converges TLS + events, returning the name", async () => {
    const { client, calls } = fakeClient();
    const name = await ensureDomainConfigurationSet(client, { ...BASE, tlsMode: "enforced" });
    expect(name).toBe("millionsend-updates-example-com");
    expect(calls.map((c) => c.constructor.name)).toEqual([
      "CreateConfigurationSetCommand",
      "PutConfigurationSetDeliveryOptionsCommand",
      "UpdateConfigurationSetEventDestinationCommand",
    ]);
    expect(commandOf(calls, PutConfigurationSetDeliveryOptionsCommand).input.TlsPolicy).toBe(
      "REQUIRE",
    );
  });

  it("adopts an already-existing configuration set and still converges (idempotent re-run)", async () => {
    const { client, calls } = fakeClient((command) => {
      if (command instanceof CreateConfigurationSetCommand) {
        throw Object.assign(new Error("exists"), { name: "AlreadyExistsException" });
      }
      return {};
    });
    const name = await ensureDomainConfigurationSet(client, BASE);
    expect(name).toBe("millionsend-updates-example-com");
    expect(commandOf(calls, PutConfigurationSetDeliveryOptionsCommand)).toBeDefined();
    expect(commandOf(calls, UpdateConfigurationSetEventDestinationCommand)).toBeDefined();
  });

  it("rethrows a create failure other than AlreadyExists", async () => {
    const { client } = fakeClient((command) => {
      if (command instanceof CreateConfigurationSetCommand) {
        throw Object.assign(new Error("throttled"), { name: "TooManyRequestsException" });
      }
      return {};
    });
    await expect(ensureDomainConfigurationSet(client, BASE)).rejects.toThrow("throttled");
  });
});
