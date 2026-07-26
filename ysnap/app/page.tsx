import Hero from "@/components/sections/hero";
import TrustedBy from "@/components/sections/trusted-by";
import ProductOverview from "@/components/sections/product-overview";
import Translation from "@/components/sections/translation";
import Transliteration from "@/components/sections/transliteration";
import VoiceAI from "@/components/sections/voice-ai";
import AICamera from "@/components/sections/ai-camera";
import LiveDemo from "@/components/sections/live-demo";
import Intelligence from "@/components/sections/intelligence";
import Privacy from "@/components/sections/privacy";
import PerformanceStats from "@/components/sections/performance-stats";
import Testimonials from "@/components/sections/testimonials";
import Pricing from "@/components/sections/pricing";
import FAQ from "@/components/sections/faq";
import DownloadCTA from "@/components/sections/download-cta";
import WaveDivider from "@/components/ui/wave-divider";

/**
 * The YSNAP story, in order: hook → proof → depth → trust → interaction → conversion.
 * Each section is self-contained; rhythm comes from alternating canvas/surface tones.
 *
 * Phone placement drives this order as much as the narrative does. Four sections
 * render a device (Translation, AI Camera, Live Demo, Download) and two of them —
 * AI Camera and Live Demo — are both camera stories with near-identical headings,
 * so back to back they read as one long repeated section. Live Demo therefore sits
 * down by Pricing instead: it separates the two camera blocks at every breakpoint
 * and turns the demo into a try-it-before-you-buy beat right before the plans.
 *
 * Mobile trims the deep-dive sections (`hidden md:block`). The full narrative
 * runs several screens longer on a phone than on desktop — every grid collapses
 * to one column — so on small screens we keep the spine (what it is, see it
 * work, why trust it, what it costs) and drop the supporting detail. The
 * markup is still rendered for crawlers and deep links; only display changes.
 */
export default function Home() {
  return (
    <>
      <Hero />
      <TrustedBy />
      <ProductOverview />
      <Translation />
      {/* Divider and the section it separates travel together: Transliteration
          is the only surface band in this stretch, so with it hidden the
          divider would sit between two identical canvas tones with nothing
          to divide. */}
      <div className="hidden md:block">
        <Transliteration />
        <WaveDivider />
      </div>
      <VoiceAI />
      <AICamera />
      {/* Privacy directly after the camera is deliberate: having just watched it
          read a plate of food or a medical label, "your photos never leave the
          device" is the reassurance a visitor is already reaching for. It also
          keeps a phone-free section between the two camera blocks on mobile,
          where everything below is hidden. */}
      <Privacy />
      <div className="hidden md:block">
        <Intelligence />
      </div>
      <div className="hidden md:block">
        <Testimonials />
      </div>
      <div className="hidden md:block">
        <PerformanceStats />
      </div>
      {/* Outside the md-only blocks on purpose — on a phone this is the only
          thing standing between Privacy and Live Demo, which share the canvas
          tone and would otherwise butt together with no visible seam. */}
      <WaveDivider flip />
      <LiveDemo />
      <Pricing />
      <FAQ />
      <DownloadCTA />
    </>
  );
}
