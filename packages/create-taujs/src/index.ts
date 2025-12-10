#!/usr/bin/env node

import { execSync } from "child_process";
import fs from "fs-extra";
import path from "path";
import pc from "picocolors";
import prompts from "prompts";

type ProjectConfig = {
  projectName: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  installDeps: boolean;
};

const PACKAGE_MANAGERS = {
  npm: "npm install",
  pnpm: "pnpm install",
  yarn: "yarn",
  bun: "bun install",
} as const;

function parseArgs(): { projectName?: string } {
  const rawArgs = process.argv.slice(2);
  let projectName: string | undefined;

  for (const arg of rawArgs) {
    if (!arg.startsWith("-") && !projectName) {
      projectName = arg;
      continue;
    }
  }

  return { projectName };
}

async function main() {
  console.log(pc.cyan("\nWelcome to τjs (taujs)\n"));

  const { projectName: argName } = parseArgs();

  const questions: prompts.PromptObject[] = [
    {
      type: argName ? null : "text",
      name: "projectName",
      message: "Project name:",
      initial: "my-taujs-app",
      validate: (value: string) => {
        if (!value) return "Project name is required";
        if (!/^[a-z0-9-_]+$/.test(value)) {
          return "Project name can only contain lowercase letters, numbers, hyphens, and underscores";
        }
        return true;
      },
    },
    {
      type: "select",
      name: "packageManager",
      message: "Package manager:",
      choices: [
        { title: "npm", value: "npm" },
        { title: "pnpm", value: "pnpm" },
        { title: "yarn", value: "yarn" },
        { title: "bun", value: "bun" },
      ],
      initial: 0,
    },
    {
      type: "confirm",
      name: "installDeps",
      message: "Install dependencies now?",
      initial: true,
    },
  ];

  const answers = await prompts(questions, {
    onCancel: () => {
      console.log(pc.red("\n✖ Operation cancelled"));
      process.exit(1);
    },
  });

  const config: ProjectConfig = {
    projectName: argName || answers.projectName,
    packageManager: answers.packageManager,
    installDeps: answers.installDeps,
  };

  await createProject(config);
}

async function createProject(config: ProjectConfig) {
  const { projectName, packageManager, installDeps } = config;
  const targetDir = path.resolve(process.cwd(), projectName);

  if (fs.existsSync(targetDir)) {
    console.log(pc.red(`\n✖ Directory ${projectName} already exists`));
    process.exit(1);
  }

  console.log(pc.cyan(`\nCreating project in ${pc.bold(targetDir)}...\n`));

  await fs.ensureDir(targetDir);
  await createDirectoryStructure(targetDir);
  await generateFiles(targetDir, config);

  console.log(pc.green("Project files created"));

  if (installDeps) {
    console.log(
      pc.cyan(`\nInstalling dependencies with ${packageManager}...\n`)
    );
    try {
      execSync(PACKAGE_MANAGERS[packageManager], {
        cwd: targetDir,
        stdio: "inherit",
      });
      console.log(pc.green("\nDependencies installed"));
    } catch (error) {
      console.log(
        pc.yellow(
          "\n⚠ Failed to install dependencies. You can install them manually."
        )
      );
    }
  }

  console.log(
    pc.green(`\n✓ Project ${pc.bold(projectName)} created successfully!\n`)
  );
  console.log(pc.cyan("Next steps:\n"));
  console.log(`  cd ${projectName}`);
  if (!installDeps) {
    console.log(`  ${PACKAGE_MANAGERS[packageManager]}`);
  }
  console.log(`  ${packageManager} run dev\n`);
  console.log(pc.dim("Documentation: https://taujs.dev\n"));
}

async function createDirectoryStructure(targetDir: string) {
  const dirs: string[] = [
    "src/server/services",
    "src/client",
    "src/client/public",
  ];

  for (const dir of dirs) {
    await fs.ensureDir(path.join(targetDir, dir));
  }
}

