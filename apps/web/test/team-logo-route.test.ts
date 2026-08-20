import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRole } from "@/server/membership";

interface S3Call {
  Bucket?: string;
  Key?: string;
  ContentType?: string;
}

const h = vi.hoisted(() => ({
  db: undefined as unknown as Db,
  session: null as { user: { id: string; email: string; name: string } } | null,
  puts: [] as S3Call[],
  deletes: [] as S3Call[],
}));

// getDb() inside the route handler must hit the per-test PGlite db.
vi.mock("@millionsend/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@millionsend/db")>();
  return { ...actual, getDb: () => h.db };
});

vi.mock("@/server/auth", () => ({
  getAuth: () => ({ api: { getSession: async () => h.session } }),
}));

// The storage module stays real (config resolution, key/url derivation);
// only the wire calls to the bucket are captured.
vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    constructor(public input: S3Call) {}
  }
  class DeleteObjectCommand {
    constructor(public input: S3Call) {}
  }
  class S3Client {
    async send(command: PutObjectCommand | DeleteObjectCommand): Promise<void> {
      (command instanceof PutObjectCommand ? h.puts : h.deletes).push(command.input);
    }
  }
  return { S3Client, PutObjectCommand, DeleteObjectCommand };
});

const { POST, DELETE: removeLogo } = await import("@/app/api/team-logo/route");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

function enableStorage(): void {
  vi.stubEnv("S3_ENDPOINT", "https://acc.r2.cloudflarestorage.com");
  vi.stubEnv("S3_ACCESS_KEY_ID", "key");
  vi.stubEnv("S3_SECRET_ACCESS_KEY", "secret");
  vi.stubEnv("S3_STORAGE_BUCKET", "ms-uploads");
  vi.stubEnv("S3_STORAGE_PUBLIC_URL", "https://cdn.example.com");
}

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  h.db = db;
  h.session = null;
  h.puts = [];
  h.deletes = [];
  enableStorage();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

async function seedTeam(role: TeamRole | null = "owner"): Promise<string> {
  const teamId = await createTeam(db);
  await db.insert(schema.user).values({ id: "u1", name: "u1", email: "u1@example.com" });
  if (role) await db.insert(schema.teamMembers).values({ teamId, userId: "u1", role });
  h.session = { user: { id: "u1", email: "u1@example.com", name: "u1" } };
  return teamId;
}

function uploadRequest(teamId: string, bytes: Uint8Array<ArrayBuffer>): Request {
  const form = new FormData();
  form.set("teamId", teamId);
  form.set("file", new File([bytes], "logo.png", { type: "image/png" }));
  return new Request("http://localhost/api/team-logo", { method: "POST", body: form });
}

function deleteRequest(teamId: string): Request {
  return new Request(`http://localhost/api/team-logo?teamId=${teamId}`, { method: "DELETE" });
}

async function storedLogoUrl(teamId: string): Promise<string | null> {
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  return team?.logoUrl ?? null;
}

describe("POST /api/team-logo", () => {
  it("404s when storage is not configured, regardless of auth", async () => {
    const teamId = await seedTeam("owner");
    vi.unstubAllEnvs();
    const res = await POST(uploadRequest(teamId, PNG));
    expect(res.status).toBe(404);
  });

  it("401s without a session", async () => {
    const teamId = await seedTeam("owner");
    h.session = null;
    const res = await POST(uploadRequest(teamId, PNG));
    expect(res.status).toBe(401);
  });

  it("403s for a non-member and for role member", async () => {
    const nonMemberTeam = await seedTeam(null);
    expect((await POST(uploadRequest(nonMemberTeam, PNG))).status).toBe(403);

    await db.insert(schema.teamMembers).values({
      teamId: nonMemberTeam,
      userId: "u1",
      role: "member",
    });
    expect((await POST(uploadRequest(nonMemberTeam, PNG))).status).toBe(403);
    expect(h.puts).toEqual([]);
  });

  it("rejects content that is not png/jpeg/webp by magic bytes (svg included)", async () => {
    const teamId = await seedTeam("owner");
    const svg = new TextEncoder().encode("<svg onload=alert(1)></svg>");
    const res = await POST(uploadRequest(teamId, svg));
    expect(res.status).toBe(415);
    expect(h.puts).toEqual([]);
    expect(await storedLogoUrl(teamId)).toBeNull();
  });

  it("rejects files over 2 MB", async () => {
    const teamId = await seedTeam("owner");
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(PNG);
    const res = await POST(uploadRequest(teamId, big));
    expect(res.status).toBe(413);
    expect(h.puts).toEqual([]);
  });

  it("uploads for an admin, stores the cache-busted public URL, and sets ContentType", async () => {
    const teamId = await seedTeam("admin");
    const res = await POST(uploadRequest(teamId, PNG));
    expect(res.status).toBe(200);

    const { logoUrl } = (await res.json()) as { logoUrl: string };
    expect(logoUrl).toMatch(
      new RegExp(`^https://cdn\\.example\\.com/team-logos/${teamId}\\.png\\?v=\\d+$`),
    );
    expect(await storedLogoUrl(teamId)).toBe(logoUrl);
    expect(h.puts).toEqual([
      expect.objectContaining({
        Bucket: "ms-uploads",
        Key: `team-logos/${teamId}.png`,
        ContentType: "image/png",
      }),
    ]);
    expect(h.deletes).toEqual([]);
  });

  it("re-upload in another format overwrites the URL and deletes the old object", async () => {
    const teamId = await seedTeam("owner");
    await POST(uploadRequest(teamId, PNG));
    const res = await POST(uploadRequest(teamId, WEBP));
    expect(res.status).toBe(200);
    expect(await storedLogoUrl(teamId)).toContain(`/team-logos/${teamId}.webp?v=`);
    expect(h.deletes).toEqual([
      expect.objectContaining({ Bucket: "ms-uploads", Key: `team-logos/${teamId}.png` }),
    ]);
  });
});

describe("DELETE /api/team-logo", () => {
  it("clears the column and best-effort deletes the object", async () => {
    const teamId = await seedTeam("owner");
    await POST(uploadRequest(teamId, PNG));

    const res = await removeLogo(deleteRequest(teamId));
    expect(res.status).toBe(200);
    expect(await storedLogoUrl(teamId)).toBeNull();
    expect(h.deletes).toEqual([
      expect.objectContaining({ Bucket: "ms-uploads", Key: `team-logos/${teamId}.png` }),
    ]);
  });

  it("403s for role member", async () => {
    const teamId = await seedTeam("member");
    const res = await removeLogo(deleteRequest(teamId));
    expect(res.status).toBe(403);
  });
});
