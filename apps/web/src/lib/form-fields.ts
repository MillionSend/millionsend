/**
 * A POST body's form fields, whichever encoding the client sent. RFC 8058
 * one-click receivers SHOULD post multipart/form-data and MAY post
 * urlencoded. A body that doesn't parse as multipart, whatever its content
 * type says, is read as urlencoded text, so a body sent without a content
 * type, or labeled multipart by mistake, still parses. File parts are dropped.
 */
export async function readFormFields(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get("content-type") ?? "";
  const body = await request.text().catch(() => "");
  if (type.toLowerCase().startsWith("multipart/form-data")) {
    const data = await new Response(body, { headers: { "content-type": type } })
      .formData()
      .catch(() => null);
    if (data) {
      const fields = new URLSearchParams();
      for (const [name, value] of data) {
        if (typeof value === "string") fields.append(name, value);
      }
      return fields;
    }
  }
  return new URLSearchParams(body);
}
