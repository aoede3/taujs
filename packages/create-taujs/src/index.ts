#!/usr/bin/env node

import { execSync } from 'child_process';
import { pathToFileURL } from 'node:url';
import fs from 'fs-extra';
import path from 'path';
import pc from 'picocolors';
import prompts from 'prompts';

import { generateClaudeMd, generateMcpJson } from './mcp';

export type Framework = 'react' | 'vue' | 'solid' | 'html';

export type ProjectConfig = {
  projectName: string;
  packageManager: 'npm' | 'pnpm' | 'yarn';
  installDeps: boolean;
  framework: Framework;
};

const PACKAGE_MANAGERS = {
  npm: 'npm install',
  pnpm: 'pnpm install',
  yarn: 'yarn install',
} as const;

export const FRAMEWORKS: readonly Framework[] = ['react', 'vue', 'solid', 'html'];

/** Derived from the existing install-command map, so the two can never disagree. */
export type PackageManager = keyof typeof PACKAGE_MANAGERS;
const PACKAGE_MANAGER_NAMES = Object.keys(PACKAGE_MANAGERS) as PackageManager[];

/**
 * The non-interactive interface, frozen:
 *
 *   create-taujs my-app --framework solid --package-manager pnpm --no-install
 *
 * Supply all four and the CLI never needs a TTY, so CI, scripts and coding agents can drive it.
 * OMITTED options keep today's prompts, and an explicit option suppresses ONLY its own prompt -
 * interactive DX is unchanged.
 *
 * There is deliberately no `--yes`: its defaults, and in particular whether it would install from
 * the network, would be ambiguous. Each choice is stated explicitly instead.
 */
type ParsedArgs = {
  projectName?: string;
  framework?: string;
  packageManager?: string;
  install?: boolean;
  /** Both `--install` and `--no-install` were passed - rejected before anything is created. */
  installConflict: boolean;
};

function parseArgs(): ParsedArgs {
  const rawArgs = process.argv.slice(2);
  let projectName: string | undefined;
  let framework: string | undefined;
  let packageManager: string | undefined;
  let sawInstall = false;
  let sawNoInstall = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === '--framework') {
      framework = rawArgs[++i];
      continue;
    }
    if (arg.startsWith('--framework=')) {
      framework = arg.slice('--framework='.length);
      continue;
    }
    if (arg === '--package-manager') {
      packageManager = rawArgs[++i];
      continue;
    }
    if (arg.startsWith('--package-manager=')) {
      packageManager = arg.slice('--package-manager='.length);
      continue;
    }
    if (arg === '--install') {
      sawInstall = true;
      continue;
    }
    if (arg === '--no-install') {
      sawNoInstall = true;
      continue;
    }
    if (!arg.startsWith('-') && !projectName) {
      projectName = arg;
      continue;
    }
  }

  return {
    projectName,
    framework,
    packageManager,
    install: sawInstall && !sawNoInstall ? true : sawNoInstall && !sawInstall ? false : undefined,
    installConflict: sawInstall && sawNoInstall,
  };
}

function validatePackageManager(value: string): true | string {
  return (PACKAGE_MANAGER_NAMES as readonly string[]).includes(value) ? true : `Package manager must be one of: ${PACKAGE_MANAGER_NAMES.join(', ')}`;
}

function validateProjectName(value: string): true | string {
  if (!value) return 'Project name is required';
  if (!/^[a-z0-9-_]+$/.test(value)) {
    return 'Project name can only contain lowercase letters, numbers, hyphens, and underscores';
  }
  return true;
}

function validateFramework(value: string): true | string {
  return (FRAMEWORKS as readonly string[]).includes(value) ? true : `Framework must be one of: ${FRAMEWORKS.join(', ')}`;
}

