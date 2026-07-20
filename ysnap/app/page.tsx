import Hero from "@/components/sections/hero";
import TrustedBy from "@/components/sections/trusted-by";
import ProductOverview from "@/components/sections/product-overview";
import Translation from "@/components/sections/translation";
import Transliteration from "@/components/sections/transliteration";
import VoiceAI from "@/components/sections/voice-ai";
import AICamera from "@/components/sections/ai-camera";
import CameraModes from "@/components/sections/camera-modes";
import LiveDemo from "@/components/sections/live-demo";
import Intelligence from "@/components/sections/intelligence";
import HowItWorks from "@/components/sections/how-it-works";
import Privacy from "@/components/sections/privacy";
import PerformanceStats from "@/components/sections/performance-stats";
import Testimonials from "@/components/sections/testimonials";
import Pricing from "@/components/sections/pricing";
import FAQ from "@/components/sections/faq";
import DownloadCTA from "@/components/sections/download-cta";
import WaveDivider from "@/components/ui/wave-divider";

/**
 * The YSNAP story, in order: hook → proof → depth → interaction → trust → conversion.
 * Each section is self-contained; rhythm comes from alternating canvas/surface tones.
 */
export default function Home() {
  return (
    <>
      <Hero />
      <TrustedBy />
      <ProductOverview />
      <Translation />
      <Transliteration />
      <WaveDivider />
      <VoiceAI />
      <AICamera />
      <CameraModes />
      <LiveDemo />
      <WaveDivider flip />
      <Intelligence />
      <HowItWorks />
      <Privacy />
      <PerformanceStats />
      <Testimonials />
      <Pricing />
      <FAQ />
      <DownloadCTA />
    </>
  );
}
