import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  type EventType,
  PutConfigurationSetDeliveryOptionsCommand,
  UpdateConfigurationSetEventDestinationCommand,
} from "@aws-sdk/client-sesv2";
import { SETUP_NAMES } from "./setup-constants.js";

type ConfigCommand =
  | CreateConfigurationSetCommand
  | CreateConfigurationSetEventDestinationCommand
  | UpdateConfigurationSetEventDestinationCommand
  | PutConfigurationSetDeliveryOptionsCommand;

/** Structural subset of SESv2Client so tests inject a fake (mirrors SesIdentityClient). */
export interface SesConfigClient {
  send(command: ConfigCommand): Promise<unknown>;
}

export type TlsMode = "opportunistic" | "enforced";

export interface DomainConfiguration {
  domainName: string;
  region: string;
  /** SNS topic the event destination publishes to (must be in the config set's region). */
  snsTopicArn: string;
  tlsMode: TlsMode;
}

/**
 * Every event type this config set subscribes to. Deliberately excludes OPEN and
 * CLICK: engagement is tracked app-layer (we rewrite links and inject the pixel
 * ourselves), and subscribing to OPEN/CLICK is precisely what makes SES rewrite
 * links and inject its own pixel. Omitting them keeps SES out of the message
 * body entirely.
 */
const DELIVERY_EVENT_TYPES: readonly EventType[] = [
  "SEND",
  "DELIVERY",
  "DELIVERY_DELAY",
  "BOUNCE",
  "COMPLAINT",
  "REJECT",
  "RENDERING_FAILURE",
];

/**
 * Deterministic per-domain config-set name. SES allows only alphanumerics,
 * hyphens and underscores (max 64), so every other character (dots included)
 * collapses to a hyphen. Config sets are regional, so the name needs no region
 * qualifier — a domain has one region.
 */
export function domainConfigurationSetName(domainName: string): string {
  return `millionsend-${domainName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 64);
}

function errorName(error: unknown): string {
  return (error as { name?: string }).name ?? "";
}

/**
 * Idempotently provisions a dedicated configuration set for the domain, then
 * converges its settings. The configuration set itself carries no settings on
 * create — adopting an already-existing one would ignore them — so every
 * setting is applied through applyDomainConfiguration's Put/Update path.
 * Returns the configuration-set name to persist on the domain row.
 */
export async function ensureDomainConfigurationSet(
  client: SesConfigClient,
  config: DomainConfiguration,
): Promise<string> {
  const name = domainConfigurationSetName(config.domainName);
  try {
    await client.send(new CreateConfigurationSetCommand({ ConfigurationSetName: name }));
  } catch (error) {
    if (errorName(error) !== "AlreadyExistsException") throw error;
  }
  return applyDomainConfiguration(client, config);
}

/**
 * Applies the per-domain TLS policy and the delivery-event SNS subscription to an
 * existing configuration set. Idempotent: re-running with the same input is a
 * no-op change. The event destination is updated in place, falling back to
 * create when a partial earlier run left the set without one.
 */
export async function applyDomainConfiguration(
  client: SesConfigClient,
  config: DomainConfiguration,
): Promise<string> {
  const name = domainConfigurationSetName(config.domainName);

  await client.send(
    new PutConfigurationSetDeliveryOptionsCommand({
      ConfigurationSetName: name,
      TlsPolicy: config.tlsMode === "enforced" ? "REQUIRE" : "OPTIONAL",
    }),
  );

  const eventDestination = {
    Enabled: true,
    MatchingEventTypes: [...DELIVERY_EVENT_TYPES],
    SnsDestination: { TopicArn: config.snsTopicArn },
  };
  try {
    await client.send(
      new UpdateConfigurationSetEventDestinationCommand({
        ConfigurationSetName: name,
        EventDestinationName: SETUP_NAMES.eventDestination,
        EventDestination: eventDestination,
      }),
    );
  } catch (error) {
    if (errorName(error) !== "NotFoundException") throw error;
    await client.send(
      new CreateConfigurationSetEventDestinationCommand({
        ConfigurationSetName: name,
        EventDestinationName: SETUP_NAMES.eventDestination,
        EventDestination: eventDestination,
      }),
    );
  }

  return name;
}
