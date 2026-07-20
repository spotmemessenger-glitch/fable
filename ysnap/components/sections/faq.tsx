"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";
import { EASE } from "@/lib/motion";
import { Section, SectionHeading } from "@/components/ui/section";
import { Reveal } from "@/components/ui/reveal";

type FaqItem = {
  question: string;
  answer: string;
  link?: { label: string; href: string };
};

const FAQ_ITEMS: FaqItem[] = [
  {
    question: "Does YSNAP work offline?",
    answer:
      "Yes. Download offline packs for the languages you use most and translation keeps working with no connection at all.",
  },
  {
    question: "Which languages are supported?",
    answer:
      "YSNAP speaks 120+ languages across translation, transliteration, and voice, with more added every quarter.",
    link: { label: "Browse the full list", href: "#translation" },
  },
  {
    question: "Is my data private?",
    answer:
      "Your conversations are encrypted in transit, processed on-device wherever possible, and never sold or used for ads. You can erase your history at any time from settings.",
  },
  {
    question: "Can I rely on it for medical or legal accuracy?",
    answer:
      "YSNAP is built for everyday understanding and its output is informational only. For medical, legal, or safety-critical decisions, always consult a qualified professional.",
  },
  {
    question: "How does voice cloning consent work?",
    answer:
      "You can only clone your own voice, verified through an explicit consent flow with a live recording check. Your voiceprint stays yours and can be permanently deleted whenever you choose.",
  },
  {
    question: "Which platforms does YSNAP run on?",
    answer:
      "YSNAP supports iOS 16 or later and Android 10 or later, with feature parity across both. It is a free download on the App Store and Google Play.",
  },
  {
    question: "What are the limits of the free plan?",
    answer:
      "Starter includes 25 translations and 10 camera scans per day, standard voices, and 40 languages, refreshed daily. Upgrade to Pro whenever you want unlimited.",
  },
];

/** FAQPage structured data built from the same array the accordion renders. */
const FAQ_SCHEMA = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map((item) => ({
    "@type": "Question",
    name: item.question,
    acceptedAnswer: { "@type": "Answer", text: item.answer },
  })),
});

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export default function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const reduce = useReducedMotion();

  return (
    <Section id="faq" tone="canvas">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: FAQ_SCHEMA }}
      />
      <div className="shell">
        <SectionHeading
          eyebrow="FAQ"
          title="Answers, before you ask."
          description="The questions travelers, students, and teams ask most, answered plainly."
        />

        <Reveal className="mx-auto max-w-3xl divide-y divide-hairline">
          {FAQ_ITEMS.map((item, i) => {
            const open = openIndex === i;
            return (
              <div key={item.question}>
                <h3>
                  <button
                    type="button"
                    id={`faq-trigger-${i}`}
                    aria-expanded={open}
                    aria-controls={`faq-panel-${i}`}
                    onClick={() => setOpenIndex(open ? null : i)}
                    className="group flex w-full cursor-pointer items-center justify-between gap-6 py-6 text-left"
                  >
                    <span className="text-lg font-medium text-ink transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0">
                      {item.question}
                    </span>
                    <motion.span
                      aria-hidden
                      animate={{ rotate: open ? 45 : 0 }}
                      transition={
                        reduce ? { duration: 0 } : { duration: 0.3, ease: EASE }
                      }
                      className={cn(
                        "grid h-8 w-8 shrink-0 place-items-center rounded-full border border-hairline bg-surface text-muted shadow-soft transition-[color,border-color] duration-300 group-hover:border-[#dcdcdc] group-hover:text-ink",
                        open && "border-[#dcdcdc] text-ink",
                      )}
                    >
                      <PlusIcon className="h-4 w-4 transition-transform duration-150 group-active:scale-75 motion-reduce:group-active:scale-100" />
                    </motion.span>
                  </button>
                </h3>
                <AnimatePresence initial={false}>
                  {open ? (
                    <motion.div
                      key="panel"
                      id={`faq-panel-${i}`}
                      role="region"
                      aria-labelledby={`faq-trigger-${i}`}
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={
                        reduce ? { duration: 0 } : { duration: 0.45, ease: EASE }
                      }
                      className="overflow-hidden"
                    >
                      <p className="max-w-[60ch] pb-6 text-muted">
                        {item.answer}
                        {item.link ? (
                          <>
                            {" "}
                            <a
                              href={item.link.href}
                              className="cursor-pointer text-accent-deep underline decoration-accent/30 underline-offset-4 transition-colors duration-200 hover:decoration-accent"
                            >
                              {item.link.label}
                            </a>
                            .
                          </>
                        ) : null}
                      </p>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
            );
          })}
        </Reveal>
      </div>
    </Section>
  );
}
