import { Logo } from "@/components/ui/logo";
import { StoreBadge } from "@/components/ui/store-badge";
import { footerColumns, site } from "@/lib/site";

export default function Footer() {
  return (
    <footer className="border-t rule bg-surface">
      <div className="shell py-16 md:py-20">
        <div className="grid gap-12 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div className="flex flex-col items-start gap-5">
            <Logo />
            <p className="max-w-xs text-[15px] leading-relaxed text-muted">{site.tagline}</p>
            <div className="flex flex-wrap gap-3">
              <StoreBadge store="apple" className="h-11 rounded-xl px-4" />
              <StoreBadge store="google" className="h-11 rounded-xl px-4" />
            </div>
          </div>

          {footerColumns.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <h3 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
                {col.title}
              </h3>
              <ul className="mt-5 flex flex-col gap-3">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="text-[15px] text-muted transition-colors duration-200 hover:text-ink"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-center justify-between gap-4 border-t rule pt-8 md:flex-row">
          <p className="text-sm text-faint">
            © {new Date().getFullYear()} YSNAP Inc. All rights reserved.
          </p>
          <p className="text-sm text-faint">Designed with care. Built for everyone.</p>
        </div>
      </div>
    </footer>
  );
}
