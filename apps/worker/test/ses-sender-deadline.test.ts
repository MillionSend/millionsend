import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSesSender } from "../src/ses-sender.js";

// The real SDK against an endpoint that reads each request and never answers.
let requests = 0;
const silent = createServer((req) => {
  requests += 1;
  req.resume();
});

beforeAll(async () => {
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const { port } = silent.address() as AddressInfo;
  vi.stubEnv("AWS_ENDPOINT_URL_SESV2", `http://127.0.0.1:${port}`);
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "example-secret");
});
afterAll(() => {
  vi.unstubAllEnvs();
  silent.closeAllConnections();
  silent.close();
});

it("gives up on an unanswered send at its deadline and never sends it again", {
  timeout: 5_000,
}, async () => {
  const send = createSesSender("us-east-1", 200).sendRaw({
    raw: Buffer.from("Subject: hi\r\n\r\nhi"),
    emailId: "deadline-1",
    to: ["r@example.com"],
  });

  await expect(send).rejects.toMatchObject({ name: "AbortError" });
  expect(requests).toBe(1);
});
