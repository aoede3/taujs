// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  createLoggerMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('fastify-plugin', () => ({
  default: (fn: any) => fn,
}));

// AppError.badRequest -> throw Error(message) (with statusCode for convenience)
vi.mock('../../logging/AppError', () => ({
  AppError: {
    badRequest: (msg: string) => {
      const e = new Error(msg);
      (e as any).statusCode = 400;
      return e;
    },
  },
}));

vi.mock('../../logging/Logger', () => ({
  createLogger: hoisted.createLoggerMock,
  Logger: class {},
}));

async function importer() {
  vi.resetModules();

  vi.doMock('fastify-plugin', () => ({ default: (fn: any) => fn }));
  vi.doMock('../../logging/AppError', () => ({
    AppError: {
      badRequest: (msg: string) => {
        const e = new Error(msg);
        (e as any).statusCode = 400;
        return e;
      },
    },
  }));
  vi.doMock('../../logging/Logger', () => ({
    createLogger: hoisted.createLoggerMock,
    Logger: class {},
  }));

  return await import('../CSPReporting');
}

function makeFastify() {
  const routes: Record<string, any> = {};
  const fastify = {
    post(path: string, handler: any) {
      routes[path] = handler;
    },
    _routes: routes,
  } as any;
  return fastify;
}

function makeReqReply(body: any, extras?: Partial<any>) {
  const req = {
    body,
    headers: {
      'user-agent': 'UA',
      referer: 'https://ref',
    },
    ip: '127.0.0.1',
    ...extras,
  } as any;

  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as any;

  return { req, reply };
}

const { createLoggerMock, loggerWarnMock } = hoisted;

