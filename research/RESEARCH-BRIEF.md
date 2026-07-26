# Research Brief — paste this to start any product investigation

Fill the three brackets, paste the whole thing. It routes the agent through the
`product-strategy` skill, the research skills, and the knowledge base.

---

## THE PROMPT

> Load the `product-strategy` skill and act as my CPO, not my coder.
>
> **Product:** [PRODUCT NAME + one-line description]
> **Decision I need:** [e.g. "is this worth building at all?" / "what is our wedge?"
> / "what do we charge?" / "which 3 features ship first?"]
> **Constraint:** [budget / timeline / platform / team size]
>
> Do this in order and stop at any point the evidence says stop:
>
> **1. Who already won.** Find the 5–8 closest competitors AND the products that
> made real money in this category. For each: positioning, pricing/packaging,
> what users publicly love, what they publicly hate, and the moat. Cite every
> source. If a number (ARR/MAU/retention) isn't published, write "not public" —
> do NOT estimate silently.
>
> **2. Why they won.** For the top 2 revenue successes, explain the *mechanism*:
> what made people pay, what made them come back weekly, what made them tell a
> friend. Distinguish the real driver from the marketing story.
>
> **3. Where they fail.** Pull real store data first — do NOT analyse from
> recollection:
>
> ```bash
> node research/tools/store-intel.mjs --apple <id> --google <package> --pages 10 --googleReviews 500 --out research/App-Reviews/<name>
> ```
>
> Use its computed counts verbatim. Then add Reddit/HN/X and support threads for
> what reviews miss. Report your sample size honestly — do not imply
> exhaustiveness, and note that store samples are most-recent-N, not random.
>
> **3b. How their UI actually works.** Open the competitor's live product or
> marketing site in the Browser pane and read the real page — onboarding order,
> CTA wording, form length, paywall placement, empty states. Record each pattern
> in `research/UI-Research/patterns.md` with its A/B/C evidence tier. Never
> describe a UI from memory.
>
> **4. The gap.** Name the specific unmet job. State plainly whether it is big
> enough to build a business on, or whether this is a crowded category where we
> should not compete.
>
> **5. Our wedge.** What can WE do that incumbents structurally cannot (not
> "better UX" — a structural advantage they'd have to break their own product to
> copy)? If we don't have one, say so.
>
> **6. Feature shortlist.** Score candidates with RICE + Kano. Include AI
> inference cost per active user. Cut everything that isn't a Must.
>
> **7. Money.** Pricing model + tiers, then MRR/ARR at 10K / 100K / 1M users,
> with inference cost, gross margin, break-even, and LTV:CAC. Flag any tier
> where AI cost exceeds revenue.
>
> **8. Decision memo.** Why build / why not / user impact / revenue / retention /
> complexity / AI cost / risks / better alternatives / **Build, Delay, or Reject**.
>
> Write findings into `fable/research/<folder>/` — refine existing files, never
> duplicate. Date and cite everything.
>
> **Disagree with me where the evidence disagrees.** If the honest answer is
> "don't build this", say that and tell me what to build instead.

---

## Skills this uses

**Gateway:** `product-strategy` → **build gate:** `proven-pattern-check`

| Stage | Skills |
|---|---|
| Research | `research` · `deep-research` · `firecrawl-deep-research` · `planning-with-files` |
| Competitors | `competitors` · `competitor-profiling` (marketing-skills) · `competitor-analysis` + `competitor-tracking` (aso-skills) · `competitive-battlecard` (pm-go-to-market) |
| Reviews & market | `review-management` · `market-pulse` · `aso-audit` (aso-skills) · `sentiment-analysis` · `market-sizing` · `user-personas` (pm-market-research) |
| UI/UX | `proven-pattern-check` · `design-brain` + specialists · `mobile-app-design-standards` · `nng-ux-heuristics` · `micro-interactions` |
| Conversion | `cro` · `signup` · `onboarding` · `paywalls` · `marketing-psychology` (marketing-skills) · `onboarding-optimization` · `paywall-optimization` (aso-skills) |
| Money | `pricing` (marketing-skills) · `pricing-strategy` · `monetization-strategy` · `startup-canvas` · `lean-canvas` (pm-product-strategy) |
| Launch | `launch` · `ads` · `ab-testing` (marketing-skills) · `app-launch` · `screenshot-optimization` · `keyword-research` (aso-skills) · `growth-loops` · `gtm-strategy` |

**Data layer:** `research/tools/store-intel.mjs` — the skills above describe
*method*; none of them fetch anything. This is what gets the actual numbers.

## Rules that keep it honest

- Never invent ARR/MAU/DAU/retention. Cite or write "not public".
- Report sample sizes for review mining; no implied exhaustiveness. Store samples
  are most-recent-N and recency-biased, not random.
- Tier every UI/CRO claim **A/B/C**. Never promote a tier; never present a
  convergent observation (B) as a measured lift (A).
- Never attribute revenue to a UI pattern. A large product shipping a pattern is
  an observation about the product, not proof the pattern earned the money.
- No video watching — transcripts/write-ups only, and say which was used.
- One product, one decision per run. Blanket sweeps are expensive and decide nothing.
