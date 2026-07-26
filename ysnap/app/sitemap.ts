import type { MetadataRoute } from "next";
import { site } from "@/lib/site";

// Required for `output: "export"` — emit sitemap.xml at build time as a static file.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: site.url,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
