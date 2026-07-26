import type { Metadata } from "next";
import { LegalPage, LegalSection, LegalTodo } from "@/components/ui/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How YSNAP collects, uses, shares and protects your data — including voice and biometric data.",
  robots: { index: true, follow: true },
};

const COMPANY = "Jootshop";

/** Rendered as a scrollable table on phones — these have 4–5 columns. */
function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="-mx-6 overflow-x-auto px-6 md:mx-0 md:px-0">
      <table className="w-full min-w-[560px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-hairline text-left">
            {head.map((h) => (
              <th key={h} className="py-2 pr-4 font-semibold text-ink">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-hairline/70 align-top">
              {r.map((c, j) => (
                <td key={j} className="py-2.5 pr-4 leading-relaxed text-muted">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <LegalPage
      title="YSNAP — Privacy Policy"
      lastUpdated="July 22, 2026 (draft — pending legal review before launch)"
      intro={
        <p>
          {COMPANY} (&ldquo;YSNAP&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;), a company registered
          in India, built YSNAP to translate, speak and see in 120+ languages. This policy explains
          what we collect, why, who we share it with, and the rights you have. Items marked{" "}
          <LegalTodo>pending</LegalTodo> need a decision before launch. Because the app processes
          voice recordings, which are biometric data in several jurisdictions, please read
          Sections 3 and 5 carefully.
        </p>
      }
    >
      <LegalSection n="1" title="Who We Are and How to Reach Us">
        <p>
          Data controller: {COMPANY},{" "}
          <LegalTodo>[registered address — pending]</LegalTodo>, India. Privacy contact:
          privacy@ysnapai.com. General support: support@ysnapai.com.
        </p>
        <p>
          <LegalTodo>Pending:</LegalTodo> if you offer the app in the EU or UK, GDPR Article 27
          requires you to appoint a representative established there and name them here, because
          you have no establishment in those regions.
        </p>
      </LegalSection>

      <LegalSection n="2" title="What We Collect">
        <Table
          head={["Category", "Examples", "Source", "Why"]}
          rows={[
            ["Account data", "Name, email address, password hash, plan and subscription status", "You", "Create and maintain your account; provide paid features"],
            ["Content you submit", "Text for translation, camera photographs, documents", "You", "Return the translation or analysis you asked for"],
            ["Voice recordings", "Speech for transcription; voice samples used to create a clone", "You", "Speech-to-text; creating and storing the voice clones you request"],
            ["Voiceprint (biometric)", "The derived model representing your voice", "Generated from your sample", "Synthesising speech in your voice, only when you ask"],
            ["Device and technical data", "Device model, OS version, app version, language, IP address, crash logs, device identifiers", "Automatically", "Run the service, diagnose crashes, prevent abuse, apply rate limits"],
            ["Usage analytics", "Features used, session counts, error events, aggregate volumes", "Automatically", "Understand which features work and improve reliability"],
            ["Purchase records", "Store transaction identifier, plan, renewal status", "Apple / Google", "Entitlements and support. We never receive your full card number"],
          ]}
        />
        <p>
          We do not collect precise geolocation, contacts, health records or advertising
          identifiers, and we do not operate advertising or cross-app tracking.
        </p>
      </LegalSection>

      <LegalSection n="3" title="Voice and Biometric Data">
        <p className="mb-1">
          <LegalTodo>Highest-risk section &mdash; requires specialist review before launch.</LegalTodo>
        </p>
        <p>
          To create a voice clone we process a recording of your voice and derive a voiceprint.
          In several jurisdictions this is biometric or special-category data: GDPR Article 9,
          Illinois BIPA, Texas CUBI, and India&rsquo;s DPDP Act among them.
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-ink">Consent.</strong> We process voice data only with your
            explicit, informed, opt-in consent, captured on the recording screen at the moment you
            create a clone. You confirm the voice is yours or that you are authorised to use it.
            Consent is never bundled into general acceptance of these documents.
          </li>
          <li>
            <strong className="text-ink">Purpose limit.</strong> Voice data is used only to provide
            the features you request. It is never used to train shared, public or foundation
            models, and never sold or licensed.
          </li>
          <li>
            <strong className="text-ink">Withdrawal.</strong> You may delete any clone and its
            source sample at any time in Settings, and withdraw consent by doing so or by emailing
            privacy@ysnapai.com. Withdrawal does not affect processing already carried out.
          </li>
          <li>
            <strong className="text-ink">Retention.</strong> Voice samples and voiceprints are kept
            until you delete them or close your account, then removed from active systems within
            the window in Section 8.
          </li>
          <li>
            <strong className="text-ink">Third-party processing.</strong> Voice synthesis is
            performed by a specialist processor (see Section 6), which means your voice data is
            transmitted outside your device and, in most cases, outside your country.
          </li>
        </ul>
      </LegalSection>

      <LegalSection n="4" title="On-Device and Cloud Processing">
        <p>
          Where possible, core models run on your device and content never leaves your phone. Some
          features require cloud processing &mdash; notably voice cloning and speech synthesis,
          speech-to-text, and certain camera analyses. In those cases data is encrypted in transit
          (TLS) and processed only to return your result. The app indicates when a feature is
          running on-device.
        </p>
      </LegalSection>

      <LegalSection n="5" title="Legal Bases (GDPR / UK GDPR)">
        <Table
          head={["Purpose", "Legal basis"]}
          rows={[
            ["Providing translation, camera and voice features you request", "Contract — Article 6(1)(b)"],
            ["Creating and storing voice clones (voiceprint)", "Explicit consent — Article 9(2)(a), with Article 6(1)(a)"],
            ["Security, abuse prevention, rate limiting", "Legitimate interests — Article 6(1)(f)"],
            ["Reliability, crash diagnosis and service improvement", "Legitimate interests — Article 6(1)(f)"],
            ["Billing, tax and statutory record-keeping", "Legal obligation — Article 6(1)(c)"],
          ]}
        />
        <p>
          Where we rely on legitimate interests, we have assessed that our interest is not
          overridden by your rights, and you may object as described in Section 9.
        </p>
      </LegalSection>

      <LegalSection n="6" title="Who We Share Data With">
        <p>
          We do not sell your personal data, do not share it for cross-context behavioural
          advertising, and do not use it for advertising at all. We share it only with processors
          who help us run the service, under contract, and only as needed:
        </p>
        <Table
          head={["Processor", "Purpose", "Data shared", "Location"]}
          rows={[
            ["ElevenLabs", "Speech synthesis and voice cloning", "Voice samples, voiceprint, text to be spoken", "United States"],
            ["Deepgram", "Speech-to-text transcription", "Short audio recordings", "United States"],
            ["Anthropic", "AI assistant responses on our website", "Chat messages you send the assistant", "United States"],
            ["Vercel", "Website and API hosting", "IP address, request metadata", "Global edge network"],
            ["Apple / Google", "App distribution and payment processing", "Purchase and subscription records", "Global"],
            ["Hostinger", "Website hosting (static mirror)", "IP address, request logs", "Pending"],
          ]}
        />
        <p>
          <LegalTodo>Pending:</LegalTodo> confirm this list matches production before launch, sign
          a Data Processing Agreement with each processor, and verify each one&rsquo;s transfer
          mechanism. Google Play&rsquo;s Data Safety form and Apple&rsquo;s privacy label must both
          reflect exactly this list.
        </p>
        <p>
          We may also disclose data where required by law, to enforce our Terms, or in connection
          with a merger or acquisition (with notice to you).
        </p>
      </LegalSection>

      <LegalSection n="7" title="International Transfers">
        <p>
          We are based in India and use processors in the United States and elsewhere, so your
          data is transferred internationally. For transfers from the EU, UK or Switzerland we
          rely on the European Commission&rsquo;s Standard Contractual Clauses (and the UK
          Addendum or IDTA where applicable), together with supplementary technical measures
          including encryption in transit and at rest.{" "}
          <LegalTodo>Pending: confirm SCCs are executed with each processor.</LegalTodo>
        </p>
      </LegalSection>

      <LegalSection n="8" title="Retention and Deletion">
        <Table
          head={["Data", "Retention"]}
          rows={[
            ["Voice samples and voiceprints", "Until you delete them or close your account"],
            ["Translation and scan history", "Until you clear it or close your account"],
            ["Account data", "For the life of the account"],
            ["Billing and tax records", "As required by Indian tax law (commonly 8 years)"],
            ["Crash and security logs", "Pending — commonly 30–90 days"],
          ]}
        />
        <p>
          On account deletion we remove associated data from active systems within{" "}
          <LegalTodo>[retention window — pending, commonly 30 days]</LegalTodo>, with residual
          copies purged from encrypted backups on the normal backup rotation. Delete your account
          in the app at Settings &rarr; Account &rarr; Delete Account, or email
          privacy@ysnapai.com.
        </p>
      </LegalSection>

      <LegalSection n="9" title="Your Rights">
        <p>
          Subject to your location, you may have the right to access your data, correct it, delete
          it, export it in a portable format, object to or restrict processing, and withdraw
          consent. To exercise any of these, email privacy@ysnapai.com. We respond within 30 days
          (or one month under GDPR, extendable by two months for complex requests), and we will
          not discriminate against you for exercising a right.
        </p>
        <p>
          <strong className="text-ink">EU / UK (GDPR).</strong> You also have the right to lodge a
          complaint with your supervisory authority, or the UK Information Commissioner&rsquo;s
          Office.
        </p>
        <p>
          <strong className="text-ink">California (CCPA/CPRA).</strong> You have rights to know,
          delete, correct, and to limit the use of sensitive personal information. Voice data used
          to create a clone is sensitive personal information; we use it only to provide the
          feature you requested, which is a permitted purpose. We have not sold or shared personal
          information for cross-context behavioural advertising in the preceding 12 months, and do
          not do so. You may use an authorised agent to submit a request.
        </p>
        <p>
          <strong className="text-ink">India (DPDP Act 2023).</strong> You have rights to access, correct,
          erase, nominate a person to exercise rights on your behalf, and to grievance redressal.{" "}
          <LegalTodo>Pending: appoint and name a Grievance Officer, as the Act requires.</LegalTodo>
        </p>
      </LegalSection>

      <LegalSection n="10" title="Children&rsquo;s Privacy">
        <p>
          YSNAP is not directed to children. You must be at least 16 to create an account, and we
          do not knowingly collect personal or biometric data from anyone under that age. If we
          learn we have, we delete it promptly. A parent or guardian who believes their child has
          provided us data should contact privacy@ysnapai.com.
        </p>
        <p>
          <LegalTodo>Decision pending &mdash; read before launch.</LegalTodo> If you decide to
          serve 13&ndash;15 year olds, this section and Section 2 of the Terms must change
          together, and you must build a verifiable parental consent flow first. Three regimes
          bind you at once: India&rsquo;s DPDP Act treats everyone under 18 as a child, requires
          verifiable parental consent, and bans behavioural monitoring and targeted advertising to
          them; GDPR Article 8 sets the threshold between 13 and 16 by member state; and US COPPA
          applies under 13. Collecting voiceprints from minors is a heightened-risk activity in all
          three.
        </p>
      </LegalSection>

      <LegalSection n="11" title="Security">
        <p>
          We use encryption in transit (TLS) and at rest, access controls, and least-privilege
          practices. Voice samples are stored privately to your account. No method is completely
          secure, but we work to protect your data and will notify you and the relevant regulator
          of a qualifying breach within the timeframes the law requires (72 hours under GDPR).
        </p>
      </LegalSection>

      <LegalSection n="12" title="Permissions the App Requests">
        <Table
          head={["Permission", "Why", "Optional?"]}
          rows={[
            ["Microphone", "Record speech for transcription, live interpreting and voice cloning", "Yes — denying disables voice features only"],
            ["Camera", "Scan text, objects and documents for the 16 camera modes", "Yes — denying disables camera features only"],
            ["Photo library", "Analyse an image you choose", "Yes — read-only, only for images you select"],
            ["Notifications", "Alerts you opt into", "Yes"],
            ["Network access", "Cloud features and subscription validation", "Required"],
          ]}
        />
        <p>
          Permissions are requested in context, at the moment the feature is first used, never at
          launch. A visible recording indicator is shown throughout microphone capture, as Apple
          guideline 2.5.14 requires.
        </p>
      </LegalSection>

      <LegalSection n="13" title="In-App Voice Clone Consent Prompt">
        <p className="mb-1">
          The recording screen shows this before any capture begins:
        </p>
        <div className="rounded-panel border border-hairline bg-surface p-5 text-sm">
          <p className="font-medium text-ink">Create your voice clone</p>
          <p className="mt-2">
            We&rsquo;ll record a short sample of your voice so YSNAP can recreate it across 120+
            languages. Please read the sentence on the next screen aloud.
          </p>
          <p className="mt-2">By continuing, you confirm that:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>This is your own voice, or a voice you&rsquo;re authorized to clone.</li>
            <li>You agree to YSNAP processing this recording to create your voice clone.</li>
            <li>
              Your sample stays private to your account, is never used to train shared models, and
              can be deleted anytime in Settings.
            </li>
          </ul>
          <p className="mt-2 text-faint">
            Buttons: &ldquo;I agree — start recording&rdquo; / &ldquo;Cancel&rdquo;. A visible
            mic and red-dot &ldquo;Recording…&rdquo; indicator stays on screen for the whole
            capture.
          </p>
        </div>
      </LegalSection>

      <LegalSection n="14" title="Store Disclosures">
        <p>
          <strong className="text-ink">Google Play Data Safety.</strong> We declare collection of:
          personal info (name, email); audio (voice recordings); photos; app activity; app info and
          performance (crash logs, diagnostics); and device or other identifiers. Data is
          encrypted in transit, users can request deletion, and no data is shared for advertising.
          Audio is declared as collected and shared with processors for app functionality.
        </p>
        <p>
          <strong className="text-ink">Apple App Privacy.</strong> We declare Contact Info, User
          Content (audio, photos), Identifiers, Usage Data and Diagnostics, all linked to the user
          and used for App Functionality &mdash; not for Tracking. We do not use the App Tracking
          Transparency framework because we do not track users across apps or websites.
        </p>
        <p>
          <LegalTodo>Pending:</LegalTodo> these two declarations must match Section 2 and Section 6
          exactly at submission. Mismatches are a frequent cause of rejection and of post-launch
          removal.
        </p>
      </LegalSection>

      <LegalSection n="15" title="Website Cookies">
        <p>
          Our website uses only strictly necessary storage to run the site and remember your
          preferences. We do not use advertising or cross-site tracking cookies.{" "}
          <LegalTodo>Pending: if analytics are added later, a consent banner is required for EU/UK visitors.</LegalTodo>
        </p>
      </LegalSection>

      <LegalSection n="16" title="Changes to This Policy">
        <p>
          We may update this policy and will post the revised version with a new date. For material
          changes &mdash; especially any change to how voice data is used &mdash; we will notify
          you in the app and, where the law requires, seek fresh consent.
        </p>
      </LegalSection>

      <LegalSection n="17" title="Contact and Complaints">
        <p>
          {COMPANY}, <LegalTodo>[registered address — pending]</LegalTodo> &mdash;
          privacy@ysnapai.com. If you are unhappy with our response you may complain to your local
          supervisory authority, or in India to the Data Protection Board once constituted.
        </p>
      </LegalSection>

      <div className="rounded-panel border border-amber/30 bg-amber/5 p-5 text-sm text-ink-soft">
        <strong className="text-ink">Before publishing &mdash; the blocking items:</strong> the
        age decision in Section 10 (it drives the whole document), the EU/UK Article 27
        representative in Section 1, the Grievance Officer in Section 9, signed DPAs and SCCs with
        every processor in Sections 6 and 7, the retention window in Section 8, and the registered
        address. Section 3 is the one to put in front of a privacy specialist: biometric consent
        under BIPA, GDPR Article 9 and the DPDP Act is where the real exposure sits.
      </div>
    </LegalPage>
  );
}
