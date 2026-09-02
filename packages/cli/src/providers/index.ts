import type { Http } from "../http.js";
import type { Logger } from "../log.js";
import type { ProviderId } from "../model.js";
import { createResendSource, resendBaseUrl, type Source } from "./resend.js";

export interface Provider {
  id: ProviderId;
  /** Display name, spelled as the brand writes it. */
  label: string;
  baseUrl(env?: NodeJS.ProcessEnv): string;
  create(http: Http, log: Logger): Source;
}

export const providers: Record<ProviderId, Provider> = {
  resend: { id: "resend", label: "Resend", baseUrl: resendBaseUrl, create: createResendSource },
};

export type {
  EnrichOptions,
  OnProgress,
  ReadShallowOptions,
  Source,
  SourceProgress,
} from "./resend.js";
export { estimateSourceRequests } from "./resend.js";
