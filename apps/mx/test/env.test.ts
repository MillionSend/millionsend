import { expect, it } from "vitest";
import { parseMxEnv } from "../src/env.js";

const SECRET = "s".repeat(32);
const MINIMAL = {
  MX_INGEST_URL: "https://api.example.com/internal/mx/",
  MX_INGEST_SECRET: SECRET,
  MX_HOSTNAME: "MX.Example.com",
};

it("boots with only its MX_* variables, filling the limits with defaults", () => {
  expect(parseMxEnv(MINIMAL)).toEqual({
    ingestUrl: "https://api.example.com/internal/mx",
    ingestSecret: SECRET,
    hostname: "mx.example.com",
    port: 2525,
    tls: null,
    maxClients: 200,
    maxConnectionsPerIp: 10,
    connectionsPerIpPerMinute: 60,
    maxRecipients: 50,
    socketTimeoutMs: 60_000,
    sessionTimeoutMs: 600_000,
  });
});

it("takes a STARTTLS keypair and explicit limits", () => {
  const env = parseMxEnv({
    ...MINIMAL,
    MX_PORT: "25",
    MX_TLS_CERT_PATH: "/tls/fullchain.pem",
    MX_TLS_KEY_PATH: "/tls/privkey.pem",
    MX_MAX_RECIPIENTS: "20",
  });
  expect(env.port).toBe(25);
  expect(env.tls).toEqual({ certPath: "/tls/fullchain.pem", keyPath: "/tls/privkey.pem" });
  expect(env.maxRecipients).toBe(20);
});

it("rejects partial or unsafe configuration, naming every problem", () => {
  expect(() => parseMxEnv({})).toThrow(
    /MX_INGEST_URL must be an http\(s\) URL; MX_INGEST_SECRET must be at least 32 characters; MX_HOSTNAME/,
  );
  expect(() => parseMxEnv({ ...MINIMAL, MX_INGEST_SECRET: "short" })).toThrow("MX_INGEST_SECRET");
  expect(() => parseMxEnv({ ...MINIMAL, MX_TLS_CERT_PATH: "/tls/cert.pem" })).toThrow(
    "MX_TLS_CERT_PATH and MX_TLS_KEY_PATH must be set together",
  );
  expect(() => parseMxEnv({ ...MINIMAL, MX_INGEST_URL: "ftp://api.example.com" })).toThrow(
    "MX_INGEST_URL",
  );
  expect(() =>
    parseMxEnv({ ...MINIMAL, MX_INGEST_URL: "https://user:pw@api.example.com/internal/mx" }),
  ).toThrow("credentials");
  expect(() => parseMxEnv({ ...MINIMAL, MX_MAX_RECIPIENTS: "500" })).toThrow("MX_MAX_RECIPIENTS");
  expect(() => parseMxEnv({ ...MINIMAL, MX_PORT: "http" })).toThrow("MX_PORT");
});
