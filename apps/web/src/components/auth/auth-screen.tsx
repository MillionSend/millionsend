"use client";

import { useTranslations } from "next-intl";
import styles from "./auth.module.css";
import { SilkCanvas } from "./silk-canvas";

/** Same screen chrome as AuthForm, for the recovery and OAuth consent screens. */
export function AuthScreen({ title, children }: { title: string; children: React.ReactNode }) {
  const tCommon = useTranslations("common");
  return (
    <main className={styles.screen}>
      {/* biome-ignore lint/performance/noImgElement: decorative full-bleed backdrop, no optimization needed */}
      <img src="/auth/waves-dark.webp" alt="" className={`ms-dark-only ${styles.backdrop}`} />
      {/* biome-ignore lint/performance/noImgElement: decorative full-bleed backdrop, no optimization needed */}
      <img src="/auth/waves-light.webp" alt="" className={`ms-light-only ${styles.backdrop}`} />
      <SilkCanvas />
      <div className={styles.column}>
        {/* biome-ignore lint/performance/noImgElement: static SVG logo, nothing for next/image to optimize */}
        <img
          src="/logo/millionsend-wordmark.svg"
          className="ms-wordmark"
          alt={tCommon("appName")}
          height={22}
        />
        <h1 className={`ms-display ${styles.headline}`}>{title}</h1>
        {children}
      </div>
    </main>
  );
}