async function main() {
  console.log(pc.cyan('\nWelcome to τjs (taujs)\n'));

  const { projectName: argName, framework: argFramework, packageManager: argPackageManager, install: argInstall, installConflict } = parseArgs();

  // Every argument failure is reported BEFORE the target directory is created, so a rejected
  // invocation leaves nothing behind on disk.
  if (installConflict) {
    console.log(pc.red('\n✖ --install and --no-install are mutually exclusive'));
    process.exit(1);
  }

  if (argPackageManager) {
    const res = validatePackageManager(argPackageManager);
    if (res !== true) {
      console.log(pc.red(`\n✖ Invalid package manager "${argPackageManager}": ${res}`));
      process.exit(1);
    }
  }

  if (argName) {
    const res = validateProjectName(argName);
    if (res !== true) {
      console.log(pc.red(`\n✖ Invalid project name "${argName}": ${res}`));
      process.exit(1);
    }
  }

  if (argFramework) {
    const res = validateFramework(argFramework);
    if (res !== true) {
      console.log(pc.red(`\n✖ Invalid framework "${argFramework}": ${res}`));
      process.exit(1);
    }
  }

  const questions: prompts.PromptObject[] = [
    {
      type: argName ? null : 'text',
      name: 'projectName',
      message: 'Project name:',
      initial: 'my-taujs-app',
      validate: validateProjectName,
    },
    {
      type: argFramework ? null : 'select',
      name: 'framework',
      message: 'Framework:',
      choices: [
        { title: 'React', value: 'react' },
        { title: 'Vue', value: 'vue' },
        { title: 'Solid', value: 'solid' },
        { title: 'HTML (no component framework)', value: 'html' },
      ],
      initial: 0,
    },
    {
      type: argPackageManager ? null : 'select',
      name: 'packageManager',
      message: 'Package manager:',
      choices: [
        { title: 'npm', value: 'npm' },
        { title: 'pnpm', value: 'pnpm' },
        { title: 'yarn', value: 'yarn' },
      ],
      initial: 0,
    },
    {
      type: argInstall === undefined ? 'confirm' : null,
      name: 'installDeps',
      message: 'Install dependencies now?',
      initial: true,
    },
  ];

  const answers = await prompts(questions, {
    onCancel: () => {
      console.log(pc.red('\n✖ Operation cancelled'));
      process.exit(1);
    },
  });

  const projectName = argName ?? answers.projectName;

  const nameRes = validateProjectName(projectName);
  if (nameRes !== true) {
    console.log(pc.red(`\n✖ Invalid project name "${projectName}": ${nameRes}`));
    process.exit(1);
  }

  if (!projectName) {
    console.log(pc.red('\n✖ Project name is required'));
    process.exit(1);
  }

  const framework = (argFramework ?? answers.framework) as Framework;
  const frameworkRes = validateFramework(framework);
  if (frameworkRes !== true) {
    console.log(pc.red(`\n✖ Invalid framework "${framework}": ${frameworkRes}`));
    process.exit(1);
  }

  const config: ProjectConfig = {
    projectName,
    packageManager: (argPackageManager ?? answers.packageManager) as PackageManager,
    installDeps: argInstall ?? answers.installDeps,
    framework,
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

  console.log(pc.green('Project files created'));

  let depsInstalled = false;

  if (installDeps) {
    console.log(pc.cyan(`\nInstalling dependencies with ${packageManager}...\n`));
    try {
      execSync(PACKAGE_MANAGERS[packageManager], {
        cwd: targetDir,
        stdio: 'inherit',
      });
      depsInstalled = true;
      console.log(pc.green('\nDependencies installed'));
    } catch (error) {
      console.log(pc.yellow('\n⚠ Failed to install dependencies. You can install them manually.'));
    }
  }

  if (installDeps && !depsInstalled) {
    console.log(pc.yellow('⚠ Dependency install failed. Run the install command before starting the dev server.\n'));
  }
  console.log(pc.green(`\n✓ Project ${pc.bold(projectName)} created successfully!\n`));
  console.log(pc.cyan('Next steps:\n'));
  console.log(`  cd ${projectName}`);

  if (!depsInstalled) console.log(`  ${PACKAGE_MANAGERS[packageManager]}${installDeps ? '  # (install failed earlier)' : ''}`);

  const pmRun = packageManager === 'npm' ? 'npm run' : packageManager;
  console.log(`  ${pmRun} dev\n`);
  console.log(pc.dim('Documentation: https://taujs.dev\n'));
}

async function createDirectoryStructure(targetDir: string) {
  const dirs: string[] = ['src/server/services', 'src/client', 'src/client/public'];

  for (const dir of dirs) {
    await fs.ensureDir(path.join(targetDir, dir));
  }
}

type FileEntry = { path: string; content: string } | { path: string; json: unknown };

/**
 * Pure description of the scaffolded file set for a config. Exported so tests can assert the
 * React output is byte-identical and the Vue file set/content is correct without touching the
 * filesystem. The React branch calls the exact same generators as before — output is unchanged.
 */
export function planFiles(config: ProjectConfig): FileEntry[] {
  const { projectName, packageManager, framework } = config;

  // Every file BUT README.md: the README's own "Project Structure" tree is RENDERED from this
  // exact plan (see generateReadme/planFilesTree below), so it can never again silently omit a
  // file the scaffold actually writes - which is how solid's README came to omit renderId.ts and
  // tsconfig.solid.json. README.md is computed last, from these paths, to avoid the circular call.
  const shared: FileEntry[] = [
    { path: 'package.json', json: generatePackageJson(projectName, framework) },
    { path: 'build.ts', content: generateBuildTs() },
    { path: 'tsconfig.json', json: generateTsConfig(framework) },
    { path: 'src/server/tsconfig.json', json: generateServerTsConfig() },
    { path: 'taujs.config.ts', content: generateTaujsConfig(framework) },
    { path: '.gitignore', content: generateGitignore() },
    // Agent wiring (P1-04): pinned local-bin MCP config + a short CLAUDE.md pointer whose
    // substance ships in @taujs/mcp.
    { path: '.mcp.json', json: generateMcpJson(packageManager) },
    { path: 'CLAUDE.md', content: generateClaudeMd() },
    { path: 'src/client/index.html', content: generateIndexHtml() },
    { path: 'src/client/styles.css', content: generateStyles() },
    // The derived type contract (framework-independent): AppData/AppRouteContext come from
    // taujs.config.ts, so client code never hand-writes a payload shape.
    { path: 'src/client/app-types.ts', content: generateAppTypes() },
    // server (framework-independent — a single shared source)
    { path: 'src/server/index.ts', content: generateServerIndex() },
    { path: 'src/server/services/registry.ts', content: generateServiceRegistry() },
    { path: 'src/server/services/example.service.ts', content: generateExampleService() },
    { path: 'src/server/types.d.ts', content: generateServiceTypesAugmentation() },
    { path: 'src/client/public/favicon.svg', content: generateFavicon() },
    // Solid's managed compiler owns a DISJOINT tsconfig project: it must claim the client TSX and
    // nothing else. Pointing it at the root tsconfig would make it claim `src/server/**` too, which
    // is not Solid TSX and is compiled by the server toolchain.
    ...(framework === 'solid' ? [{ path: 'tsconfig.solid.json', json: generateSolidCompilerTsConfig() } as FileEntry] : []),
  ];

  const client: FileEntry[] = CLIENT_FILES[framework]();

  const withoutReadme = [...shared, ...client];
  const readme: FileEntry = {
    path: 'README.md',
    content: generateReadme(
      projectName,
      packageManager,
      framework,
      withoutReadme.map((e) => e.path),
    ),
  };

  return [...withoutReadme, readme];
}

// Per-framework client file plan. A framework absent from this record is a compile error, not a
// silently-skipped branch - the same discipline as FRAMEWORK_EXTRAS/FRAMEWORK_META. Wrapped in a
// thunk (rather than a plain array) so a generator with side effects is never called for a
// framework planFiles was not asked to plan.
const CLIENT_FILES: Record<Framework, () => FileEntry[]> = {
  solid: () => [
    { path: 'src/client/App.tsx', content: generateAppComponentSolid() },
    { path: 'src/client/renderId.ts', content: generateSolidRenderId() },
    { path: 'src/client/entry-client.tsx', content: generateEntryClientSolid() },
    { path: 'src/client/entry-server.tsx', content: generateEntryServerSolid() },
    { path: 'src/client/vite-env.d.ts', content: generateViteEnv() },
  ],
  vue: () => [
    { path: 'src/client/App.vue', content: generateAppVue() },
    { path: 'src/client/HomePage.vue', content: generateHomePageVue() },
    { path: 'src/client/StreamingPage.vue', content: generateStreamingPageVue() },
    { path: 'src/client/entry-client.ts', content: generateEntryClientVue() },
    { path: 'src/client/entry-server.ts', content: generateEntryServerVue() },
    { path: 'src/client/vite-env.d.ts', content: generateViteEnvVue() },
  ],
  react: () => [
    { path: 'src/client/App.tsx', content: generateAppComponent() },
    { path: 'src/client/entry-client.tsx', content: generateEntryClient() },
    { path: 'src/client/entry-server.tsx', content: generateEntryServer() },
    { path: 'src/client/vite-env.d.ts', content: generateViteEnv() },
  ],
  html: () => [
    { path: 'src/client/page.ts', content: generatePageHtml() },
    { path: 'src/client/entry-client.ts', content: generateEntryClientHtml() },
    { path: 'src/client/entry-server.ts', content: generateEntryServerHtml() },
    { path: 'src/client/vite-env.d.ts', content: generateViteEnv() },
  ],
};

async function generateFiles(targetDir: string, config: ProjectConfig) {
  for (const entry of planFiles(config)) {
    const full = path.join(targetDir, entry.path);
    await fs.ensureDir(path.dirname(full));
    if ('json' in entry) {
      await fs.writeJSON(full, entry.json, { spaces: 2 });
    } else {
      await fs.writeFile(full, entry.content);
    }
  }
}

// Pins shared by every generated project, regardless of framework - one edit changes all four.
// Values must stay compatible with @taujs/server's own peerDependencies (asserted directly against
// the workspace manifests in pins.test.ts, so this object cannot drift from them unnoticed again).
export const SHARED_PINS = {
  fastify: '^5.8.5',
  vite: '^8.2.1',
  typescript: '^5.7.3',
  tsx: '^4.19.3',
  crossEnv: '^7.0.3',
  // `build:server` invokes the esbuild BINARY directly, so it must be a declared dependency of the
  // generated project - it is not inherited from vite's own copy.
  esbuild: '^0.28.1',
  typesNode: '^22.10.5',
} as const;

// Vite 8 requires this floor; a generated project must declare what it needs.
const NODE_ENGINE = '^20.19.0 || >=22.12.0';

type FrameworkExtras = {
  /** The renderer package, e.g. `@taujs/react`. */
  rendererPackage: string;
  /** Framework runtime dependency/ies: react+react-dom, vue+@vue/server-renderer, solid-js; empty for html - it has no runtime dependencies. */
  runtimeDeps: Record<string, string>;
  /** The framework's Vite plugin, as `[name, version]`; absent for html - it needs no managed compiler. */
  vitePlugin?: readonly [name: string, version: string];
  /** `@types/*` packages the framework needs beyond the shared `@types/node` (react only). */
  typeDeps?: Record<string, string>;
  /** devDependencies beyond the vite plugin and type deps (vue's `vue-tsc`). */
  extraDevDeps?: Record<string, string>;
  /** The generated `lint` script (vue type-checks SFCs through `vue-tsc`). */
  lint: string;
};

// A framework absent from this record is a compile error, not a silently-skipped branch -
// adding another framework must fill this in before it can ship. generatePackageJson has no
// per-framework branch: everything framework-specific in a generated package.json comes from here.
// Guarded by pins.test.ts: runtime pins equal the renderer's own peers, `@types/*` satisfy them.
export const FRAMEWORK_EXTRAS: Record<Framework, FrameworkExtras> = {
  react: {
    rendererPackage: '@taujs/react',
    runtimeDeps: { react: '^19.0.0', 'react-dom': '^19.0.0' },
    vitePlugin: ['@vitejs/plugin-react', '^5.2.0'],
    typeDeps: { '@types/react': '^19.0.2', '@types/react-dom': '^19.0.2' },
    lint: 'tsc --noEmit',
  },
  vue: {
    rendererPackage: '@taujs/vue',
    runtimeDeps: { vue: '^3.5.0', '@vue/server-renderer': '^3.5.0' },
    vitePlugin: ['@vitejs/plugin-vue', '^6.0.3'],
    extraDevDeps: { 'vue-tsc': '^2.1.10' },
    lint: 'vue-tsc --noEmit',
  },
  solid: {
    rendererPackage: '@taujs/solid',
    runtimeDeps: { 'solid-js': '^1.9.0' },
    // The managed compiler instantiates this internally with `ssr: true` forced; the app never
    // adds it to `plugins` itself.
    vitePlugin: ['vite-plugin-solid', '^2.11.11'],
    lint: 'tsc --noEmit',
  },
  html: {
    rendererPackage: '@taujs/html',
    runtimeDeps: {},
    lint: 'tsc --noEmit',
  },
};

// package.json maps are written in alphabetical key order, which is the order every framework
// already shipped in - so the derived output stays byte-identical to the hand-written maps.
const sortedKeys = (o: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]!]),
  );

