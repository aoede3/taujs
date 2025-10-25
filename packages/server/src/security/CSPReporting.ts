import type { FastifyPluginAsync, FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import { AppError } from '../logging/AppError';
import { createLogger, Logger } from '../logging/Logger';

import type { DebugConfig, Logs } from '../logging/Logger';

export type CSPViolationReport = {
  'document-uri': string;
  'violated-directive': string;
  'blocked-uri'?: string;
  'source-file'?: string;
  'line-number'?: number;
  'column-number'?: number;
  'script-sample'?: string;
  'original-policy'?: string;
  disposition?: 'enforce' | 'report';
};

export type CSPViolationContext = {
  userAgent?: string;
  ip?: string;
  referer?: string;
  timestamp: string;
  headers: Record<string, unknown>;
  [key: string]: unknown; // additional context
};

export type CSPReportProcessor = {
  processReport: (body: unknown, context: CSPViolationContext) => void;
};

export type CSPReportOptions = {
  path: string;
  /**
   * Optional debug configuration to apply to the active logger (instance-level).
   * If you pass your own logger, we only call .configure() when this is provided.
   */
  debug?: DebugConfig;
  /**
   * Optional logger instance to use. Defaults to a new Logger instance.
   */
  logger?: Logs;
  /**
   * Optional callback invoked when a valid report is received. Gives you the parsed
   * report plus the Fastify request object for additional context/actions.
   */
  onViolation?: (report: CSPViolationReport, req: FastifyRequest) => void;
};

/**
 * Minimal/safe context projection for logging (avoiding dumping full headers)
 */
function sanitiseContext(ctx: CSPViolationContext) {
  return {
    userAgent: ctx.userAgent,
    ip: ctx.ip,
    referer: ctx.referer,
    timestamp: ctx.timestamp,
    // headers: ctx.headers,
  };
}

function logCspViolation(logger: Logs, report: CSPViolationReport, context: CSPViolationContext) {
  logger.warn(
    {
      violation: {
        documentUri: report['document-uri'],
        violatedDirective: report['violated-directive'],
        blockedUri: report['blocked-uri'],
        sourceFile: report['source-file'],
        line: report['line-number'],
        column: report['column-number'],
        scriptSample: report['script-sample'],
        originalPolicy: report['original-policy'],
        disposition: report.disposition,
      },
      context: {
        userAgent: context.userAgent,
        ip: context.ip,
        referer: context.referer,
        timestamp: context.timestamp,
      },
    },
    'CSP Violation',
  );
}

export const processCSPReport = (body: unknown, context: CSPViolationContext, logger: Logs): void => {
  try {
    const reportData = (body as any)?.['csp-report'] || body;

    if (!reportData || typeof reportData !== 'object') {
      logger.warn(
        {
          bodyType: typeof body,
          context: sanitiseContext(context),
        },
        'Ignoring malformed CSP report',
      );

      return;
    }

    const documentUri = (reportData as any)['document-uri'] ?? (reportData as any)['documentURL'];
    const violatedDirective = (reportData as any)['violated-directive'] ?? (reportData as any)['violatedDirective'];

    if (!documentUri || !violatedDirective) {
      logger.warn(
        {
          hasDocumentUri: !!documentUri,
          hasViolatedDirective: !!violatedDirective,
          context: sanitiseContext(context),
        },
        'Ignoring incomplete CSP report',
      );

      return;
    }

    const violation: CSPViolationReport = {
      'document-uri': String(documentUri),
      'violated-directive': String(violatedDirective),
      'blocked-uri': (reportData as any)['blocked-uri'] ?? (reportData as any)['blockedURL'] ?? '',
      'source-file': (reportData as any)['source-file'] ?? (reportData as any)['sourceFile'],
      'line-number': (reportData as any)['line-number'] ?? (reportData as any)['lineNumber'],
      'column-number': (reportData as any)['column-number'] ?? (reportData as any)['columnNumber'],
      'script-sample': (reportData as any)['script-sample'] ?? (reportData as any)['sample'],
      'original-policy': (reportData as any)['original-policy'] ?? (reportData as any)['originalPolicy'] ?? '',
      disposition: (reportData as any).disposition ?? 'enforce',
    };

    logCspViolation(logger, violation, context);
  } catch (processingError) {
    logger.warn(
      {
        error: processingError instanceof Error ? processingError.message : String(processingError),
        bodyType: typeof body,
        context: sanitiseContext(context),
      },
      'CSP report processing failed',
    );
  }
};

export const createCSPReportProcessor = (logger: Logger): CSPReportProcessor => {
  return {
    processReport: (body: unknown, context: CSPViolationContext) => {
      processCSPReport(body, context, logger);
    },
  };
};

/**
 * Fastify plugin for CSP violation reporting
 * Wraps the core CSP processing logic with Fastify-specific concerns
 */
export const cspReportPlugin: FastifyPluginAsync<CSPReportOptions> = fp(
  async (fastify: FastifyInstance, opts: CSPReportOptions) => {
    const { onViolation } = opts;

    if (!opts.path || typeof opts.path !== 'string') throw AppError.badRequest('CSP report path is required and must be a string');

    const logger = createLogger({
      debug: opts.debug,
      context: { service: 'csp-reporting' },
      minLevel: 'info',
    });

    fastify.post(opts.path, async (req: FastifyRequest, reply: FastifyReply) => {
      const context: CSPViolationContext & { __fastifyRequest?: FastifyRequest } = {
        userAgent: req.headers['user-agent'] as string,
        ip: req.ip,
        referer: req.headers.referer as string,
        timestamp: new Date().toISOString(),
        headers: req.headers as Record<string, unknown>,
        __fastifyRequest: req, // onViolation callback
      };

      try {
        processCSPReport(req.body, context, logger);

        const reportData = (req.body as any)?.['csp-report'] || req.body;
        if (onViolation && reportData && typeof reportData === 'object') {
          const documentUri = (reportData as any)['document-uri'] ?? (reportData as any)['documentURL'];
          const violatedDirective = (reportData as any)['violated-directive'] ?? (reportData as any)['violatedDirective'];

          if (documentUri && violatedDirective) {
            const violation: CSPViolationReport = {
              'document-uri': String(documentUri),
              'violated-directive': String(violatedDirective),
              'blocked-uri': (reportData as any)['blocked-uri'] ?? (reportData as any)['blockedURL'] ?? '',
              'source-file': (reportData as any)['source-file'] ?? (reportData as any)['sourceFile'],
              'line-number': (reportData as any)['line-number'] ?? (reportData as any)['lineNumber'],
              'column-number': (reportData as any)['column-number'] ?? (reportData as any)['columnNumber'],
              'script-sample': (reportData as any)['script-sample'] ?? (reportData as any)['sample'],
              'original-policy': (reportData as any)['original-policy'] ?? (reportData as any)['originalPolicy'] ?? '',
              disposition: (reportData as any).disposition ?? 'enforce',
            };

            onViolation(violation, req);
          }
        }
      } catch (err) {
        logger.warn(
          {
            error: err instanceof Error ? err.message : String(err),
          },
          'CSP reporting route failed',
        );
      }

      reply.code(204).send();
    });
  },
  { name: 'taujs-csp-report-plugin' },
);

// HELPERS
export const addCSPReporting = (directives: Record<string, string[]>, reportUri: string): Record<string, string[]> => {
  return {
    ...directives,
    'report-uri': [reportUri],
  };
};

export const addCSPReportingBoth = (directives: Record<string, string[]>, reportUri: string, reportToEndpoint: string): Record<string, string[]> => {
  return {
    ...directives,
    'report-uri': [reportUri],
    'report-to': [reportToEndpoint],
  };
};