async function generateFiles(targetDir: string, config: ProjectConfig) {
  const { projectName, packageManager } = config;

  await fs.writeJSON(
    path.join(targetDir, "package.json"),
    generatePackageJson(projectName, packageManager),
    { spaces: 2 }
  );

  await fs.writeFile(path.join(targetDir, "build.ts"), generateBuildTs());

  await fs.writeJSON(
    path.join(targetDir, "tsconfig.json"),
    generateTsConfig(),
    { spaces: 2 }
  );

  await fs.writeJSON(
    path.join(targetDir, "src/server/tsconfig.json"),
    generateServerTsConfig(),
    { spaces: 2 }
  );

  await fs.writeFile(
    path.join(targetDir, "taujs.config.ts"),
    generateTaujsConfig()
  );

  await fs.writeFile(path.join(targetDir, ".gitignore"), generateGitignore());

  await fs.writeFile(
    path.join(targetDir, "README.md"),
    generateReadme(projectName, packageManager)
  );

  await fs.writeFile(
    path.join(targetDir, "src/client/index.html"),
    generateIndexHtml("τjs - Composing systems, not just apps")
  );
  await fs.writeFile(
    path.join(targetDir, "src/client/App.tsx"),
    generateAppComponent()
  );
  await fs.writeFile(
    path.join(targetDir, "src/client/entry-client.tsx"),
    generateEntryClient()
  );
  await fs.writeFile(
    path.join(targetDir, "src/client/entry-server.tsx"),
    generateEntryServer()
  );
  await fs.writeFile(
    path.join(targetDir, "src/client/styles.css"),
    generateStyles()
  );
  await fs.writeFile(
    path.join(targetDir, "src/client/vite-env.d.ts"),
    generateViteEnv()
  );

  // server
  await fs.writeFile(
    path.join(targetDir, "src/server/index.ts"),
    generateServerIndex()
  );
  await fs.writeFile(
    path.join(targetDir, "src/server/services/registry.ts"),
    generateServiceRegistry()
  );
  await fs.writeFile(
    path.join(targetDir, "src/server/services/example.service.ts"),
    generateExampleService()
  );
  await fs.writeFile(
    path.join(targetDir, "src/server/types.d.ts"),
    generateServiceTypesAugmentation()
  );

  await fs.writeFile(
    path.join(targetDir, "src/client/public/favicon.svg"),
    generateFavicon()
  );
}

function generatePackageJson(projectName: string, packageManager: string) {
  return {
    name: projectName,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "NODE_ENV=development tsx watch --ignore vite.config.ts --trace-warnings --tsconfig ./src/server/tsconfig.json ./src/server/index.ts --loglevel verbose",
      "build:client": "tsx build.ts",
      "build:entry-server": "BUILD_MODE=ssr tsx build.ts",
      "build:server":
        "esbuild src/server/index.ts --bundle --platform=node --format=esm --outfile=dist/server/index.js --external:fastify --external:@taujs/server --external:@taujs/react",
      build:
        "npm run build:client && npm run build:entry-server && npm run build:server",
      start: "NODE_ENV=production node dist/server/index.js",
      lint: "tsc --noEmit",
    },
    dependencies: {
      "@taujs/react": "latest",
      "@taujs/server": "latest",
      fastify: "^5.6.1",
      react: "^19.0.0",
      "react-dom": "^19.0.0",
    },
    devDependencies: {
      "@types/node": "^22.10.5",
      "@types/react": "^19.0.2",
      "@types/react-dom": "^19.0.2",
      "@vitejs/plugin-react": "^4.6.0",
      tsx: "^4.19.3",
      typescript: "^5.7.3",
      vite: "^7.1.11",
    },
  };
}