function generatePackageJson(projectName: string, framework: Framework) {
  const extras = FRAMEWORK_EXTRAS[framework];
  // Absent for html: it needs no managed compiler, so it declares no Vite plugin devDependency.
  const vitePluginDep = extras.vitePlugin ? { [extras.vitePlugin[0]]: extras.vitePlugin[1] } : {};
  const serverBundle = `esbuild src/server/index.ts --bundle --platform=node --format=esm --outfile=dist/server/index.js --external:fastify --external:@taujs/server --external:${extras.rendererPackage}`;

  return {
    name: projectName,
    version: '0.1.0',
    private: true,
    engines: { node: NODE_ENGINE },
    type: 'module',
    scripts: {
      dev: 'cross-env NODE_ENV=development tsx watch --ignore vite.config.ts --trace-warnings --tsconfig ./src/server/tsconfig.json ./src/server/index.ts --loglevel verbose',
      'build:client': 'cross-env NODE_ENV=production tsx build.ts',
      'build:entry-server': 'cross-env NODE_ENV=production BUILD_MODE=ssr tsx build.ts',
      'build:server': serverBundle,
      build: `cross-env NODE_ENV=production tsx build.ts && cross-env NODE_ENV=production BUILD_MODE=ssr tsx build.ts && ${serverBundle}`,
      start: 'cross-env NODE_ENV=production node dist/server/index.js',
      lint: extras.lint,
    },
    dependencies: sortedKeys({
      '@taujs/server': 'latest',
      [extras.rendererPackage]: 'latest',
      fastify: SHARED_PINS.fastify,
      ...extras.runtimeDeps,
    }),
    devDependencies: sortedKeys({
      '@taujs/mcp': 'latest',
      '@types/node': SHARED_PINS.typesNode,
      ...extras.typeDeps,
      ...vitePluginDep,
      'cross-env': SHARED_PINS.crossEnv,
      esbuild: SHARED_PINS.esbuild,
      tsx: SHARED_PINS.tsx,
      typescript: SHARED_PINS.typescript,
      vite: SHARED_PINS.vite,
      ...extras.extraDevDeps,
    }),
  };
}

