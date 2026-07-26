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
    question: "What can the AI camera actually recognize?",
    answer:
      "Point it at coins, plants, food, math problems, essays and documents, medical symptoms, landmarks, animals, rocks, barcodes, receipts, or stamps — 16 modes in total, each returning a structured analysis report in seconds.",
    link: { label: "See it in the live demo", href: "#demo" },
  },
  {
    question: "How fast and accurate is it?",
    answer:
      "Translation and camera analysis average under 200 ms, and results keep improving as the underlying models do. Like any AI system it can occasionally get something wrong, so for anything where a mistake matters, verify independently.",
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
      "Voice cloning only works from a recording of your own voice, captured with your explicit consent at the moment you create a clone. You confirm ownership before a clone is made, your voice sample stays private to your account, and you can delete any clone at any time. YSNAP never creates a voice from someone else's audio without their consent, and cloned voices are never shared or used to train shared models.",
  },
  {
    question: "Which platforms does YSNAP run on?",
    answer:
      "YSNAP supports iOS 16 or later and Android 10 or later, with feature parity across both. It is a free download on the App Store and Google Play.",
  },
  {
    question: "Is there a web version of YSNAP?",
    answer:
      "Not yet — YSNAP is built as a native app so the camera and on-device processing can run at full speed. This site is where you download it and try the live demo before you do.",
    link: { label: "Try the live demo", href: "#demo" },
  },
  {
    question: "What are the limits of the free plan?",
    answer:
      "The free Starter plan gives you 10 translations and 5 camera scans a day, standard voices, and 40 languages — enough to use YSNAP every day at no cost. You also get one free voice clone, so you can hear your own voice speak another language before you decide to upgrade. Pro unlocks unlimited translation, all 16 camera modes, up to 3 voice clones, 120+ languages, offline packs, and priority processing.",
  },
  {
    question: "How do I switch billing periods or cancel my subscription?",
    answer:
      "Manage everything from your device's App Store or Google Play subscription settings — switch between monthly and annual, or cancel, at any time. Changes take effect at the end of your current billing period, and there's no form to fill out or call to make.",
  },
  {
    question: "Can I get a refund?",
    answer:
      "Refunds are handled by Apple or Google under their own policies, since they process the payment — request one through your App Store or Google Play purchase history rather than through YSNAP directly.",
  },
  {
    question: "Can Teams plans be customized for larger organizations?",
    answer:
      "Yes. Seat count, custom glossaries, SSO, and onboarding are configured directly with our sales team for organizations that need more than the standard per-seat plan.",
    link: { label: "Contact sales", href: "#pricing" },
  },
  {
    question: "What happens to my data if I cancel or delete my account?",
    answer:
      "Deleting your account removes your translation history, voice clones, and personal data from our active systems within the retention window in our Privacy Policy. You can delete individual voice clones at any time without closing your account.",
    link: { label: "Read the Privacy Policy", href: "/privacy-policy" },
  },
  {
    question: "How do I contact support?",
    answer:
      "Email support@ysnapai.com, or ask the YSNAP Assistant in the corner of this page — it's built to answer questions about the app directly, day or night.",
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

  /* One accordion row. `i` is the item's global index so the shared
     open-state works identically across both columns. */
  const renderItem = (item: FaqItem, i: number) => {
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
            className="group flex w-full cursor-pointer items-center justify-between gap-4 py-5 text-left"
          >
            <span className="text-base font-medium text-ink transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0">
              {item.question}
            </span>
            <motion.span
              aria-hidden
              animate={{ rotate: open ? 45 : 0 }}
              transition={
                reduce ? { duration: 0 } : { duration: 0.3, ease: EASE }
              }
              className={cn(
                "grid h-7 w-7 shrink-0 place-items-center rounded-full border border-hairline bg-surface text-muted shadow-soft transition-[color,border-color] duration-300 group-hover:border-[#dcdcdc] group-hover:text-ink",
                open && "border-[#dcdcdc] text-ink",
              )}
            >
              <PlusIcon className="h-3.5 w-3.5 transition-transform duration-150 group-active:scale-75 motion-reduce:group-active:scale-100" />
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
              <p className="pb-5 text-[0.95rem] leading-relaxed text-muted">
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
  };

  /* Split into two independent columns so an open panel on one side never
     stretches an empty gap on the other (the masonry problem a single CSS
     grid would create). Left column takes even indices, right takes odd, so
     the original order still reads top-to-bottom down each column. */
  const columns: FaqItem[][] = [[], []];
  FAQ_ITEMS.forEach((item, i) => columns[i % 2].push(item));

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

        <Reveal className="mx-auto grid max-w-5xl grid-cols-1 items-start gap-x-12 md:grid-cols-2">
          {columns.map((col, c) => (
            <div key={c} className="divide-y divide-hairline">
              {col.map((item) => renderItem(item, FAQ_ITEMS.indexOf(item)))}
            </div>
          ))}
        </Reveal>
      </div>
    </Section>
  );
}
