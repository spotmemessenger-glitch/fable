import type { Metadata } from "next";
import { LegalPage, LegalSection, LegalTodo } from "@/components/ui/legal-page";

export const metadata: Metadata = {
  title: "Terms & Conditions",
  description: "The terms that govern your use of YSNAP.",
  robots: { index: true, follow: true },
};

const COMPANY = "Jootshop";

export default function TermsPage() {
  return (
    <LegalPage
      title="YSNAP — Terms & Conditions"
      lastUpdated="July 22, 2026 (draft — pending legal review before launch)"
      intro={
        <p>
          These Terms govern your use of YSNAP. They work alongside our{" "}
          <a href="/privacy-policy" className="text-accent-deep underline underline-offset-4">
            Privacy Policy
          </a>{" "}
          and{" "}
          <a href="/eula" className="text-accent-deep underline underline-offset-4">
            EULA
          </a>
          . This is a working draft, not a published policy &mdash; items marked{" "}
          <LegalTodo>pending</LegalTodo> need a decision or a lawyer&rsquo;s input before launch.
        </p>
      }
    >
      <LegalSection n="1" title="Acceptance">
        <p>
          By downloading, installing, accessing or using YSNAP (the &ldquo;Service&rdquo;), you
          agree to these Terms. If you do not agree, do not use the Service. These Terms are
          between you and {COMPANY} (&ldquo;YSNAP&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;), a
          company registered in India.
        </p>
        <p>
          If you accept these Terms on behalf of an organisation (for example on a Teams plan),
          you represent that you have authority to bind that organisation.
        </p>
      </LegalSection>

      <LegalSection n="2" title="Eligibility and Age">
        <p>
          You must be at least 16 years old to create an account. Where local law sets a higher
          age for consent to the processing of personal or biometric data, that higher age
          applies. We do not knowingly permit under-16s to create accounts or voice clones.
        </p>
        <p>
          <LegalTodo>Decision pending:</LegalTodo> if you intend to serve 13&ndash;15 year olds,
          this clause and Section 10 of the Privacy Policy must change together, and you must
          implement verifiable parental consent before launch. India&rsquo;s DPDP Act treats
          everyone under 18 as a child and requires verifiable parental consent plus a ban on
          behavioural monitoring and targeted advertising to them; GDPR Article 8 sets the
          threshold between 13 and 16 depending on the member state.
        </p>
      </LegalSection>

      <LegalSection n="3" title="The Service">
        <p>
          YSNAP provides AI-assisted translation, voice intelligence (text-to-speech,
          speech-to-text and voice cloning), and camera-based recognition across 16 analysis
          modes. Some processing runs on your device; some requires transmission to our servers
          and to the processors named in our Privacy Policy.
        </p>
        <p>
          Features vary by plan and may change, be added or be withdrawn. We may modify or
          discontinue any part of the Service, and will give reasonable notice of material adverse
          changes to paid features.
        </p>
      </LegalSection>

      <LegalSection n="4" title="Accounts">
        <p>
          You are responsible for the accuracy of your account information, for keeping your
          credentials confidential, and for all activity under your account. Notify us at
          support@ysnapai.com of any unauthorised use. We may suspend or terminate accounts that
          breach these Terms.
        </p>
      </LegalSection>

      <LegalSection n="5" title="Plans and Pricing">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-ink">Starter</strong> &mdash; free. 10 translations and 5
            camera scans per day, standard voices, 40 languages, and one voice clone.
          </li>
          <li>
            <strong className="text-ink">Pro</strong> &mdash; USD 11.99 per month, or USD 79.99 per
            year (equivalent to USD 6.67 per month). Unlimited translation, all 16 camera modes,
            up to 3 voice clones, 120+ languages, offline packs and priority processing.
          </li>
          <li>
            <strong className="text-ink">Teams</strong> &mdash; USD 19.99 per user per month.
            Everything in Pro, up to 10 voice clones per user, shared glossaries, admin console
            and SSO.
          </li>
        </ul>
        <p>
          Prices are in USD and exclude taxes unless stated. Local currency, tax and pricing are
          determined by the applicable app store. We may change prices with notice; changes take
          effect at your next renewal, and you may cancel before then.
        </p>
      </LegalSection>

      <LegalSection n="6" title="Auto-Renewing Subscriptions">
        <p>
          Paid plans are auto-renewing subscriptions. The following terms are required by the app
          stores and apply to every paid plan:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Payment is charged to your Apple ID or Google Play account at confirmation of
            purchase.
          </li>
          <li>
            Your subscription renews automatically at the then-current price unless auto-renew is
            turned off at least 24 hours before the end of the current period.
          </li>
          <li>
            Your account is charged for renewal within 24 hours prior to the end of the current
            period.
          </li>
          <li>
            You can manage your subscription and turn off auto-renew in your device&rsquo;s App
            Store or Google Play account settings after purchase. We cannot cancel a store
            subscription on your behalf.
          </li>
          <li>
            Where a free trial is offered, any unused portion is forfeited when you purchase a
            subscription. Cancel at least 24 hours before the trial ends to avoid being charged.
          </li>
          <li>
            Cancelling stops future renewals. It does not shorten the period you have already paid
            for; access continues to the end of that period.
          </li>
        </ul>
      </LegalSection>

      <LegalSection n="7" title="Digital Goods, Refunds and Right of Withdrawal">
        <p>
          The Service and all in-app purchases are digital goods delivered immediately on
          purchase. They are not tangible goods and are not shipped or returned.
        </p>
        <p>
          <strong className="text-ink">Refunds are handled by Apple and Google</strong>, not by us,
          because they are the merchant of record for in-app purchases. Request a refund through
          your App Store purchase history or the Google Play refund process. We have no ability to
          issue, expedite or reverse a store refund, though we will assist where we reasonably
          can.
        </p>
        <p>
          <strong className="text-ink">EU, UK and comparable jurisdictions.</strong> Where you have
          a statutory right to withdraw from a distance contract within 14 days, you expressly
          request that we begin supplying the digital content immediately, and you acknowledge
          that you thereby lose that right of withdrawal once supply has begun, to the extent
          permitted by the applicable consumer directive or regulation. Nothing here limits
          remedies you have for content that is faulty, not as described, or not fit for purpose.
        </p>
        <p>
          Except where required by law or expressly stated, purchases are final and fees are
          non-refundable.
        </p>
      </LegalSection>

      <LegalSection n="8" title="Allowances and Fair Use">
        <p>
          Free-plan daily limits and per-plan voice clone allowances are metered. Unused daily
          allowances do not roll over and have no cash value. Allowances are a licence to use
          capacity, not a purchase of property, and cannot be sold, transferred or exchanged.
        </p>
        <p>
          &ldquo;Unlimited&rdquo; usage on paid plans is subject to fair use: we may apply rate
          limits or contact you where usage is materially inconsistent with normal individual or
          business use, or indicates automated or resale activity.
        </p>
      </LegalSection>

      <LegalSection n="9" title="Voice Cloning and Consent">
        <p className="mb-1">
          <LegalTodo>Highest-risk section &mdash; requires specialist review.</LegalTodo>
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            You may create a voice clone only from your own voice, or a voice you are legally
            authorised to use and for which you hold documented consent.
          </li>
          <li>
            You must not clone, imitate or synthesise any person&rsquo;s voice without their
            explicit, informed consent.
          </li>
          <li>
            You must not use a cloned voice to impersonate anyone, to deceive listeners about who
            is speaking, to commit fraud, to harass, or to defeat voice authentication.
          </li>
          <li>
            Clone allowances are one on Starter, up to three on Pro, and up to ten per user on
            Teams.
          </li>
          <li>
            Your voice samples are stored privately to your account, are not used to train shared
            or public models, and can be deleted by you at any time in Settings.
          </li>
          <li>
            You are solely responsible for compliance with biometric, privacy, publicity and
            impersonation laws applicable to you.
          </li>
        </ul>
      </LegalSection>

      <LegalSection n="10" title="Acceptable Use">
        <p>You must not use the Service to:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>break any law, or infringe anyone&rsquo;s intellectual property, privacy or publicity rights;</li>
          <li>create deceptive, fraudulent or impersonating content, including synthetic voice used to mislead;</li>
          <li>harass, threaten, defame or harm others, or generate content sexualising minors;</li>
          <li>upload malware, or attempt to gain unauthorised access to the Service or other users&rsquo; data;</li>
          <li>
            scrape, crawl or use automated means to access the Service or our APIs, or to extract
            data or outputs at scale;
          </li>
          <li>
            reverse engineer the Service, or use it or its outputs to train or benchmark a
            competing model;
          </li>
          <li>resell, sublicense or provide the Service to third parties without our written agreement;</li>
          <li>circumvent usage limits, authentication or security controls.</li>
        </ul>
      </LegalSection>

      <LegalSection n="11" title="Your Content and Our Rights">
        <p>
          You retain ownership of content you submit. You grant us a limited, worldwide,
          royalty-free licence to host, process and transmit that content solely to provide the
          Service to you, including to the processors named in our Privacy Policy. We do not use
          your content to train shared or public models.
        </p>
        <p>
          The Service, its software, models and branding are owned by {COMPANY} and its licensors.
          Subject to these Terms, you own the outputs generated for you and may use them for any
          lawful purpose. Detailed licence terms for the mobile app are in the{" "}
          <a href="/eula" className="text-accent-deep underline underline-offset-4">
            EULA
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection n="12" title="Accuracy Disclaimer">
        <p>
          Translations, transcriptions and camera analyses are AI-generated and may be wrong. Do
          not rely on the Service for medical, legal, financial, navigational or other decisions
          requiring professional accuracy. Camera results relating to health, medication or safety
          are informational only and are not a diagnosis or professional advice. Verify important
          information independently.
        </p>
      </LegalSection>

      <LegalSection n="13" title="Account Deletion and Termination">
        <p>
          You may delete your account at any time from Settings &rarr; Account &rarr; Delete
          Account in the app, or by emailing support@ysnapai.com. Apple requires that apps
          offering account creation also offer in-app account deletion; ours does.
        </p>
        <p>
          Deleting your account removes your profile, translation history and voice clones from
          our active systems within the retention window stated in our Privacy Policy. Deleting
          the app alone does not delete your account, and does not cancel a store subscription
          &mdash; cancel that separately in your store settings.
        </p>
        <p>
          We may suspend or terminate your access for breach of these Terms, for suspected
          fraudulent or unlawful use, or where required by law. Sections 11, 12, 14, 15, 16 and 17
          survive termination.
        </p>
      </LegalSection>

      <LegalSection n="14" title="Disclaimers">
        <p>
          To the maximum extent permitted by law, the Service is provided &ldquo;as is&rdquo; and
          &ldquo;as available&rdquo;, without warranties of any kind, express or implied. We do not
          warrant that the Service will be uninterrupted, secure, error-free, or that outputs will
          be accurate. Nothing in these Terms excludes liability that cannot lawfully be excluded,
          including for death or personal injury caused by negligence, or fraud.
        </p>
      </LegalSection>

      <LegalSection n="15" title="Limitation of Liability">
        <p>
          To the maximum extent permitted by law, {COMPANY} is not liable for indirect,
          incidental, special, consequential or punitive damages, or for loss of profits, revenue,
          data, goodwill or business. Our total aggregate liability for any claim relating to the
          Service will not exceed the greater of the amount you paid us in the twelve months
          before the claim arose, or{" "}
          <LegalTodo>[liability cap — pending, commonly USD 100]</LegalTodo>.
        </p>
        <p>
          If you are a consumer, mandatory local consumer protection law may give you rights this
          section cannot limit.
        </p>
      </LegalSection>

      <LegalSection n="16" title="Indemnity">
        <p>
          You will indemnify and hold harmless {COMPANY} and its officers, employees and agents
          from claims, damages and reasonable legal costs arising from your breach of these Terms,
          your misuse of the Service, your content, or your use of a cloned voice without adequate
          consent or authority. This does not apply to the extent the claim arises from our own
          breach or negligence.
        </p>
      </LegalSection>

      <LegalSection n="17" title="Governing Law and Disputes">
        <p>
          These Terms are governed by the laws of India, without regard to conflict-of-law rules.
          The courts of <LegalTodo>[city/state of registration — pending]</LegalTodo> have
          exclusive jurisdiction, except that either party may seek injunctive relief in any
          competent court.
        </p>
        <p>
          If you are a consumer resident in the EU, the UK or elsewhere whose law grants mandatory
          local protections, nothing here deprives you of those protections or of your right to
          bring proceedings in your country of residence. Before formal proceedings, please
          contact support@ysnapai.com so we can try to resolve the matter.
        </p>
      </LegalSection>

      <LegalSection n="18" title="Changes to These Terms">
        <p>
          We may update these Terms. We will post the revised version with a new &ldquo;last
          updated&rdquo; date and, for material changes, give notice in the app or by email before
          they take effect. Continued use after they take effect constitutes acceptance.
        </p>
      </LegalSection>

      <LegalSection n="19" title="Apple App Store — Additional Terms">
        <p>
          These Terms are between you and {COMPANY} only, not Apple. Apple has no obligation to
          provide maintenance or support for the app, and is not responsible for product
          warranties or for any claim relating to the app, including product liability, regulatory
          non-conformity, or consumer protection claims. Apple and its subsidiaries are
          third-party beneficiaries of these Terms and may enforce them against you. Full
          Apple-required terms are set out in Section 12 of our{" "}
          <a href="/eula" className="text-accent-deep underline underline-offset-4">
            EULA
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection n="20" title="Google Play — Additional Terms">
        <p>
          Your use of the app obtained through Google Play is also subject to the Google Play
          Terms of Service. Google is not a party to these Terms and is not responsible for the
          app. We complete the Google Play Data Safety declarations for the data described in our
          Privacy Policy.
        </p>
      </LegalSection>

      <LegalSection n="21" title="Contact">
        <p>
          {COMPANY}, <LegalTodo>[registered address — pending]</LegalTodo> &mdash;
          support@ysnapai.com.
        </p>
      </LegalSection>

      <div className="rounded-panel border border-amber/30 bg-amber/5 p-5 text-sm text-ink-soft">
        <strong className="text-ink">Before publishing:</strong> settle the age threshold in
        Section 2 (this drives the Privacy Policy too), the liability cap in Section 15, the court
        in Section 17, and the registered address. Have counsel review Section 9 against
        BIPA/GDPR Article 9 and India&rsquo;s DPDP Act, and confirm the Section 7 withdrawal waiver
        is drafted correctly for each consumer market you sell into.
      </div>
    </LegalPage>
  );
}