function generateBuildTs() {
  return `import path from "node:path";
import { taujsBuild } from "@taujs/server/build";
import config from "./taujs.config.ts";

await taujsBuild({
  clientBaseDir: path.resolve(process.cwd(), "src/client"),
  config,
  projectRoot: process.cwd(),
});
`;
}

// Vue SFCs are typed by vue-tsc; React needs the automatic JSX runtime; Solid PRESERVES JSX for
// its own Babel transform and types it through `solid-js`; html has no JSX at all.
const JSX_OPTIONS: Record<Framework, Record<string, string>> = {
  react: { jsx: 'react-jsx' },
  solid: { jsx: 'preserve', jsxImportSource: 'solid-js' },
  vue: {},
  html: {},
};

function generateTsConfig(framework: Framework) {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      ...JSX_OPTIONS[framework],
      moduleResolution: 'bundler',
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
        '@client/*': ['./src/client/*'],
        '@server/*': ['./src/server/*'],
      },
    },
    include: ['src/client/**/*', 'src/server/**/*', 'taujs.config.ts'],
  };
}

function generateServerTsConfig() {
  return {
    extends: '../../tsconfig.json',
    include: ['./**/*'],
  };
}

// Renderer v1: every app declares a REQUIRED singular `renderer:`. Vue and html supply no compiler
// (no `plugins:` entry); React and Solid declare their ownership tsconfig `project` - Solid's is the
// DISJOINT compiler project (`vite-plugin-solid` is supplied internally, with `ssr: true` forced, and
// there is no option to override the transform mode), React's is the root tsconfig covering src/**.
const RENDERER_DECLARATION: Record<Framework, { importLine: string; rendererLine: string }> = {
  react: {
    importLine: `\nimport { reactRenderer } from '@taujs/react/renderer';`,
    rendererLine: `\n      renderer: reactRenderer({ project: './tsconfig.json' }),`,
  },
  vue: {
    importLine: `\nimport { vueRenderer } from '@taujs/vue/renderer';`,
    rendererLine: `\n      renderer: vueRenderer(),`,
  },
  solid: {
    importLine: `\nimport { solidRenderer } from '@taujs/solid/renderer';`,
    rendererLine: `\n      renderer: solidRenderer({ project: './tsconfig.solid.json' }),`,
  },
  html: {
    importLine: `\nimport { htmlRenderer } from '@taujs/html/renderer';`,
    rendererLine: `\n      renderer: htmlRenderer(),`,
  },
};