function generateBuildTs() {
  return `import path from "node:path";
import { fileURLToPath } from "node:url";

import { taujsBuild } from "@taujs/server";

import config from "./taujs.config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await taujsBuild({
  clientBaseDir: path.resolve(__dirname, "src/client"),
  config,
  projectRoot: __dirname,
  mode: process.env.BUILD_MODE === 'ssr' ? 'ssr' : 'client',
});
`;
}

function generateTsConfig() {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      jsx: "react-jsx",
      moduleResolution: "bundler",
      resolveJsonModule: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      isolatedModules: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      strict: true,
      skipLibCheck: true,
      types: [],
      paths: {
        "@client/*": ["./src/client/*"],
        "@server/*": ["./src/server/*"],
      },
    },
    include: ["src/client/**/*", "src/server/**/*", "taujs.config.ts"],
  };
}

function generateServerTsConfig() {
  return {
    extends: "../../tsconfig.json",
    include: ["./**/*"],
  };
}

function generateTaujsConfig() {
  return `import { defineConfig } from '@taujs/server/config';

export default defineConfig({
  server: {
    port: 5173,
    host: 'localhost',
    hmrPort: 5174,
  },
  apps: [
    {
      appId: 'main',
      entryPoint: '',
      routes: [
        {
          path: '/',
          attr: {
            render: 'ssr',
            hydrate: true,
            // Direct service invocation: standard SSR
            data: async (params, ctx) => {
              return ctx.call('example', 'greet', { name: 'SSR' });
            },
          },
        },
        {
          path: '/streaming',
          attr: {
            render: 'streaming',
            hydrate: true,
            // Descriptor-based data: resolved by the server
            data: async (params) => ({
              args: { name: 'Streaming' },
              serviceName: 'example',
              serviceMethod: 'greet',
            }),
            // meta recommended for streaming routes for SEO/social and render timing
            meta: {
              title: 'τjs [taujs] - streaming',
              description: 'Streaming page description from route meta',
            },
          },
        },
      ],
    },
  ],
});
`;
}

function generateGitignore() {
  return `# Dependencies
node_modules
.pnp
.pnp.js

# Production
dist
build

# Environment
.env
.env.local
.env.*.local

# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# Editor
.vscode
.idea
*.swp
*.swo
*~

# OS
.DS_Store
Thumbs.db

# Testing
coverage

# Misc
.cache
`;
}

function generateReadme(projectName: string, packageManager: string) {
  const pmRun = packageManager === "npm" ? "npm run" : packageManager;
  return `# ${projectName}

A τjs (taujs) application with server-side rendering, streaming, and a type-safe service layer.

## Getting Started

### Development

\`\`\`bash
${pmRun} dev
\`\`\`

Visit [http://localhost:5173](http://localhost:5173)

### Build for Production

\`\`\`bash
${pmRun} build
\`\`\`

### Start Production Server

\`\`\`bash
${pmRun} start
\`\`\`

## Project Structure

\`\`\`
${projectName}/
├── src/
│   ├── client/              
│   │   ├── App.tsx             # Root component
│   │   ├── entry-client.tsx    # Client hydration entry
│   │   ├── entry-server.tsx    # SSR render entry
│   │   ├── styles.css          # Global styles
│   │   ├── vite-env.d.ts       # Vite client types
│   │   └── public/
│   │       └── favicon.svg     # App icon
│   └── server/              
│       ├── index.ts                # Server entry point
│       ├── tsconfig.json          # Server-only TS config (used by tsx watch)
│       ├── types.d.ts          # ServiceContext augmentation
│       └── services/
│           ├── registry.ts         # Service registry
│           └── example.service.ts  # Example service
├── build.ts                     # Production build entry point
├── taujs.config.ts              # τjs configuration
└── package.json
\`\`\`

## Editing the App

- Main UI: \`src/client/App.tsx\`
- Styles: \`src/client/styles.css\`
- SSR entry: \`src/client/entry-server.tsx\`
- Client entry: \`src/client/entry-client.tsx\`
- Routes: \`taujs.config.ts\`
- Services: \`src/server/services/\`

## Documentation

- [τjs Documentation](https://taujs.dev)
- [Fastify Documentation](https://fastify.dev)
- [React Documentation](https://react.dev)

## License

MIT
`;
}

