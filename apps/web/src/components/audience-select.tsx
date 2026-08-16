"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { CreateAudienceModal } from "@/components/create-audience-modal";
import { Select, type SelectOption } from "@/components/select";
import { useTRPC } from "@/lib/trpc";

const CREATE_AUDIENCE = "__create-audience__";

/**
 * Select over the team's audiences with a trailing "+ Create audience" option
 * that opens the shared create modal inline and selects the new audience —
 * so a broadcast/segment flow never dead-ends on "no audience yet". The
 * caller supplies the audience options (labels/hints vary by surface); this
 * wrapper owns only the create affordance.
 */
export function AudienceSelect({
  id,
  value,
  onChange,
  options,
  ariaLabel,
  width,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel: string;
  width?: number | string;
  disabled?: boolean;
}) {
  const t = useTranslations("audience");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <Select
        {...(id !== undefined ? { id } : {})}
        {...(width !== undefined ? { width } : {})}
        {...(disabled !== undefined ? { disabled } : {})}
        value={value}
        ariaLabel={ariaLabel}
        options={[...options, { value: CREATE_AUDIENCE, label: `+ ${t("manage.create")}` }]}
        onChange={(next) => {
          if (next === CREATE_AUDIENCE) setCreateOpen(true);
          else onChange(next);
        }}
      />
      <CreateAudienceModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(newId) => {
          setCreateOpen(false);
          queryClient.invalidateQueries(trpc.audience.pathFilter());
          onChange(newId);
        }}
      />
    </>
  );
}
