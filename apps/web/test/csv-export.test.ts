import { describe, expect, it } from "vitest";
import { type CsvColumn, toCsv } from "@/lib/csv-export";

interface Row {
  a: string;
  b: string | number | boolean | Date | null;
}

const cols: CsvColumn<Row>[] = [
  { header: "a", value: (r) => r.a },
  { header: "b", value: (r) => r.b },
];

describe("toCsv", () => {
  it("writes a header row and CRLF line terminators", () => {
    expect(toCsv([{ a: "x", b: "y" }], cols)).toBe("a,b\r\nx,y\r\n");
  });

  it("quotes fields containing a comma", () => {
    expect(toCsv([{ a: "one,two", b: "z" }], cols)).toBe('a,b\r\n"one,two",z\r\n');
  });

  it("doubles embedded quotes and wraps the field (RFC 4180)", () => {
    expect(toCsv([{ a: 'say "hi"', b: "z" }], cols)).toBe('a,b\r\n"say ""hi""",z\r\n');
  });

  it("quotes fields containing a newline", () => {
    expect(toCsv([{ a: "line1\nline2", b: "z" }], cols)).toBe('a,b\r\n"line1\nline2",z\r\n');
  });

  it("renders null as empty, Date as ISO, boolean as literal", () => {
    const date = new Date("2026-01-02T03:04:05.000Z");
    expect(toCsv([{ a: "", b: null }], cols)).toBe("a,b\r\n,\r\n");
    expect(toCsv([{ a: "t", b: true }], cols)).toBe("a,b\r\nt,true\r\n");
    expect(toCsv([{ a: "d", b: date }], cols)).toBe("a,b\r\nd,2026-01-02T03:04:05.000Z\r\n");
  });

  it("prepends a UTF-8 BOM when requested", () => {
    expect(toCsv([{ a: "x", b: "y" }], cols, { bom: true })).toBe("﻿a,b\r\nx,y\r\n");
  });

  describe("formula-injection guard", () => {
    it.each(["=1+1", "+1", "-1", "@cmd"])(
      "neutralizes a cell starting with %j by prefixing a single quote",
      (payload) => {
        const out = toCsv([{ a: payload, b: "z" }], cols);
        expect(out).toBe(`a,b\r\n'${payload},z\r\n`);
      },
    );

    it("still quotes a neutralized cell that also holds a delimiter", () => {
      expect(toCsv([{ a: "=cmd,evil", b: "z" }], cols)).toBe('a,b\r\n"\'=cmd,evil",z\r\n');
    });

    it("leaves a benign leading character untouched", () => {
      expect(toCsv([{ a: "hello", b: "z" }], cols)).toBe("a,b\r\nhello,z\r\n");
    });
  });
});