function generateIndexHtml(title: string) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="stylesheet" href="/styles.css" />
    <!--ssr-head-->
    <title>${title}</title>
  </head>
  <body>
    <main id="root"><!--ssr-html--></main>
  </body>
</html>
`;
}

function generateAppComponent() {
  return `import { Suspense } from 'react';
import { useSSRStore } from '@taujs/react';

type GreetingData = {
  message: string;
  timestamp: string;
};

function GreetingCard() {
  const data = useSSRStore<GreetingData>();

  return (
    <section className="card card--primary">
      <p className="card-message">{data.message}</p>
      <p className="card-meta">
        Generated at: {new Date(data.timestamp).toLocaleString()}
      </p>
    </section>
  );
}

export function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">τjs - Composing systems, not just apps</h1>
        <p className="app-subtitle">
          Server-first application composition with explicit per-route rendering control.
        </p>
      </header>

      <Suspense
        fallback={
          <section className="card card--primary">
            <p className="card-message">Loading greeting…</p>
            <p className="card-meta">Streaming data from the server.</p>
          </section>
        }
      >
        <GreetingCard />
      </Suspense>

      <section className="section">
        <h2 className="section-title">Quick start</h2>
        <ul className="list">
          <li>Edit <code>src/client/App.tsx</code> to change this page.</li>
          <li>Adjust styles in <code>src/client/styles.css</code>.</li>
          <li>Configure routes in <code>taujs.config.ts</code>.</li>
          <li>
            Visit <a href="/">/</a> for standard SSR and{" "}
            <a href="/streaming">/streaming</a> for streaming SSR.
          </li>
          <li>Further information can be found at <a href="http://taujs.dev" target="_blank">τjs Documentation and Guides</a>.</li>
        </ul>
      </section>

      <section className="tip">
        <p>
          <strong>SSR:</strong> The <code>/</code> route resolves all data on the server
          before sending HTML. You get a complete, fully rendered document on first byte,
          which is ideal for predictable latency and caching.
        </p>
        <p>
          <strong>STREAM:</strong> The <code>/streaming</code> route uses a service descriptor
          and returns a Promise. The <code>&lt;Suspense&gt;</code> boundary above shows
          a fallback while the server resolves it, then progressively streams the final content.
        </p>
      </section>

      <footer className="app-footer">
        <p>
          Built with{" "}
          <a href="https://taujs.dev" target="_blank" rel="noopener">
            τjs
          </a>
          {" · "}
          <a href="https://fastify.dev" target="_blank" rel="noopener">
            Fastify
          </a>
          {" · "}
          <a href="https://react.dev" target="_blank" rel="noopener">
            React
          </a>
        </p>
      </footer>
    </div>
  );
}
`;
}

function generateStyles() {
  return `:root {
  --accent: #38bdf8;
  --accent-soft: #0ea5e9;
  --accent-soft-bg: #0b1120;
  --bg: #020617;
  --bg-dark: #000; 
  --bg-elevated: #020617;
  --border-subtle: #1e293b;
  --color-accent-rgb: 56, 189, 248; /* #38bdf8 */
  --color-app-title-rgb: 229, 231, 235; /* #e5e7eb */
  --color-border-subtle-rgb: 30, 41, 59; /* #1e293b */
  --color-code-border-rgb: 51, 65, 85; /* rgba(51, 65, 85, 0.9) */
  --color-code-bg-rgb: 15, 23, 42; /* rgba(15, 23, 42, 0.9) */
  --color-tip-border-rgb: 148, 163, 184; /* rgba(148, 163, 184, 0.9) */
  --color-tip-bg-rgb: 15, 23, 42; /* rgba(15, 23, 42, 0.95) */
  --color-footer-border-rgb: 30, 64, 175; /* rgba(30, 64, 175, 0.7) */
  --radius-lg: 12px;
  --radius-xl: 16px;
  --shadow-soft: 0 18px 45px rgba(15, 23, 42, 0.7);
  --text: #f9fafb;
  --text-muted: #cbd5f5;
  --text-soft: #9ca3af;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  min-height: 100%;
  padding: 0;
}

