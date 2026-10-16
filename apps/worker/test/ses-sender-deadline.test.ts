import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSesSender } from "../src/ses-sender.js";

// The real SDK against an endpoint that reads each request and never
// finishes an answer: silent by default, or a 200 whose body stalls.
let requests = 0;
let headersOnly = false;
const silent = createServer((req, res) => {
  requests += 1;
  req.resume();
  if (headersOnly) {
    res.writeHead(200, { "content-type": "application/json", "content-length": "64" });
    res.write("{");
  }
});

beforeAll(async () => {
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const { port } = silent.address() as AddressInfo;
  vi.stubEnv("AWS_ENDPOINT_URL_SESV2", `http://127.0.0.1:${port}`);
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "example-secret");
  // Keys only: a profile in the environment would win over them, and a
  // config file on disk could change the retries.
  vi.stubEnv("AWS_PROFILE", "");
  vi.stubEnv("AWS_CONFIG_FILE", "/nonexistent/aws-config");
  vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent/aws-credentials");
});
afterAll(() => {
  vi.unstubAllEnvs();
  silent.closeAllConnections();
  silent.close();
});

it("gives up on an unanswered send at its deadline and never sends it again", {
  timeout: 10_000,
}, async () => {
  const send = createSesSender("us-east-1", 1_500).sendRaw({
    raw: Buffer.from("Subject: hi\r\n\r\nhi"),
    emailId: "deadline-1",
    to: ["r@example.com"],
  });

  await expect(send).rejects.toMatchObject({ name: "AbortError" });
  expect(requests).toBe(1);
});

it("reads a send cut off mid-answer as one SES may hold, with no retry left", {
  timeout: 10_000,
}, async () => {
  requests = 0;
  headersOnly = true;
  vi.stubEnv("AWS_MAX_ATTEMPTS", "1");
  const send = createSesSender("us-east-1", 1_500).sendRaw({
    raw: Buffer.from("Subject: hi\r\n\r\nhi"),
    emailId: "deadline-2",
    to: ["r@example.com"],
  });

  await expect(send).rejects.toMatchObject({ name: "AbortError" });
  expect(requests).toBe(1);
});
