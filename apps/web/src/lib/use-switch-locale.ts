import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "@/components/toast";
import { type AppLocale, isAppLocale, setLocaleCookie } from "@/lib/locale-cookie";
import { useTRPC } from "@/lib/trpc";

/**
 * Switches the interface language: the cookie re-renders the tree at once,
 * and the account's stored language, which every account mail reads,
 * follows it. A save that fails is undone, since the next sign-in would
 * otherwise put the stored language back without a word.
 */
export function useSwitchLocale(): (locale: AppLocale) => void {
  const trpc = useTRPC();
  const router = useRouter();
  const current = useLocale();
  const t = useTranslations("common");
  const save = useMutation(
    trpc.settings.locale.set.mutationOptions({
      onMutate: () => ({ previous: current }),
      onError: (_error, _input, context) => {
        if (isAppLocale(context?.previous)) setLocaleCookie(context.previous);
        router.refresh();
        toast(t("accountMenu.languageSaveFailed"), "danger");
      },
    }),
  );
  return (locale) => {
    setLocaleCookie(locale);
    router.refresh();
    save.mutate({ locale });
  };
}
