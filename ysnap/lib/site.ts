/** Central site configuration — single source of truth for nav, links and copy constants. */

export const site = {
  name: "YSNAP",
  tagline: "One AI. Every Language. Every Vision.",
  description:
    "YSNAP combines AI Translation, Voice Intelligence, Computer Vision and AI Recognition into one beautifully designed experience.",
  url: "https://ysnapai.com",
  appStoreUrl: "#download",
  googlePlayUrl: "#download",
} as const;

export const navLinks = [
  { label: "Features", href: "#overview" },
  { label: "Translation", href: "#translation" },
  { label: "Voice AI", href: "#voice" },
  { label: "AI Camera", href: "#camera" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
] as const;

export const footerColumns = [
  {
    title: "Product",
    links: [
      { label: "AI Translation", href: "#translation" },
      { label: "Transliteration", href: "#transliteration" },
      { label: "Voice AI", href: "#voice" },
      { label: "AI Camera", href: "#camera" },
      { label: "Live Demo", href: "#demo" },
      { label: "Pricing", href: "#pricing" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "#" },
      { label: "Careers", href: "#" },
      { label: "Press", href: "#" },
      { label: "Contact", href: "#" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Help Center", href: "#faq" },
      { label: "Language Support", href: "#translation" },
      { label: "API", href: "#" },
      { label: "Status", href: "#" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy Policy", href: "/privacy-policy" },
      { label: "Terms & Conditions", href: "/terms" },
      { label: "EULA", href: "/eula" },
      { label: "Security", href: "#privacy" },
    ],
  },
] as const;
