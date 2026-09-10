import { rungByKey } from "@millionsend/core";
import { describe, expect, it } from "vitest";
import {
  pendingRungOf,
  priceMetadata,
  rungFromPrice,
  rungFromSubscription,
  subscriptionItems,
} from "../src/prices.js";
import { legacyProduct, price, schedule, subscription } from "./helpers.js";

const scaleProduct = legacyProduct("scale");

describe("rungFromPrice", () => {
  it("reads the rung from metadata before the lookup key", () => {
    expect(
      rungFromPrice(
        price("millionsend_pro_100k_monthly", { metadata: { millionsend_rung: "scale_1m" } }),
      ),
    ).toBe(rungByKey("scale_1m"));
    // Unknown metadata falls through to the key.
    expect(
      rungFromPrice(
        price("millionsend_pro_200k_monthly", { metadata: { millionsend_rung: "bogus" } }),
      ),
    ).toBe(rungByKey("pro_200k"));
  });

  it("reads the lookup key, then the product's plan", () => {
    expect(rungFromPrice(price("millionsend_starter_monthly"))).toBe(rungByKey("starter"));
    expect(rungFromPrice(price("millionsend_scale_2_5m_monthly"))).toBe(rungByKey("scale_2_5m"));
    expect(rungFromPrice(price("millionsend_scale_1m_overage"))).toBe(rungByKey("scale_1m"));
    expect(rungFromPrice(price(null, { product: scaleProduct }))).toBe(rungByKey("scale_500k"));
    expect(rungFromPrice(price("someone_elses_price", { product: scaleProduct }))).toBe(
      rungByKey("scale_500k"),
    );
  });

  it("product metadata lands a pre-ladder price on the plan's first rung", () => {
    expect(rungFromPrice(price("millionsend_pro_monthly", { product: legacyProduct("pro") }))).toBe(
      rungByKey("pro_100k"),
    );
    expect(rungFromPrice(price("millionsend_scale_monthly", { product: scaleProduct }))).toBe(
      rungByKey("scale_500k"),
    );
    // The key alone links to nothing.
    expect(rungFromPrice(price("millionsend_pro_monthly"))).toBeNull();
  });

  it("is null for a price nothing links to the ladder", () => {
    expect(rungFromPrice(price(null))).toBeNull();
    expect(rungFromPrice(price("someone_elses_price"))).toBeNull();
    expect(rungFromPrice(price(null, { product: legacyProduct("free") }))).toBeNull();
  });
});

describe("subscriptionItems", () => {
  it("splits the plan item from the metered one", () => {
    const both = subscription("sub_1", "cus_1", "active", "millionsend_pro_100k_monthly", {
      overageKey: "millionsend_pro_100k_overage",
    });
    expect(subscriptionItems(both)).toEqual({
      base: both.items.data[0],
      overage: both.items.data[1],
    });
    expect(rungFromSubscription(both)).toBe(rungByKey("pro_100k"));

    const planOnly = subscription("sub_2", "cus_1", "active");
    expect(subscriptionItems(planOnly)).toEqual({ base: planOnly.items.data[0], overage: null });

    const empty = { ...planOnly, items: { ...planOnly.items, data: [] } };
    expect(subscriptionItems(empty)).toEqual({ base: null, overage: null });
    expect(rungFromSubscription(empty)).toBeNull();
  });
});

describe("pendingRungOf", () => {
  const current = rungByKey("pro_200k");
  const withSchedule = (items: unknown[]) =>
    subscription("sub_1", "cus_1", "active", "millionsend_pro_200k_monthly", {
      overageKey: "millionsend_pro_200k_overage",
      schedule: schedule(items),
    });

  it("is null without a schedule, or when the last phase keeps the current rung", () => {
    expect(pendingRungOf(subscription("sub_1", "cus_1", "active"), current)).toBeNull();
    const unexpanded = { ...withSchedule([]), schedule: "sched_0" };
    expect(pendingRungOf(unexpanded, current)).toBeNull();
    expect(
      pendingRungOf(
        withSchedule([
          price("millionsend_pro_200k_monthly"),
          price("millionsend_pro_200k_overage", { metered: true }),
        ]),
        current,
      ),
    ).toBeNull();
    expect(pendingRungOf(withSchedule([]), current)).toBeNull();
  });

  it("names the cheaper rung the last phase moves to", () => {
    expect(
      pendingRungOf(
        withSchedule([
          price("millionsend_pro_100k_monthly"),
          price("millionsend_pro_100k_overage", { metered: true }),
        ]),
        current,
      ),
    ).toBe("pro_100k");
    expect(pendingRungOf(withSchedule([price("millionsend_starter_monthly")]), current)).toBe(
      "starter",
    );
  });

  it("skips metered items and deleted prices to find the plan price", () => {
    const deleted = { id: "price_gone", object: "price", deleted: true };
    expect(
      pendingRungOf(
        withSchedule([
          price("millionsend_pro_100k_overage", { metered: true }),
          deleted,
          price("millionsend_pro_100k_monthly"),
        ]),
        current,
      ),
    ).toBe("pro_100k");
    expect(
      pendingRungOf(
        withSchedule([price("millionsend_pro_100k_overage", { metered: true }), deleted]),
        current,
      ),
    ).toBeNull();
  });
});

describe("priceMetadata", () => {
  it("carries the rung key, plan, volume, period and overage rate", () => {
    expect(priceMetadata(rungByKey("pro_100k"))).toEqual({
      millionsend_rung: "pro_100k",
      plan: "pro",
      included_emails: "100000",
      period: "month",
      overage_cents_per_1k: "30",
    });
    expect(priceMetadata(rungByKey("starter"))).toEqual({
      millionsend_rung: "starter",
      plan: "starter",
      included_emails: "1500",
      period: "day",
    });
  });
});
