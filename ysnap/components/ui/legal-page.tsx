import type { ReactNode } from "react";
import Link from "next/link";

type LegalPageProps = {
  title: string;
  lastUpdated: string;
  intro?: ReactNode;
  children: ReactNode;
};

/** Shared prose shell for /terms and /privacy-policy — plain content pages,
    not marketing sections, so no scroll animation or Section wrapper. */
export function LegalPage({ title, lastUpdated, intro, children }: LegalPageProps) {
  return (
    <div className="shell py-20 md:py-28">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/"
          className="text-sm font-medium text-accent-deep transition-colors hover:text-accent"
        >
          ← Back to YSNAP
        </Link>
        <h1 className="mt-6 text-3xl font-medium text-ink md:text-4xl">{title}</h1>
        <p className="mt-2 text-sm text-faint">Last updated: {lastUpdated}</p>
        {intro ? <div className="mt-6 text-[15px] leading-relaxed text-muted">{intro}</div> : null}
        <div className="prose-legal mt-10 space-y-10">{children}</div>
      </div>
    </div>
  );
}

export function LegalSection({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="text-lg font-medium text-ink">
        {n}. {title}
      </h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

/** Amber callout for fields that need a lawyer or business decision before
    launch, rather than silently shipping a fabricated value. */
export function LegalTodo({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-amber/10 px-1.5 py-0.5 font-medium text-amber">
      {children}
    </span>
  );
}
