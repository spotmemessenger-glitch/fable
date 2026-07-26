import type { Metadata } from "next";
import { LegalPage, LegalSection, LegalTodo } from "@/components/ui/legal-page";

export const metadata: Metadata = {
  title: "End User License Agreement",
  description: "The licence terms governing your use of the YSNAP mobile application.",
  robots: { index: true, follow: true },
};

const COMPANY = "Jootshop";

export default function EulaPage() {
  return (
    <LegalPage
      title="YSNAP — End User License Agreement"
      lastUpdated="July 22, 2026 (draft — pending legal review before launch)"
      intro={
        <p>
          This EULA licenses the YSNAP mobile application. It sits alongside our{" "}
          <a href="/terms" className="text-accent-deep underline underline-offset-4">
            Terms &amp; Conditions
          </a>{" "}
          and{" "}
          <a href="/privacy-policy" className="text-accent-deep underline underline-offset-4">
            Privacy Policy
          </a>
          . Apple requires a EULA for every App Store listing; if you do not supply your own,
          Apple&rsquo;s standard Licensed Application End User License Agreement applies instead.
          Sections 12 and 13 are the Apple- and Google-specific terms those stores require.
        </p>
      }
    >
      <LegalSection n="1" title="Licence Grant">
        <p>
          Subject to your compliance with this EULA, {COMPANY} grants you a limited,
          non-exclusive, non-transferable, non-sublicensable, revocable licence to download,
          install and use one copy of the YSNAP application (the &ldquo;App&rdquo;) on a device
          you own or control, solely for your personal or internal business purposes.
        </p>
        <p>
          On Apple platforms this licence is governed by the Usage Rules in the Apple Media
          Services Terms and Conditions, and permits use on any Apple-branded device you own or
          control, as permitted by Family Sharing or volume purchasing where applicable.
        </p>
        <p>
          This is a licence, not a sale. All rights not expressly granted are reserved by
          {" "}{COMPANY} and its licensors.
        </p>
      </LegalSection>

      <LegalSection n="2" title="Restrictions">
        <p>You must not, and must not permit any third party to:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            reverse engineer, decompile, disassemble, decrypt or otherwise attempt to derive the
            source code, model weights, algorithms or underlying structure of the App, except to
            the extent this restriction is expressly prohibited by applicable law;
          </li>
          <li>
            copy, modify, adapt, translate or create derivative works of the App or any part of
            it;
          </li>
          <li>
            rent, lease, lend, sell, sublicense, assign, distribute, publish, transfer or
            otherwise make the App available to any third party;
          </li>
          <li>
            use any robot, spider, scraper, crawler, headless browser or other automated means to
            access the App or our APIs, or to extract, harvest or index data, outputs or content
            from the service;
          </li>
          <li>
            circumvent, disable or interfere with rate limits, authentication, licence
            enforcement, usage metering or any security or access-control feature;
          </li>
          <li>
            use the App or its outputs to train, fine-tune, distil or benchmark any competing
            machine-learning model or service;
          </li>
          <li>
            remove, obscure or alter any proprietary notice, watermark or attribution;
          </li>
          <li>
            use the App to build a competing product, or resell, sublicense or provide the App&rsquo;s
            functionality to third parties as a service;
          </li>
          <li>
            use the App on a jailbroken, rooted or otherwise modified device where doing so
            defeats platform security controls.
          </li>
        </ul>
      </LegalSection>

      <LegalSection n="3" title="Ownership and Intellectual Property">
        <p>
          The App, including all software, models, user interfaces, designs, text, graphics,
          trade marks and the YSNAP name and logo, is owned by {COMPANY} and its licensors and is
          protected by copyright, trade mark and other intellectual property laws. Feedback you
          submit may be used by us without restriction or obligation to you.
        </p>
      </LegalSection>

      <LegalSection n="4" title="Your Content and Outputs">
        <p>
          You retain ownership of the content you submit &mdash; text, photographs, camera input,
          audio recordings and voice samples. You grant us a limited, worldwide,
          royalty-free licence to host, process, transmit and display that content solely to
          operate the service for you, including transmitting it to the processors named in our
          Privacy Policy.
        </p>
        <p>
          Subject to your compliance with this EULA, you own the outputs the App generates for
          you &mdash; translations, transcriptions, analyses and synthesised audio &mdash; and may
          use them for any lawful purpose. Outputs are generated by machine learning and may not
          be unique; identical or similar outputs may be generated for other users.
        </p>
      </LegalSection>

      <LegalSection n="5" title="Voice Cloning Licence Conditions">
        <p>
          The voice cloning feature is licensed to you on the following additional conditions,
          each of which is a material term:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            you may create a voice clone only from your own voice, or from a voice you are
            legally authorised to reproduce and for which you hold documented consent;
          </li>
          <li>
            you must not use a cloned voice to impersonate any person, to create content
            suggesting a person said something they did not say, or to deceive any listener as to
            the identity of a speaker;
          </li>
          <li>
            you must not use a cloned voice for fraud, harassment, defamation, political
            disinformation, or to defeat voice-based authentication or identity verification;
          </li>
          <li>
            clone allowances are metered by plan &mdash; one on Starter, up to three on Pro, up to
            ten per user on Teams &mdash; and you must not circumvent those limits;
          </li>
          <li>
            you are solely responsible for compliance with biometric, privacy, publicity and
            impersonation laws in your jurisdiction, including Illinois BIPA, Texas CUBI, GDPR
            Article 9 and India&rsquo;s DPDP Act.
          </li>
        </ul>
        <p>
          Breach of this section may result in immediate termination and deletion of your voice
          clones without notice.
        </p>
      </LegalSection>

      <LegalSection n="6" title="Subscriptions and In-App Purchases">
        <p>
          The App offers auto-renewing subscriptions and may offer consumable allowances
          (together, in-app purchases). All in-app purchases are processed by Apple or Google, not
          by {COMPANY}. Full pricing, renewal, cancellation and refund terms are set out in
          Sections 5 to 7 of our{" "}
          <a href="/terms" className="text-accent-deep underline underline-offset-4">
            Terms &amp; Conditions
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection n="7" title="Updates">
        <p>
          We may provide updates, patches and new versions of the App. This EULA governs any
          update unless that update is accompanied by its own licence terms. Some updates are
          required for continued operation, and features may be added, changed or removed over
          time.
        </p>
      </LegalSection>

      <LegalSection n="8" title="Third-Party Components and Services">
        <p>
          The App incorporates third-party open-source components, and transmits certain content
          to third-party processors to deliver features. Those processors are named in our
          Privacy Policy. Open-source components are licensed under their own terms, which
          prevail over this EULA to the extent of any conflict; a complete list of components and
          licences is available on request from support@ysnapai.com.
        </p>
      </LegalSection>

      <LegalSection n="9" title="Term and Termination">
        <p>
          This EULA takes effect when you install the App and continues until terminated. It
          terminates automatically if you breach any term. You may terminate at any time by
          deleting the App and closing your account. On termination the licence ends and you must
          stop using and delete all copies of the App. Sections 2, 3, 10, 11 and 14 survive
          termination.
        </p>
      </LegalSection>

      <LegalSection n="10" title="Disclaimer of Warranties">
        <p>
          To the maximum extent permitted by law, the App is provided &ldquo;as is&rdquo; and
          &ldquo;as available&rdquo; without warranty of any kind, express or implied, including
          implied warranties of merchantability, fitness for a particular purpose, accuracy and
          non-infringement.
        </p>
        <p>
          Translations, transcriptions and camera analyses are generated by artificial
          intelligence and may be inaccurate, incomplete or misleading. Do not rely on the App for
          medical, legal, financial, navigational or safety-critical decisions. Nothing in this
          section limits rights you have as a consumer under mandatory local law.
        </p>
      </LegalSection>

      <LegalSection n="11" title="Limitation of Liability">
        <p>
          To the maximum extent permitted by law, {COMPANY} will not be liable for any indirect,
          incidental, special, consequential, exemplary or punitive damages, or for loss of
          profits, revenue, data, goodwill or business, arising from or relating to the App.
        </p>
        <p>
          Our total aggregate liability arising from or relating to the App will not exceed the
          greater of the amount you paid us in the twelve months before the event giving rise to
          the claim, or <LegalTodo>[liability cap — pending, commonly USD 100]</LegalTodo>.
        </p>
        <p>
          Some jurisdictions do not allow the exclusion of certain warranties or limitation of
          certain damages, so some of the above may not apply to you.
        </p>
      </LegalSection>

      <LegalSection n="12" title="Apple App Store — Required Terms">
        <p className="mb-1">
          This section applies to the App licensed through the Apple App Store, and is required by
          Apple. In it, &ldquo;Application&rdquo; means the App.
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-ink">Acknowledgement.</strong> This EULA is concluded between
            you and {COMPANY} only, and not with Apple. {COMPANY}, not Apple, is solely
            responsible for the Application and its content.
          </li>
          <li>
            <strong className="text-ink">Scope of licence.</strong> The licence granted to you is
            limited to a non-transferable licence to use the Application on Apple-branded products
            you own or control, as permitted by the Usage Rules in the Apple Media Services Terms
            and Conditions.
          </li>
          <li>
            <strong className="text-ink">Maintenance and support.</strong> {COMPANY} is solely
            responsible for providing maintenance and support for the Application. Apple has no
            obligation whatsoever to furnish any maintenance or support services.
          </li>
          <li>
            <strong className="text-ink">Warranty.</strong> {COMPANY} is solely responsible for any
            product warranties, whether express or implied by law, to the extent not effectively
            disclaimed. If the Application fails to conform to any applicable warranty, you may
            notify Apple and Apple will refund the purchase price of the Application to you; to
            the maximum extent permitted by law, Apple will have no other warranty obligation
            whatsoever with respect to the Application.
          </li>
          <li>
            <strong className="text-ink">Product claims.</strong> {COMPANY}, not Apple, is
            responsible for addressing any claims relating to the Application or your possession
            and use of it, including product liability claims, any claim that the Application
            fails to conform to any applicable legal or regulatory requirement, and claims arising
            under consumer protection, privacy or similar legislation.
          </li>
          <li>
            <strong className="text-ink">Intellectual property claims.</strong> In the event of any
            third-party claim that the Application or your possession and use of it infringes that
            third party&rsquo;s intellectual property rights, {COMPANY}, not Apple, will be solely
            responsible for the investigation, defence, settlement and discharge of that claim.
          </li>
          <li>
            <strong className="text-ink">Legal compliance.</strong> You represent and warrant that
            you are not located in a country subject to a U.S. Government embargo or designated as
            a &ldquo;terrorist supporting&rdquo; country, and that you are not listed on any U.S.
            Government list of prohibited or restricted parties.
          </li>
          <li>
            <strong className="text-ink">Third-party terms.</strong> You must comply with
            applicable third-party terms of agreement when using the Application.
          </li>
          <li>
            <strong className="text-ink">Third-party beneficiary.</strong> You acknowledge and
            agree that Apple and Apple&rsquo;s subsidiaries are third-party beneficiaries of this
            EULA, and that upon your acceptance Apple will have the right (and will be deemed to
            have accepted the right) to enforce this EULA against you as a third-party beneficiary
            of it.
          </li>
          <li>
            <strong className="text-ink">Contact.</strong> Questions, complaints or claims
            regarding the Application should be directed to support@ysnapai.com.
          </li>
        </ul>
      </LegalSection>

      <LegalSection n="13" title="Google Play — Required Terms">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            This EULA is between you and {COMPANY} only, not Google. Google is not a party to this
            EULA and is not responsible for the App or its content.
          </li>
          <li>
            Your use of the App obtained through Google Play is also subject to the Google Play
            Terms of Service.
          </li>
          <li>
            Google has no obligation to provide maintenance or support for the App.
          </li>
          <li>
            {COMPANY}, not Google, is responsible for any claims relating to the App, including
            product liability, regulatory non-conformity, consumer protection and intellectual
            property claims.
          </li>
          <li>
            Refunds for purchases made through Google Play are governed by the Google Play refund
            policy, as described in Section 7 of our Terms &amp; Conditions.
          </li>
        </ul>
      </LegalSection>

      <LegalSection n="14" title="Governing Law">
        <p>
          This EULA is governed by the laws of India, without regard to conflict-of-law rules, and
          the courts of <LegalTodo>[city/state of registration — pending]</LegalTodo> will have
          exclusive jurisdiction, except that either party may seek injunctive relief in any
          competent court. If you are a consumer resident in the EU, the UK or another
          jurisdiction whose law grants you the protection of mandatory local consumer rules,
          nothing in this section deprives you of those protections or of the right to bring
          proceedings in your country of residence.
        </p>
      </LegalSection>

      <LegalSection n="15" title="Contact">
        <p>
          {COMPANY}, <LegalTodo>[registered address — pending]</LegalTodo> &mdash;
          support@ysnapai.com.
        </p>
      </LegalSection>

      <div className="rounded-panel border border-amber/30 bg-amber/5 p-5 text-sm text-ink-soft">
        <strong className="text-ink">Before publishing:</strong> the Apple terms in Section 12
        track Apple&rsquo;s Schedule 1 minimum requirements and should not be softened &mdash;
        omitting them is a common review rejection. Have counsel confirm Section 11&rsquo;s
        liability cap is enforceable under Indian law and against EU/UK consumers, and fill the
        three bracketed fields.
      </div>
    </LegalPage>
  );
}
