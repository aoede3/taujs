#!/usr/bin/env node
// taujs-mcp — the only bin in the τjs introspection design (working conventions rule 4;
// the MCP protocol forces a stdio executable to exist). Launched by the MCP client at the
// project root; reads files, never the network.
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createTaujsMcpServer } from './server';

serveStdio(() => createTaujsMcpServer(process.cwd()));