body {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text",
    "Segoe UI", sans-serif;
  background: radial-gradient(
    circle at top left,
    var(--border-subtle) 0,
    var(--bg) 38%,
    var(--bg-dark) 85%
  );
  color: var(--text);
}

a {
  color: var(--accent);
  text-decoration: none;
}

a:hover,
a:focus-visible {
  text-decoration: underline;
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New", monospace;
  font-size: 0.9em;
  padding: 0.15rem 0.35rem;
  border-radius: 4px;
  background: rgba(var(--color-code-bg-rgb), 0.9);
  border: 1px solid rgba(var(--color-code-border-rgb), 0.9);
}

.app {
  margin: 0 auto;
  max-width: 960px;
  padding: 3rem 1.5rem 4rem;
}

@media (min-width: 768px) {
  .app {
    padding: 4rem 2rem 5rem;
  }
}

.app-header {
  margin-bottom: 2.5rem;
}

.app-title {
  color: rgb(var(--color-app-title-rgb));
  font-size: clamp(2rem, 2.7vw + 1.5rem, 2.8rem);
  letter-spacing: -0.04em;
  margin: 0;
  padding: 0 0 0 60px;
  position: relative;
}

.app-title::before {
  background: url("favicon.svg") no-repeat;
  background-size: 50px 50px;
  content: "";
  border-radius: 4px;
  display: block;
  height: 50px;
  left: 0;
  position: absolute;
  top: 0;
  width: 50px;
}

.app-subtitle {
  color: var(--text-soft);
  font-size: 0.95rem;
  margin: 0.8rem 0 0;
}

.card {
  background: radial-gradient(
    circle at top left,
    var(--accent-soft-bg) 0,
    var(--bg) 45%
  );
  border: 1px solid rgba(var(--color-accent-rgb), 0.7);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-soft);
  overflow: hidden;
  padding: 1.75rem 1.5rem;
  position: relative;
}

.card::before {
  content: "";
  position: absolute;
  inset: -40%;
  background:
    radial-gradient(
      circle at 0 0,
      rgba(var(--color-accent-rgb), 0.16),
      transparent 60%
    ),
    radial-gradient(
      circle at 100% 0,
      rgba(59, 130, 246, 0.2),
      transparent 65%
    );
  opacity: 0.9;
  pointer-events: none;
}

.card > * {
  position: relative;
}

.card-message {
  color: var(--text); 
  font-size: 1.25rem;
  margin: 0;
}

.card-meta {
  color: var(--text-soft);
  font-size: 0.85rem;
  margin: 0.6rem 0 0;
}

.section {
  background: rgba(var(--color-code-bg-rgb), 0.9);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  margin-top: 2rem;
  padding: 1.6rem 1.5rem;
}

.section-title {
  color: rgb(var(--color-app-title-rgb));
  font-size: 1.1rem;
  margin: 0 0 0.75rem;
}

.list {
  color: var(--text-muted);
  font-size: 0.95rem;
  line-height: 1.8;
  margin: 0;
  padding-left: 1.1rem;
}

.tip {
  background: rgba(var(--color-tip-bg-rgb), 0.95);
  border: 1px solid rgba(var(--color-tip-border-rgb), 0.9);
  border-radius: 10px;
  color: var(--text);
  font-size: 0.9rem;
  line-height: 1.6;
  margin-top: 1.6rem;
  padding: 1.1rem 1.3rem 1.25rem;
}

.tip p {
  margin: 0 0 0.6rem;
}

.tip p:last-child {
  margin-bottom: 0;
}