beforeEach(() => {
  loggerWarnMock.mockReset();
  createLoggerMock.mockReset().mockReturnValue({
    warn: loggerWarnMock,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('addCSPReporting helpers', () => {
  it('addCSPReporting adds report-uri', async () => {
    const { addCSPReporting } = await importer();
    const res = addCSPReporting({ 'default-src': ["'self'"] }, '/csp-report');
    expect(res).toEqual({
      'default-src': ["'self'"],
      'report-uri': ['/csp-report'],
    });
  });

  it('addCSPReportingBoth adds report-uri and report-to', async () => {
    const { addCSPReportingBoth } = await importer();
    const res = addCSPReportingBoth({ 'default-src': ["'self'"] }, '/csp-report', 'endpointA');
    expect(res).toEqual({
      'default-src': ["'self'"],
      'report-uri': ['/csp-report'],
      'report-to': ['endpointA'],
    });
  });
});

describe('processCSPReport', () => {
  it('warns on malformed body (non-object/undefined)', async () => {
    const { processCSPReport } = await importer();

    processCSPReport(
      undefined,
      {
        userAgent: 'UA',
        ip: '1.2.3.4',
        referer: 'R',
        timestamp: 'T',
        headers: {},
      },
      { warn: loggerWarnMock } as any,
    );

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Ignoring malformed CSP report',
      expect.objectContaining({
        bodyType: 'undefined',
        context: expect.objectContaining({
          userAgent: 'UA',
          ip: '1.2.3.4',
          referer: 'R',
          timestamp: 'T',
        }),
      }),
    );
  });

  it('warns on incomplete report (missing required fields)', async () => {
    const { processCSPReport } = await importer();

    processCSPReport(
      {},
      {
        userAgent: 'UA',
        ip: '1.2.3.4',
        referer: 'R',
        timestamp: 'T',
        headers: {},
      },
      { warn: loggerWarnMock } as any,
    );

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Ignoring incomplete CSP report',
      expect.objectContaining({
        hasDocumentUri: false,
        hasViolatedDirective: false,
        context: expect.any(Object),
      }),
    );
  });

  it('logs violation for valid nested "csp-report" body and maps alias fields', async () => {
    const { processCSPReport } = await importer();

    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/x',
        'violated-directive': "script-src 'none'",
        'blocked-uri': 'https://evil',
        'source-file': '/main.js',
        'line-number': 10,
        'column-number': 5,
        'script-sample': 'alert(1)',
        'original-policy': "default-src 'self'",
        disposition: 'report',
      },
    };

    processCSPReport(
      body,
      {
        userAgent: 'UA',
        ip: '1.2.3.4',
        referer: 'R',
        timestamp: 'T',
        headers: {},
      },
      { warn: loggerWarnMock } as any,
    );

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'CSP Violation',
      expect.objectContaining({
        violation: expect.objectContaining({
          documentUri: 'https://example.com/x',
          violatedDirective: "script-src 'none'",
          blockedUri: 'https://evil',
          sourceFile: '/main.js',
          line: 10,
          column: 5,
          scriptSample: 'alert(1)',
          originalPolicy: "default-src 'self'",
          disposition: 'report',
        }),
      }),
    );
  });

  it('accepts camelCase aliases and defaults disposition to enforce', async () => {
    const { processCSPReport } = await importer();

    const body = {
      documentURL: 'https://ex.com',
      violatedDirective: 'img-src data:',
      blockedURL: 'data:image/png;base64,...',
      sourceFile: '/mod.js',
      lineNumber: 7,
      columnNumber: 2,
      sample: 'data-url',
      originalPolicy: "default-src 'self'",
      // no disposition
    };

    processCSPReport(
      body,
      {
        userAgent: 'UA',
        ip: '1.2.3.4',
        referer: 'R',
        timestamp: 'T',
        headers: {},
      },
      { warn: loggerWarnMock } as any,
    );

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'CSP Violation',
      expect.objectContaining({
        violation: expect.objectContaining({
          documentUri: 'https://ex.com',
          violatedDirective: 'img-src data:',
          blockedUri: 'data:image/png;base64,...',
          sourceFile: '/mod.js',
          line: 7,
          column: 2,
          scriptSample: 'data-url',
          originalPolicy: "default-src 'self'",
          disposition: 'enforce',
        }),
      }),
    );
  });

  it('logs processing failure if something throws during processing', async () => {
    const { processCSPReport } = await importer();

    const body = Object.create(null);
    Object.defineProperty(body, 'csp-report', {
      get() {
        throw new Error('boom');
      },
    });

    processCSPReport(
      body,
      {
        userAgent: 'UA',
        ip: '1.2.3.4',
        referer: 'R',
        timestamp: 'T',
        headers: {},
      },
      { warn: loggerWarnMock } as any,
    );

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'CSP report processing failed',
      expect.objectContaining({
        error: 'boom',
        bodyType: 'object',
        context: expect.any(Object),
      }),
    );
  });
});

describe('createCSPReportProcessor', () => {
  it('delegates to processCSPReport with supplied logger (observable by effect)', async () => {
    const mod = await importer();
    const fakeLogger = { warn: vi.fn() } as any;
    const proc = mod.createCSPReportProcessor(fakeLogger as any);

    const body = { 'csp-report': { 'document-uri': 'x', 'violated-directive': 'y' } };
    const ctx = { timestamp: 'T', headers: {} };

    proc.processReport(body, ctx as any);

    expect(fakeLogger.warn).toHaveBeenCalledWith(
      'CSP Violation',
      expect.objectContaining({
        violation: expect.objectContaining({
          documentUri: 'x',
          violatedDirective: 'y',
        }),
      }),
    );
  });
});

