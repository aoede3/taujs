import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  site: "https://taujs.dev",
  integrations: [
    starlight({
      title: "τjs",

      components: {
        Footer: "./src/components/CustomFooter.astro",
        SiteTitle: "./src/components/ResponsiveSiteTitle.astro",
      },

      customCss: ["./src/styles/custom.css"],

      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/aoede3/taujs",
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Overview", slug: "guides/getting-started" },
            { label: "Architecture", slug: "guides/architecture" },
            {
              label: "Request Contracts & Data",
              slug: "guides/request-contracts",
            },
            {
              label: "Incremental Migration",
              slug: "guides/incremental-migration",
            },
          ],
        },
        {
          label: "Core Features",
          items: [
            { label: "Data Loading", slug: "guides/data-loading" },
            { label: "Services", slug: "guides/services" },
            { label: "<head> Management", slug: "guides/head-management" },
          ],
        },
        {
          label: "Security",
          items: [
            { label: "Authentication", slug: "guides/authentication" },
            {
              label: "Content Security Policy",
              slug: "guides/content-security-policy",
            },
          ],
        },

        {
          label: "Multi-App Architecture",
          items: [
            { label: "Micro-Frontends", slug: "guides/micro-frontend" },
            { label: "App Shell Pattern", slug: "guides/app-shell-pattern" },
            {
              label: "Dependency Management",
              slug: "guides/dependency-management",
            },
            {
              label: "Shared State Management",
              slug: "guides/shared-state-management",
            },
          ],
        },
        {
          label: "Hosting & Operations",
          items: [
            { label: "Host Ownership", slug: "guides/host-ownership" },
            { label: "Build & Deployment", slug: "guides/build-deployment" },
            { label: "Static Assets", slug: "guides/static-assets" },
            { label: "Logging & Telemetry", slug: "guides/logging-telemetry" },
            {
              label: "Combining HMR with Another Consumer",
              slug: "guides/hmr-cohabitation",
            },
            {
              label: "@fastify/websocket Interoperability",
              slug: "guides/fastify-websocket-hmr",
            },
          ],
        },

        {
          label: "Renderers",
          items: [
            { label: "React", slug: "renderers/react" },
            { label: "Solid", slug: "renderers/solid" },
            { label: "Vue", slug: "renderers/vue" },
          ],
        },

        {
          label: "Reference",
          items: [
            { label: "τjs Configuration", slug: "reference/taujs-config" },
            { label: "MCP Server", slug: "reference/mcp" },
            // { label: "Platformatic Watt", slug: "reference/platformatic-watt" },
          ],
        },
      ],
    }),
  ],
});