.app-footer {
  border-top: 1px solid rgba(var(--color-footer-border-rgb), 0.7);
  color: var(--text-soft);
  font-size: 0.85rem;
  margin-top: 3rem;
  padding-top: 1.4rem;
  text-align: center;
}`;
}

function generateViteEnv() {
  return `/// <reference types="vite/client" />
`;
}

function generateEntryClient() {
  return `import { hydrateApp } from '@taujs/react';
import { App } from './App';

hydrateApp({
  appComponent: <App />,
  rootElementId: 'root',
  enableDebug: import.meta.env.DEV,
});
`;
}

function generateEntryServer() {
  return `import { createRenderer } from '@taujs/react';
import { App } from './App';

export const { renderSSR, renderStream } = createRenderer({
  appComponent: () => <App />,
  headContent: ({ data }) => \`
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="A τjs template application">
    <title>\${data?.message || "τjs - Composing systems, not just apps"}</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml"/>
  \`,
  enableDebug: process.env.NODE_ENV === "development",
});
`;
}

function generateServerIndex() {
  return `import { createServer } from '@taujs/server';
import config from '../../taujs.config.ts';
import { serviceRegistry } from './services/registry.ts';

const { app, net } = await createServer({
  config,
  serviceRegistry,
  clientRoot: './src/client',
  debug: !!process.env.DEBUG,
});

if (app) {
  await app.listen({
    host: net.host,
    port: net.port,
  });
}
`;
}

function generateServiceRegistry() {
  return `import { defineServiceRegistry } from '@taujs/server/config';
import { exampleService } from './example.service.ts';

export const serviceRegistry = defineServiceRegistry({
  example: exampleService,
});

export type ServiceRegistry = typeof serviceRegistry;
`;
}

function generateServiceTypesAugmentation() {
  return `import type { RegistryCaller } from '@taujs/server/config';
import type { serviceRegistry } from './registry';

declare module '@taujs/server/config' {
  interface ServiceContext {
    call: RegistryCaller<typeof serviceRegistry>;
  }
}
`;
}

function generateExampleService() {
  return `import { defineService } from '@taujs/server/config';

export const exampleService = defineService({
  async greet(params: { name: string }) {
    // Simulate async operation
    await new Promise((resolve) => setTimeout(resolve, 750));

    const modeDescription =
      params.name === 'Streaming'
        ? 'via service descriptors.'
        : 'via direct ctx.call.';

    return {
      message: \`Hello, \${params.name}. Response provided by a τjs service \${modeDescription}\`,
      timestamp: new Date().toISOString(),
    };
  },

  async getData(params: { id: string }) {
    return {
      id: params.id,
      data: 'Example data from service',
      timestamp: new Date().toISOString(),
    };
  },
});
`;
}

function generateFavicon() {
  return `<svg viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg">
  <g transform="matrix(1.203376054763794, 0, 0, 1.203376054763794, -47.249202728271484, -58.526153564453125)">
    <ellipse style="stroke: rgb(0, 0, 0); fill: rgb(255, 250, 250);" cx="245.728" cy="256.598" rx="171.553" ry="171.553"/>
    <path d="M 221.7 53.324 C 210 55.024 199.4 57.324 186.1 61.424 C 157.3 70.124 136.8 80.824 114.2 99.024 C 41.1 157.824 18.8 260.524 60.7 345.424 C 67.2 358.624 83.7 382.824 94.7 395.124 C 107.2 409.224 129.3 426.424 147.7 436.424 C 162.7 444.624 187.8 453.624 205.9 457.324 C 226.8 461.624 261.4 461.824 282.7 457.824 C 315.4 451.624 353.3 434.324 375.7 415.424 C 385.3 407.424 399.8 392.224 403.3 386.724 C 404.3 385.124 406.7 381.924 408.7 379.724 C 415.4 371.824 418.7 367.524 419.9 364.624 C 420.6 363.124 422.8 359.324 424.8 356.324 C 428.3 351.024 436.7 333.524 438.2 328.324 C 438.6 326.924 440 323.924 441.3 321.724 C 444.5 316.324 450.2 291.424 451.7 276.824 C 453.4 260.624 452.5 231.724 449.9 218.824 C 444.9 194.024 436.6 172.424 424.6 152.524 C 408 125.224 387.6 103.924 361.5 86.424 C 339.6 71.824 308.9 59.824 280.2 54.724 C 270.6 52.924 231 52.024 221.7 53.324 Z M 271.2 98.324 C 296.7 101.824 323.2 112.324 344.2 127.124 C 352.8 133.224 374.6 154.424 381.4 163.324 C 391 175.924 400.4 197.524 406.4 220.824 C 410.1 235.624 410.2 236.124 410.2 254.324 C 410.1 275.524 408.6 285.624 403.1 302.324 C 392.6 333.724 374.7 359.324 347.2 382.124 C 326.6 399.124 295.4 412.124 266.7 415.524 C 255.1 416.824 229.3 416.024 217.8 413.924 C 179.9 406.924 146.7 388.924 123.2 362.524 C 103.1 339.924 89.2 312.024 83.6 283.024 C 78.9 259.124 81.6 227.024 90.2 202.024 C 92.7 195.024 95.3 188.324 96.1 187.024 C 97 185.824 98.3 182.924 99.1 180.724 C 102.8 170.224 122.6 145.824 135.2 136.424 C 153.1 123.024 158.5 119.524 169.2 114.324 C 190.2 104.124 207.1 99.424 230.7 97.324 C 241.7 96.324 259.7 96.824 271.2 98.324 Z"/>
    <path d="M 278.7 156.424 C 256.4 156.724 222.2 156.824 202.7 156.524 C 160.8 155.924 164.4 155.024 149.6 169.424 C 138.6 180.324 125.7 197.124 125.7 200.824 C 125.7 201.124 148 201.224 175.2 201.124 L 224.7 200.824 L 224.4 292.824 L 224.2 384.724 L 237.2 385.124 C 244.4 385.324 253.9 385.224 258.5 384.824 L 266.7 384.124 L 266.7 292.424 L 266.7 200.724 L 316.2 200.824 C 373.4 200.824 367.8 202.424 359.5 188.324 C 351.3 174.424 343.7 164.524 338.8 161.324 C 333.8 157.924 325.7 155.224 321.8 155.524 C 320.4 155.624 301 156.024 278.7 156.424 Z"/>
    <path d="M 113.7 249.324 C 113.7 256.724 113.4 267.124 113.1 272.324 L 112.4 281.824 L 131.5 281.524 L 150.5 281.224 L 151.2 287.424 C 151.9 293.624 151.1 334.524 150.1 339.524 C 149.4 343.124 154.1 348.224 166.6 357.624 C 175.8 364.524 190.4 373.324 192.7 373.324 C 193.5 373.324 193.7 354.224 193.5 304.824 L 193.2 236.324 L 153.4 236.024 L 113.7 235.824 L 113.7 249.324 Z"/>
    <path d="M 298.2 281.224 C 298.2 347.124 298.6 373.324 299.6 373.324 C 300.8 373.324 317.1 363.324 322.3 359.324 C 324.8 357.424 330 352.824 333.8 349.124 L 340.8 342.324 L 340.7 337.124 C 340.6 334.224 340.6 320.424 340.6 306.524 L 340.7 281.324 L 359.7 281.324 L 378.7 281.324 L 378.6 260.024 C 378.6 248.424 378.3 238.124 377.9 237.324 C 377.3 236.024 371.8 235.824 337.7 235.724 L 298.2 235.624 L 298.2 281.224 Z"/>
  </g>
</svg>
`;
}

main().catch((error) => {
  console.error(pc.red("\n✖ Error creating project:"), error);
  process.exit(1);
});