describe('cspReportPlugin', () => {
  it('throws 400 AppError when path is missing or not string', async () => {
    const { cspReportPlugin } = await importer();
    const fastify = makeFastify();

    await expect(cspReportPlugin(fastify as any, {} as any)).rejects.toThrowError('CSP report path is required and must be a string');
    await expect(cspReportPlugin(fastify as any, { path: 123 as any } as any)).rejects.toThrowError('CSP report path is required and must be a string');
  });

  it('registers POST route and replies 204; onViolation called when required fields present', async () => {
    const { cspReportPlugin } = await importer();
    const fastify = makeFastify();
    const onViolation = vi.fn();

    await cspReportPlugin(fastify as any, { path: '/csp-report', onViolation });

    expect(createLoggerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        debug: undefined,
        context: { service: 'csp-reporting' },
        minLevel: 'info',
      }),
    );

    const handler = fastify._routes['/csp-report'];
    expect(typeof handler).toBe('function');

    const body = {
      'csp-report': {
        'document-uri': 'https://ex.com/page',
        'violated-directive': "script-src 'none'",
      },
    };
    const { req, reply } = makeReqReply(body, { url: '/csp-report' });

    await handler(req, reply);

    // onViolation called since required fields present
    expect(onViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        'document-uri': 'https://ex.com/page',
        'violated-directive': "script-src 'none'",
      }),
      req,
    );

    expect(reply.code).toHaveBeenCalledWith(204);
    expect(reply.send).toHaveBeenCalled();
  });

  it('does not call onViolation when body missing required fields', async () => {
    const { cspReportPlugin } = await importer();
    const fastify = makeFastify();
    const onViolation = vi.fn();

    await cspReportPlugin(fastify as any, { path: '/csp-report', onViolation });

    const handler = fastify._routes['/csp-report'];
    const { req, reply } = makeReqReply({}); // missing required fields

    await handler(req, reply);

    expect(onViolation).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(204);
    expect(reply.send).toHaveBeenCalled();
  });

  it('logs a warning if onViolation throws internally but still replies 204', async () => {
    const { cspReportPlugin } = await importer();
    const fastify = makeFastify();

    // onViolation will be invoked and throw, causing the route to catch and log 'CSP reporting route failed'
    const onViolation = vi.fn(() => {
      throw new Error('route-bang');
    });

    await cspReportPlugin(fastify as any, { path: '/csp-report', onViolation });

    const handler = fastify._routes['/csp-report'];

    const body = {
      'csp-report': {
        'document-uri': 'https://ex.com/page',
        'violated-directive': "script-src 'none'",
      },
    };
    const { req, reply } = makeReqReply(body);

    await handler(req, reply);

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'CSP reporting route failed',
      expect.objectContaining({
        error: 'route-bang',
      }),
    );

    expect(reply.code).toHaveBeenCalledWith(204);
    expect(reply.send).toHaveBeenCalled();
  });

  it('passes through debug to createLogger when provided', async () => {
    const { cspReportPlugin } = await importer();
    const fastify = makeFastify();

    await cspReportPlugin(fastify as any, { path: '/csp-report', debug: { all: true } as any });
    expect(createLoggerMock).toHaveBeenCalledWith(expect.objectContaining({ debug: { all: true } }));
  });

  it('logs processing failure with String(processingError) when non-Error is thrown', async () => {
    const { processCSPReport } = await importer();

    const body = Object.create(null);
    Object.defineProperty(body, 'csp-report', {
      get() {
        // non-Error throw → hits String(processingError)
        throw 'boom-str';
      },
    });

    processCSPReport(
      body,
      {
        userAgent: 'UA',
        ip: '1.2.3.4',
        referer: 'R',
        timestamp: 'T',
        headers: {},
      },
      { warn: loggerWarnMock } as any,
    );

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'CSP report processing failed',
      expect.objectContaining({
        error: 'boom-str',
        bodyType: 'object',
        context: expect.any(Object),
      }),
    );
  });

  it('route catch logs String(err) when onViolation throws a non-Error', async () => {
    const { cspReportPlugin } = await importer();
    const fastify = makeFastify();

    const onViolation = vi.fn(() => {
      // non-Error throw → hits String(err)
      throw 'route-bang-str';
    });

    await cspReportPlugin(fastify as any, { path: '/csp-report', onViolation });

    const handler = fastify._routes['/csp-report'];
    const { req, reply } = makeReqReply({
      'csp-report': {
        'document-uri': 'https://ex.com/page',
        'violated-directive': "script-src 'none'",
      },
    });

    await handler(req, reply);

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'CSP reporting route failed',
      expect.objectContaining({
        error: 'route-bang-str', // <- String(err)
      }),
    );
    expect(reply.code).toHaveBeenCalledWith(204);
    expect(reply.send).toHaveBeenCalled();
  });
});
