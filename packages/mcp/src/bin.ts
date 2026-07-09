#!/usr/bin/env node
// taujs-mcp — the only bin in the τjs introspection design (working conventions rule 4;
// the MCP protocol forces a stdio executable to exist). Launched by the MCP client at the
// project root; reads files, never the network.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createTaujsMcpServer } from './server';

const server = createTaujsMcpServer(process.cwd());
await server.connect(new StdioServerTransport());
