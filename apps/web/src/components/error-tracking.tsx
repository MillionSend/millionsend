"use client";

import type { ErrorTrackingConfig } from "@millionsend/config";
import { useEffect } from "react";
import { startClientErrorTracking } from "@/lib/client-errors";

// Placed before the page tree in the root layout: React runs an earlier
// sibling's effects first, so the SDK is on its way before an error
// boundary's own effect reports to it.
export function ErrorTracking({ config }: { config: ErrorTrackingConfig }) {
  useEffect(() => startClientErrorTracking(config), [config]);
  return null;
}