function generateTaujsConfig(framework: Framework) {
  const { importLine: rendererImport, rendererLine } = RENDERER_DECLARATION[framework];
  const streamingDescription = FRAMEWORK_META[framework].streamingDescription;
  return `import { createServiceData, defineConfig } from '@taujs/server/config';${rendererImport}

import type { ServiceRegistry } from './src/server/services/registry.ts';

// Registry-typed service declarations: the helper carries each method's RESULT type into
// RouteData, so the app's types derive from this file instead of being hand-written
// (see src/client/app-types.ts). Closure handlers and ctx.call remain available for dynamic
// dispatch - https://taujs.dev/guides/services/
const serviceData = createServiceData<ServiceRegistry>();

export default defineConfig({
  server: {
    port: 5173,
    host: 'localhost',
    hmrPort: 5174,
  },
  // Declared Vite surface - applied to dev and build. See https://taujs.dev/reference/taujs-config/#vite-configuration
  // vite: {
  //   define: { __APP_VERSION__: JSON.stringify('0.0.0') },
  //   plugins: [],
  // },
  // alias: { '@components': './src/client/shared/components' },
  apps: [
    {
      appId: 'main',
      entryPoint: '',${rendererLine}
      routes: [
        {
          path: '/',
          attr: {
            render: 'ssr',
            hydrate: true,
            // Declared service edge: RouteData<typeof config, '/'> is greet()'s resolved result
            data: serviceData('example', 'greet', () => ({ name: 'SSR' })),
          },
        },
        {
          path: '/streaming',
          attr: {
            render: 'streaming',
            hydrate: true,
            // The same declared edge on a streaming route: the shell streams while greet() resolves
            data: serviceData('example', 'greet', () => ({ name: 'Streaming' })),
            // meta recommended for streaming routes for SEO/social and render timing
            meta: {
              title: "τjs — Streaming",
              description:
                "${streamingDescription}",
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

// The framework-varying bits of the README, plus the streaming route's meta.description used by
// generateTaujsConfig above - in one place so adding a framework is a compile error until this is
// filled in.
const FRAMEWORK_META: Record<Framework, { name: string; docsUrl: string; mainUi: string; clientExt: string; streamingDescription: string }> = {
  react: {
    name: 'React',
    docsUrl: 'https://react.dev',
    mainUi: 'App.tsx',
    clientExt: 'tsx',
    streamingDescription: 'Streaming SSR route (Suspense progressively reveals content).',
  },
  vue: {
    name: 'Vue',
    docsUrl: 'https://vuejs.org',
    mainUi: 'App.vue',
    clientExt: 'ts',
    streamingDescription: 'Streaming SSR route (Suspense progressively reveals content).',
  },
  solid: {
    name: 'Solid',
    docsUrl: 'https://www.solidjs.com',
    mainUi: 'App.tsx',
    clientExt: 'tsx',
    streamingDescription: 'Streaming SSR route (Suspense progressively reveals content).',
  },
  html: {
    name: 'HTML',
    docsUrl: 'https://developer.mozilla.org/docs/Web/HTML',
    mainUi: 'page.ts',
    clientExt: 'ts',
    streamingDescription: 'Streaming SSR route (the response streams as chunks; no component framework).',
  },
};

// One entry per path any framework's planFiles() can produce. Guarded by generate.test.ts in both
// directions: every planned path must have a note here (nothing reaches the tree undocumented),
// and every key here must be produced by at least one framework (no note can rot into an orphan).
// A path used by more than one framework (e.g. App.tsx by react and solid) shares one note when
// the description is true for both - no per-framework variant is needed unless it stops being true.
export const FILE_NOTES: Record<string, string> = {
  'package.json': '',
  'build.ts': 'Production build entry point',
  'tsconfig.json': 'TypeScript project config',
  'src/server/tsconfig.json': 'Server-only TS config (used by tsx watch)',
  'taujs.config.ts': 'τjs configuration',
  '.gitignore': 'Git ignore rules',
  '.mcp.json': 'Pinned MCP server wiring',
  'CLAUDE.md': 'Agent notes pointer',
  'src/client/index.html': 'HTML shell',
  'src/client/styles.css': 'Global styles',
  'src/client/app-types.ts': 'Types derived from taujs.config.ts',
  'src/server/index.ts': 'Server entry point',
  'src/server/services/registry.ts': 'Service registry',
  'src/server/services/example.service.ts': 'Example service',
  'src/server/types.d.ts': 'ServiceContext augmentation',
  'src/client/public/favicon.svg': 'App icon',
  'tsconfig.solid.json': 'Solid compiler TS config (client TSX only)',
  'src/client/vite-env.d.ts': 'Vite client types',
  'src/client/App.tsx': 'Root component',
  'src/client/entry-client.tsx': 'Client hydration entry',
  'src/client/entry-server.tsx': 'SSR render entry',
  'src/client/renderId.ts': 'Shared hydration render ID',
  'src/client/App.vue': 'Root component (route switch)',
  'src/client/HomePage.vue': 'SSR route (useSSRData + v-if)',
  'src/client/StreamingPage.vue': 'Streaming route (await useSSRDataAsync)',
  'src/client/entry-client.ts': 'Client hydration entry',
  'src/client/entry-server.ts': 'SSR render entry',
  'src/client/page.ts': 'Page markup: render function and the app-owned escaper',
};

// The shared note for src/client/entry-client.ts ("Client hydration entry") is false for html -
// there is no hydration, only progressive enhancement. Keys must also exist in FILE_NOTES (a
// generate.test.ts cell asserts it) so the two existing FILE_NOTES guards stay true; react/vue/solid
// READMEs stay byte-identical because they have no override.
export const FILE_NOTE_OVERRIDES: Partial<Record<Framework, Record<string, string>>> = {
  html: { 'src/client/entry-client.ts': 'Client enhancement entry (no hydration)' },
};

type TreeNode = { children: Map<string, TreeNode>; fullPath: string };

function buildFileTree(paths: string[]): TreeNode {
  const root: TreeNode = { children: new Map(), fullPath: '' };

  for (const filePath of paths) {
    let node = root;
    let acc = '';
    for (const part of filePath.split('/')) {
      acc = acc ? `${acc}/${part}` : part;
      let next = node.children.get(part);
      if (!next) {
        next = { children: new Map(), fullPath: acc };
        node.children.set(part, next);
      }
      node = next;
    }
  }

  return root;
}

// Directories before files at every level, each group in first-seen order - a deterministic,
// readable grouping with no need to hand-sort anything.
function orderedChildren(node: TreeNode): TreeNode[] {
  const all = [...node.children.values()];
  return [...all.filter((n) => n.children.size > 0), ...all.filter((n) => n.children.size === 0)];
}

/**
 * The exact order `planFilesTree` renders paths in. Exported so tests can assert the README lists
 * every planned file in tree order without re-implementing the grouping.
 */
export function orderedTreePaths(paths: string[]): string[] {
  const out: string[] = [];
  const walk = (node: TreeNode) => {
    for (const child of orderedChildren(node)) {
      out.push(child.fullPath);
      walk(child);
    }
  };
  walk(buildFileTree(paths));

  return out;
}

/**
 * Renders the box-drawing project tree from the plan's real paths, with notes from FILE_NOTES,
 * overridden per FILE_NOTE_OVERRIDES[framework] where one exists (html's entry-client.ts note).
 */
function planFilesTree(paths: string[], framework: Framework): string {
  const lines: Array<{ text: string; note: string }> = [];
  const overrides = FILE_NOTE_OVERRIDES[framework];

  const render = (node: TreeNode, prefix: string) => {
    const children = orderedChildren(node);
    children.forEach((child, i) => {
      const isLast = i === children.length - 1;
      const isDir = child.children.size > 0;
      const base = child.fullPath.split('/').pop()!;
      const name = isDir ? `${base}/` : base;
      const note = isDir ? '' : (overrides?.[child.fullPath] ?? FILE_NOTES[child.fullPath] ?? '');

      lines.push({ text: `${prefix}${isLast ? '└── ' : '├── '}${name}`, note });
      if (isDir) render(child, prefix + (isLast ? '    ' : '│   '));
    });
  };

  render(buildFileTree(paths), '');

  const width = Math.max(0, ...lines.filter((l) => l.note).map((l) => l.text.length));

  return lines.map((l) => (l.note ? `${l.text.padEnd(width + 2)}# ${l.note}` : l.text)).join('\n');
}

