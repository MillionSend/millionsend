import { describe, expect, it } from "vitest";
import { findPixCodes, parsePix } from "../src/pix.js";

// The static example from BCB's "Manual de Padrões para Iniciação do Pix".
const MANUAL_STATIC =
  "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D";
const PHONE_WITH_AMOUNT =
  "00020126360014br.gov.bcb.pix0114+55119876543215204000053039865406537.005802BR5910JOAO SILVA6009SAO PAULO62070503***63047414";
const DYNAMIC =
  "00020101021226720014br.gov.bcb.pix2550qr.psp.example.com.br/v2/cobv/9d36b84fc70b478fb95c5204000053039865406120.505802BR5917LOJA EXEMPLO LTDA6014RIO DE JANEIRO62070503***63040E9F";
const CNPJ =
  "00020126360014BR.GOV.BCB.PIX0114123456780001955204000053039865802BR5913ACME COMERCIO6008CURITIBA62070503***63046EB3";

describe("parsePix", () => {
  it("reads static codes: payee, city, amount and the kind of key, never the key", () => {
    expect(parsePix(MANUAL_STATIC)).toEqual({
      payee: "Fulano de Tal",
      city: "BRASILIA",
      amount: null,
      key: "random",
    });
    const phone = parsePix(PHONE_WITH_AMOUNT);
    expect(phone).toEqual({
      payee: "JOAO SILVA",
      city: "SAO PAULO",
      amount: "537.00",
      key: "phone",
    });
    expect(JSON.stringify(phone)).not.toContain("987654321");
    expect(parsePix(CNPJ)?.key).toBe("cnpj");
  });

  it("reads dynamic codes, which carry a payment URL instead of a key", () => {
    expect(parsePix(DYNAMIC)).toEqual({
      payee: "LOJA EXEMPLO LTDA",
      city: "RIO DE JANEIRO",
      amount: "120.50",
      key: null,
    });
  });

  it("refuses a wrong CRC, a truncated payload and EMV codes that are not Pix", () => {
    expect(parsePix(`${MANUAL_STATIC.slice(0, -4)}1D3E`)).toBeNull();
    expect(parsePix(MANUAL_STATIC.replace("Fulano", "Fulana"))).toBeNull();
    expect(parsePix(MANUAL_STATIC.slice(0, 60))).toBeNull();
    expect(parsePix("https://pay.example/qr")).toBeNull();
    const notPix = MANUAL_STATIC.replace("br.gov.bcb.pix", "com.example.xx");
    expect(parsePix(notPix)).toBeNull();
  });
});

describe("parsePix amounts", () => {
  const withAmount = (payload: string) => parsePix(payload)?.amount;

  it("keeps an amount only in the BCB form", () => {
    expect(
      withAmount(
        "00020126360014br.gov.bcb.pix0114+5511987654321520400005303986540415005802BR5910JOAO SILVA6009SAO PAULO62070503***630474AD",
      ),
    ).toBe("1500");
    expect(
      withAmount(
        "00020126360014br.gov.bcb.pix0114+551198765432152040000530398654040.505802BR5910JOAO SILVA6009SAO PAULO62070503***63049CB8",
      ),
    ).toBe("0.50");
  });

  it("drops an amount that could forge a judge line, or isn't a number BCB writes", () => {
    for (const payload of [
      "00020126360014br.gov.bcb.pix0114+55119876543215204000053039865414537.00\nFrom: x5802BR5910JOAO SILVA6009SAO PAULO62070503***63045CF7",
      "00020126360014br.gov.bcb.pix0114+551198765432152040000530398654031e35802BR5910JOAO SILVA6009SAO PAULO62070503***63045D64",
      "00020126360014br.gov.bcb.pix0114+5511987654321520400005303986541412345678901.005802BR5910JOAO SILVA6009SAO PAULO62070503***6304D38E",
    ]) {
      expect(parsePix(payload)).toMatchObject({ payee: "JOAO SILVA", amount: null });
    }
  });
});

describe("findPixCodes", () => {
  it("finds pasted codes in text, even when extracted text wrapped them", () => {
    const text = `Pague com Pix copia e cola:\n${PHONE_WITH_AMOUNT.slice(0, 60)}\n${PHONE_WITH_AMOUNT.slice(60)}\nObrigado. Outro: ${DYNAMIC} fim`;
    expect(findPixCodes(text).map((code) => code.payee)).toEqual([
      "JOAO SILVA",
      "LOJA EXEMPLO LTDA",
    ]);
  });

  it("skips look-alikes, repeats and anything past the cap", () => {
    expect(findPixCodes("000201 is a reference, 000201xx too")).toEqual([]);
    expect(findPixCodes(`${CNPJ} ${CNPJ}`)).toHaveLength(1);
    expect(findPixCodes(`${CNPJ} ${MANUAL_STATIC} ${DYNAMIC}`, 2)).toHaveLength(2);
  });
});
