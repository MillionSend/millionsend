import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JsonView } from "@/components/json-view";
import { resourceHref } from "@/lib/log-body-links";

const ID = "3f2b9c1e-6d4a-4b8e-9f1c-2a7d5e8b0c34";
const TOPIC = "9b1e7a52-0c3d-4f6e-8a21-5d4c3b2a1f00";

describe("resourceHref", () => {
  it("attributes a bare id to the request's root collection", () => {
    expect(resourceHref("/contacts", ["id"], ID)).toBe(`/audience/contacts/${ID}`);
    expect(resourceHref("/contacts/batch", ["data", "id"], ID)).toBe(`/audience/contacts/${ID}`);
    expect(resourceHref("/emails", ["id"], ID)).toBe(`/emails/${ID}`);
    expect(resourceHref("/emails/batch", ["data", "id"], ID)).toBe(`/emails/${ID}`);
    expect(resourceHref("/broadcasts", ["id"], ID)).toBe(`/broadcasts/${ID}`);
    expect(resourceHref("/segments", ["id"], ID)).toBe(`/audience/segments/${ID}`);
    expect(resourceHref("/audiences", ["id"], ID)).toBe(`/audience/segments/${ID}`);
    expect(resourceHref("/topics", ["data", "id"], ID)).toBe(`/audience/topics/${ID}`);
    expect(resourceHref("/webhooks", ["id"], ID)).toBe(`/webhooks/${ID}`);
    expect(resourceHref("/domains", ["id"], ID)).toBe(`/domains/${ID}`);
    expect(resourceHref("/templates", ["id"], ID)).toBe(`/templates/${ID}`);
    expect(resourceHref("/suppressions", ["id"], ID)).toBe(`/emails/suppressions/${ID}`);
  });

  it("contacts listed under an audience or segment are contacts", () => {
    expect(resourceHref(`/audiences/${TOPIC}/contacts`, ["data", "id"], ID)).toBe(
      `/audience/contacts/${ID}`,
    );
    expect(resourceHref(`/segments/${TOPIC}/contacts`, ["data", "id"], ID)).toBe(
      `/audience/contacts/${ID}`,
    );
  });

  it("api keys and unknown roots never link", () => {
    expect(resourceHref("/api-keys", ["id"], ID)).toBeNull();
    expect(resourceHref("/api-keys", ["data", "id"], ID)).toBeNull();
    expect(resourceHref("/nothing", ["id"], ID)).toBeNull();
    expect(resourceHref("/", ["id"], ID)).toBeNull();
  });

  it("an id belongs to the nearest enclosing topics/segments array", () => {
    expect(resourceHref("/contacts", ["topics", "id"], ID)).toBe(`/audience/topics/${ID}`);
    expect(resourceHref("/contacts", ["data", "segments", "id"], ID)).toBe(
      `/audience/segments/${ID}`,
    );
    expect(resourceHref("/contacts", ["topics"], ID)).toBe(`/audience/topics/${ID}`);
    expect(resourceHref("/emails", ["attachments", "id"], ID)).toBeNull();
  });

  it("explicit keys win over the context", () => {
    expect(resourceHref("/emails", ["contact"], ID)).toBe(`/audience/contacts/${ID}`);
    expect(resourceHref("/broadcasts", ["contact_id"], ID)).toBe(`/audience/contacts/${ID}`);
    expect(resourceHref("/contacts", ["topics", "email_id"], ID)).toBe(`/emails/${ID}`);
    expect(resourceHref("/emails", ["broadcast_id"], ID)).toBe(`/broadcasts/${ID}`);
    expect(resourceHref("/contacts", ["segment_id"], ID)).toBe(`/audience/segments/${ID}`);
    expect(resourceHref("/contacts", ["audience_id"], ID)).toBe(`/audience/segments/${ID}`);
    expect(resourceHref("/emails", ["topic_id"], ID)).toBe(`/audience/topics/${ID}`);
    expect(resourceHref("/emails", ["domain_id"], ID)).toBe(`/domains/${ID}`);
    expect(resourceHref("/emails", ["template_id"], ID)).toBe(`/templates/${ID}`);
    expect(resourceHref("/api-keys", ["webhook_id"], ID)).toBe(`/webhooks/${ID}`);
  });

  it("an ids array in a request body resolves to the root", () => {
    expect(resourceHref("/contacts/batch/get", ["ids"], ID)).toBe(`/audience/contacts/${ID}`);
  });

  it("links only UUID-shaped values under attributable keys", () => {
    expect(resourceHref("/contacts", ["id"], "ct_123")).toBeNull();
    expect(resourceHref("/contacts", ["id"], `${ID}0`)).toBeNull();
    expect(resourceHref("/contacts", ["first_name"], ID)).toBeNull();
    expect(resourceHref("/contacts", [], ID)).toBeNull();
  });
});

describe("JsonView", () => {
  it("links attributable ids, dims markers and colors the other tokens", () => {
    const html = renderToStaticMarkup(
      createElement(JsonView, {
        requestPath: "/contacts",
        value: {
          data: [{ id: ID, email: "[redacted]", topics: [{ id: TOPIC, subscribed: true }] }],
          count: 1,
          next: null,
        },
      }),
    );
    expect(html).toContain(`href="/audience/contacts/${ID}"`);
    expect(html).toContain(`href="/audience/topics/${TOPIC}"`);
    expect(html).toContain('class="ms-json-link"');
    expect(html).toContain('class="hljs-string ms-json-marker">&quot;[redacted]&quot;</span>');
    expect(html).toContain(
      '<span class="hljs-attr">&quot;count&quot;</span>: <span class="hljs-number">1</span>',
    );
    expect(html).toContain('<span class="hljs-literal">true</span>');
    expect(html).toContain('<span class="hljs-literal">null</span>');
    expect(html).toContain("\n    {\n");
  });

  it("renders api-key ids as plain strings", () => {
    const html = renderToStaticMarkup(
      createElement(JsonView, { requestPath: "/api-keys", value: { id: ID } }),
    );
    expect(html).not.toContain("href=");
    expect(html).toContain(`<span class="hljs-string">&quot;${ID}&quot;</span>`);
  });
});

describe("resourceHref sub-collections", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  it("attributes data[].id under /contacts/{id}/topics to topics", () => {
    expect(resourceHref(`/contacts/${id}/topics`, ["data", "0", "id"], id)).toBe(
      `/audience/topics/${id}`,
    );
  });
});