function generateReadme(projectName: string, packageManager: string, framework: Framework, paths: string[]) {
  const pmRun = packageManager === 'npm' ? 'npm run' : packageManager;
  const meta = FRAMEWORK_META[framework];

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
${planFilesTree(paths, framework)}
\`\`\`

## Editing the App

- Main UI: \`src/client/${meta.mainUi}\`
- Styles: \`src/client/styles.css\`
- SSR entry: \`src/client/entry-server.${meta.clientExt}\`
- Client entry: \`src/client/entry-client.${meta.clientExt}\`
- Routes: \`taujs.config.ts\`
- Services: \`src/server/services/\`

## Documentation

- [τjs Documentation](https://taujs.dev)
- [Fastify Documentation](https://fastify.dev)
- [${meta.name} Documentation](${meta.docsUrl})

## License

MIT
`;
}

function generateIndexHtml() {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!--ssr-head-->
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

import "./styles.css";

import type { AppData } from './app-types';

function GreetingCard() {
  // AppData is derived from taujs.config.ts - greet()'s result, never hand-written.
  const data = useSSRStore<AppData>();

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
          Request-first application composition with explicit per-route rendering control.
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
          <strong>STREAM:</strong> The <code>/streaming</code> route declares the same typed
          service edge with streaming rendering. The <code>&lt;Suspense&gt;</code> boundary above
          shows a fallback while the server resolves it, then progressively streams the final content.
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
  background: url("/favicon.svg") no-repeat;
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

function generateAppTypes() {
  return `/**
 * The application's type contract, DERIVED from taujs.config.ts - never hand-written.
 * Every import here is type-only, so nothing from the config or server reaches the client bundle.
 */
import type config from '../../taujs.config.ts';
import type { RouteContext, RouteData } from '@taujs/server/config';

/** The route-discriminated context the host passes to appComponent and headContent. */
export type AppRouteContext = RouteContext<typeof config>;

/**
 * The union of every declared route's resolved data - both scaffold routes resolve greet(), so
 * one shared type serves the whole app.
 *
 * A declared route WITHOUT \`attr.data\` contributes \`Record<string, undefined>\` (the server
 * supplies \`{}\` for it), so the union stays usable when such routes exist: reads become
 * \`T | undefined\`, making code account for the no-data route. When routes diverge further,
 * narrow per route with the derived aliases below - still from the config, never hand-written.
 */
export type AppData = RouteData<typeof config>;

// Optional narrowing when routes diverge:
// export type HomeData = RouteData<typeof config, '/'>;
// export type StreamingData = RouteData<typeof config, '/streaming'>;
`;
}

function generateViteEnv() {
  return `/// <reference types="vite/client" />
`;
}

function generateViteEnvVue() {
  return `/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
`;
}

function generateAppVue() {
  return `<script setup lang="ts">
import { computed } from 'vue';

import HomePage from './HomePage.vue';
import StreamingPage from './StreamingPage.vue';

import './styles.css';

const props = defineProps<{ location?: string; routeContext?: unknown }>();

// The server passes \`location\`; on the client fall back to the current path so hydration matches.
const path = computed(() => props.location ?? (typeof window !== 'undefined' ? window.location.pathname : '/'));
const isStreaming = computed(() => path.value.startsWith('/streaming'));
</script>

<template>
  <div class="app">
    <header class="app-header">
      <h1 class="app-title">τjs - Composing systems, not just apps</h1>
      <p class="app-subtitle">Request-first application composition with explicit per-route rendering control.</p>
    </header>

    <Suspense v-if="isStreaming">
      <template #default>
        <StreamingPage />
      </template>
      <template #fallback>
        <section class="card card--primary">
          <p class="card-message">Loading greeting…</p>
          <p class="card-meta">Streaming data from the server.</p>
        </section>
      </template>
    </Suspense>
    <HomePage v-else />

    <section class="section">
      <h2 class="section-title">Quick start</h2>
      <ul class="list">
        <li>Edit <code>src/client/App.vue</code> to change this page.</li>
        <li>Adjust styles in <code>src/client/styles.css</code>.</li>
        <li>Configure routes in <code>taujs.config.ts</code>.</li>
        <li>Visit <a href="/">/</a> for standard SSR and <a href="/streaming">/streaming</a> for streaming SSR.</li>
        <li>Further information can be found at <a href="http://taujs.dev" target="_blank">τjs Documentation and Guides</a>.</li>
      </ul>
    </section>

    <section class="tip">
      <p>
        <strong>SSR:</strong> The <code>/</code> route resolves data on the server, then consumes it with
        <code>useSSRData</code> + <code>v-if</code> (non-blocking fallback rendering).
      </p>
      <p>
        <strong>STREAM:</strong> The <code>/streaming</code> route <code>await</code>s <code>useSSRDataAsync</code>
        in async <code>setup</code> under <code>&lt;Suspense&gt;</code>, so the render blocks until data resolves.
      </p>
    </section>

    <footer class="app-footer">
      <p>
        Built with
        <a href="https://taujs.dev" target="_blank" rel="noopener">τjs</a>
        ·
        <a href="https://fastify.dev" target="_blank" rel="noopener">Fastify</a>
        ·
        <a href="https://vuejs.org" target="_blank" rel="noopener">Vue</a>
      </p>
    </footer>
  </div>
</template>
`;
}

function generateHomePageVue() {
  return `<script setup lang="ts">
import { useSSRData } from '@taujs/vue';

import type { AppData } from './app-types';

// Fallback idiom: non-blocking; \`data\` is undefined until ready, guarded with v-if.
// AppData is derived from taujs.config.ts - greet()'s result, never hand-written.
const data = useSSRData<AppData>();
</script>

<template>
  <section v-if="data" class="card card--primary">
    <p class="card-message">{{ data.message }}</p>
    <p class="card-meta">Generated at: {{ new Date(data.timestamp).toLocaleString() }}</p>
  </section>
  <section v-else class="card card--primary">
    <p class="card-message">Loading greeting…</p>
    <p class="card-meta">Resolving data on the server.</p>
  </section>
</template>
`;
}

function generateStreamingPageVue() {
  return `<script setup lang="ts">
import { useSSRDataAsync } from '@taujs/vue';

import type { AppData } from './app-types';

// Suspense idiom: async setup blocks on the data, so streamed routes deliver it in the payload.
// AppData is derived from taujs.config.ts - greet()'s result, never hand-written.
const data = await useSSRDataAsync<AppData>();
</script>

<template>
  <section class="card card--primary">
    <p class="card-message">{{ data.message }}</p>
    <p class="card-meta">Generated at: {{ new Date(data.timestamp).toLocaleString() }}</p>
  </section>
</template>
`;
}

function generateEntryClientVue() {
  return `import { hydrateApp } from '@taujs/vue';

import App from './App.vue';

hydrateApp({
  appComponent: App,
  rootElementId: 'root',
  enableDebug: import.meta.env.DEV,
});
`;
}

function generateEntryServerVue() {
  return `import { createRenderer } from '@taujs/vue';

import App from './App.vue';

import type { AppData, AppRouteContext } from './app-types';

// Generics derived from taujs.config.ts: typed data for headContent and the store, typed
// routeContext for appComponent.
export const { renderSSR, renderStream } = createRenderer<AppData, AppRouteContext>({
  appComponent: App,
  headContent: ({ data, meta }) => \`
    <title>\${meta?.title || "τjs - Composing systems, not just apps"}</title>
    <meta name="description" content="\${
      meta?.description ||
      data?.message ||
      "τjs - Composing systems, not just apps"
    }">
  \`,
  enableDebug: process.env.NODE_ENV === "development",
});
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

import type { AppData, AppRouteContext } from './app-types';

// Generics derived from taujs.config.ts: typed data for headContent and the store, typed
// routeContext for appComponent.
export const { renderSSR, renderStream } = createRenderer<AppData, AppRouteContext>({
  appComponent: () => <App />,
  headContent: ({ data, meta }) => \`
    <title>\${meta?.title || "τjs - Composing systems, not just apps"}</title>
    <meta name="description" content="\${
      meta?.description ||
      data?.message ||
      "τjs - Composing systems, not just apps"
    }">
  \`,
  enableDebug: process.env.NODE_ENV === "development",
});
`;
}

function generateSolidCompilerTsConfig() {
  // The Solid managed compiler's DISJOINT ownership project. It claims the client TSX and nothing
  // else - deliberately not the root tsconfig, which also covers `src/server/**` and
  // `taujs.config.ts`. `jsx: 'preserve'` hands JSX to Solid's Babel transform rather than
  // TypeScript's.
  return {
    compilerOptions: {
      jsx: 'preserve',
      jsxImportSource: 'solid-js',
    },
    include: ['src/client/**/*.tsx'],
  };
}

function generateSolidRenderId() {
  return `/**
 * The renderId is a SHARED constant: the server renders Solid's markers and serialised data under
 * this namespace, and the client must hydrate under the SAME one. It is imported by BOTH entries
 * on purpose - a literal duplicated in two files is a hydration bug waiting to happen.
 */
export const RENDER_ID = 'app';
`;
}

function generateAppComponentSolid() {
  return `import { Show } from 'solid-js';
import { useSSRStore } from '@taujs/solid';

import type { AppData } from './app-types';

export function App() {
  // Route data arrives through the store, which the renderer provides. On the server it is already
  // committed before the render begins; on the client it is seeded from window.__INITIAL_DATA__.
  // AppData is derived from taujs.config.ts - greet()'s result, never hand-written.
  const store = useSSRStore<AppData>();

  return (
    <main>
      <h1>τjs + Solid</h1>
      <Show when={store.data().message} fallback={<p>No route data.</p>}>
        <p>{store.data().message}</p>
      </Show>
    </main>
  );
}
`;
}

function generateEntryClientSolid() {
  return `import { hydrateApp } from '@taujs/solid';

import { App } from './App';
import { RENDER_ID } from './renderId';

hydrateApp({
  app: () => <App />,
  renderId: RENDER_ID,
  rootElementId: 'root',
  onHydrationError: (error) => {
    console.error('Hydration failed:', error);
  },
});
`;
}

function generateEntryServerSolid() {
  return `import { createRenderer } from '@taujs/solid';

import { App } from './App';
import { RENDER_ID } from './renderId';

import type { AppData, AppRouteContext } from './app-types';

// Generics derived from taujs.config.ts: typed data for headContent and the store, typed
// routeContext for appComponent.
export const { renderSSR, renderStream } = createRenderer<AppData, AppRouteContext>({
  appComponent: () => <App />,
  renderId: RENDER_ID,
  headContent: ({ data, meta }) => \`
    <title>\${meta?.title || "τjs - Composing systems, not just apps"}</title>
    <meta name="description" content="\${
      meta?.description ||
      data?.message ||
      "τjs - Composing systems, not just apps"
    }">
  \`,
});
`;
}

function generatePageHtml() {
  return `/**
 * @taujs/html writes headContent and appHtml to the response VERBATIM - it provides NO escaping
 * helper of its own. This file is where the app's markup is assembled, so every value taken from
 * data, meta or user input passes through escapeHtml before it is interpolated. Skipping
 * escapeHtml anywhere below is an XSS bug, not a style choice.
 */
import type { RenderContext } from '@taujs/html';

import type { AppData } from './app-types';

// The five-character replace every interpolation below goes through. @taujs/html ships no escaper
// of its own - this one is the application's.
export function escapeHtml(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// RenderContext<AppData> is stated explicitly: a standalone function gets no contextual type from
// its later use, and the generated project is strict: true.
export function renderPage({ data, meta }: RenderContext<AppData>): { headContent: string; appHtml: string } {
  const headContent = \`
    <title>\${escapeHtml(meta.title || "τjs - Composing systems, not just apps")}</title>
    <meta name="description" content="\${escapeHtml(meta.description || data?.message || "τjs - Composing systems, not just apps")}">
  \`;

  const appHtml = \`
    <section class="card card--primary">
      <p class="card-message">\${escapeHtml(data.message)}</p>
      <p class="card-meta">Generated at: \${escapeHtml(data.timestamp)}</p>
    </section>
  \`;

  return { headContent, appHtml };
}
`;
}

function generateEntryServerHtml() {
  return `import { createRenderer } from '@taujs/html';

import { renderPage } from './page';

import type { AppData } from './app-types';

// Generic derived from taujs.config.ts: typed data for renderPage.
export const { renderSSR, renderStream } = createRenderer<AppData>({
  render: renderPage,
  enableDebug: process.env.NODE_ENV === "development",
});
`;
}

function generateEntryClientHtml() {
  return `import { onDataReady } from '@taujs/html/client';

import './styles.css';

import type { AppData } from './app-types';

// Progressive enhancement of server-rendered HTML: there is no hydration and no component tree.
// \`deferred\` is always undefined here because neither generated route declares \`attr.deferred\`.
onDataReady<AppData>(({ data }) => {
  if (!data) return;

  const section = document.querySelector('.card--primary');
  const meta = document.querySelector('.card-meta');

  if (meta) meta.textContent = \`Generated at: \${new Date(data.timestamp).toLocaleString()}\`;
  if (section) section.setAttribute('data-enhanced', 'true');
});
`;
}

function generateServerIndex() {
  return `import { createServer } from '@taujs/server';
import config from '../../taujs.config.ts';
import { serviceRegistry } from './services/registry.ts';

// Development is requested explicitly, exactly as τjs derives its own runtime mode: every other
// value - production, test, staging, unset - is production. Do not invert this check.
const isDev = process.env.NODE_ENV === "development";

const { app, net } = await createServer({
  config,
  serviceRegistry,
  debug: isDev ? { ssr: true } : false,
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
  // The leading import is REQUIRED, not stylistic. Without it TypeScript treats the block as an
  // AMBIENT MODULE DECLARATION that REPLACES '@taujs/server/config' wholesale - so every real
  // export disappears and `defineConfig` / `defineService` / `defineServiceRegistry` all report
  // TS2305 "has no exported member", which in turn drops the route `data` callbacks to implicit
  // `any` (TS7006). Importing the module first makes this a module AUGMENTATION, which extends the
  // real one instead of shadowing it.
  return `import '@taujs/server/config';

declare module '@taujs/server/config' {
  interface ServiceContext {
    tenantId?: string;
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

// Run the CLI only when executed directly (not when imported, e.g. by tests). realpathSync
// resolves the bin symlink so `create-taujs` still runs when installed.
const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    console.error(pc.red('\n✖ Error creating project:'), error);
    process.exit(1);
  });
}
