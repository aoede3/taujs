export type NetResolved = { host: string; port: number; hmrPort: number };

function readFlag(argv: readonly string[], keys: readonly string[], bareValue?: string): string | undefined {
  const end = argv.indexOf('--');
  const limit = end === -1 ? argv.length : end;

  for (let i = 0; i < limit; i++) {
    const arg = argv[i];

    for (const key of keys) {
      if (arg === key) {
        const next = argv[i + 1];

        if (!next || next.startsWith('-')) return bareValue;

        return next.trim();
      }

      const pref = `${key}=`;
      if (arg && arg.startsWith(pref)) {
        const v = arg.slice(pref.length).trim();

        return v || bareValue;
      }
    }
  }
  return undefined;
}

export function resolveNet(input?: { host?: string; port?: number; hmrPort?: number }): NetResolved {
  const env = process.env;
  const argv = process.argv;

  let host = 'localhost';
  let port = 5173;
  let hmrPort = 5174;

  if (input?.host) host = input.host;
  if (Number.isFinite(input?.port as number)) port = Number(input!.port);
  if (Number.isFinite(input?.hmrPort as number)) hmrPort = Number(input!.hmrPort);

  if (env.HOST?.trim()) host = env.HOST.trim();
  else if (env.FASTIFY_ADDRESS?.trim()) host = env.FASTIFY_ADDRESS.trim();
  if (env.PORT) port = Number(env.PORT) || port;
  if (env.FASTIFY_PORT) port = Number(env.FASTIFY_PORT) || port;
  if (env.HMR_PORT) hmrPort = Number(env.HMR_PORT) || hmrPort;

  // CLI (highest precedence). bare --host means 0.0.0.0
  const cliHost = readFlag(argv, ['--host', '--hostname', '-H'], '0.0.0.0');
  const cliPort = readFlag(argv, ['--port', '-p']);
  const cliHMR = readFlag(argv, ['--hmr-port']);
  if (cliHost) host = cliHost;
  if (cliPort) port = Number(cliPort) || port;
  if (cliHMR) hmrPort = Number(cliHMR) || hmrPort;

  if (host === 'true' || host === '') host = '0.0.0.0';
  return { host, port, hmrPort };
}
