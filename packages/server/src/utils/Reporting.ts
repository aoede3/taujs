// @taujs/server/security/reporting.ts
// Framework-agnostic CSP violation report processing

import type { FastifyPluginAsync, FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import { ServiceError } from '../utils/ServiceError';
import { Logger } from '../utils/Logger';

import type { DebugConfig, Logs } from '../utils/Logger';

/**
 * CSP Violation Report (normalized union of legacy and modern shapes)
 * Matches the fields commonly sent by browsers, normalized to the legacy names.
 */
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
  isDebug?: DebugConfig;
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
 * Minimal/safe context projection for logging (avoid dumping full headers)
 */
function sanitizeContext(ctx: CSPViolationContext) {
  return {
    userAgent: ctx.userAgent,
    ip: ctx.ip,
    referer: ctx.referer,
    timestamp: ctx.timestamp,
    // If you *really* want headers in logs, make it an explicit decision:
    // headers: ctx.headers,
  };
}

function logCspViolation(logger: Logs, report: CSPViolationReport, context: CSPViolationContext) {
  logger.warn('CSP Violation', {
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
  });
}

export const processCSPReport = (body: unknown, context: CSPViolationContext, logger: Logs): void => {
  try {
    // Handle legacy: { "csp-report": { ... } } and modern: { "documentURL": ... }
    const reportData = (body as any)?.['csp-report'] || body;

    if (!reportData || typeof reportData !== 'object') {
      logger.warn('Ignoring malformed CSP report', {
        bodyType: typeof body,
        context: sanitizeContext(context),
      });

      return;
    }

    const documentUri = (reportData as any)['document-uri'] ?? (reportData as any)['documentURL'];
    const violatedDirective = (reportData as any)['violated-directive'] ?? (reportData as any)['violatedDirective'];

    if (!documentUri || !violatedDirective) {
      logger.warn('Ignoring incomplete CSP report', {
        hasDocumentUri: !!documentUri,
        hasViolatedDirective: !!violatedDirective,
        context: sanitizeContext(context),
      });

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
    logger.warn('CSP report processing failed', {
      error: processingError instanceof Error ? processingError.message : String(processingError),
      bodyType: typeof body,
      context: sanitizeContext(context),
    });
  }
};

/**
 * Factory for creating CSP report handlers for any runtime
 * Returns a function that can be called with request data
 */
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
    const { path, isDebug, logger: providedLogger, onViolation } = opts;

    if (!path || typeof path !== 'string') throw ServiceError.badRequest('CSP report path is required and must be a string');

    // Choose the active logger: provided instance or a fresh instance.
    const baseLogger = providedLogger ?? new Logger();
    if (isDebug !== undefined) baseLogger.configure(isDebug);

    // Derive a scoped logger for this plugin/component
    const logger = baseLogger.child({ component: 'csp-reporting' });

    fastify.post(path, async (req: FastifyRequest, reply: FastifyReply) => {
      // Build context object from Fastify request
      const context: CSPViolationContext & { __fastifyRequest?: FastifyRequest } = {
        userAgent: req.headers['user-agent'] as string,
        ip: req.ip,
        referer: req.headers.referer as string,
        timestamp: new Date().toISOString(),
        headers: req.headers as Record<string, unknown>,
        __fastifyRequest: req, // Attach request for onViolation callback
      };

      try {
        // Run processing (logs violation or warns on malformed input)
        processCSPReport(req.body, context, logger);

        // If caller wants a custom hook and we have a valid-ish payload, try to call it:
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
        logger.warn('CSP reporting route failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Always return 204 - browsers expect this for CSP reports
      reply.code(204).send();
    });
  },
  { name: 'taujs-csp-report-plugin' },
);

/**
 * Helper to add report-uri directive to CSP directives
 */
export const addCSPReporting = (directives: Record<string, string[]>, reportUri: string): Record<string, string[]> => {
  return {
    ...directives,
    'report-uri': [reportUri],
  };
};

/**
 * Helper to add both report-uri and report-to for maximum browser compatibility
 */
export const addCSPReportingBoth = (directives: Record<string, string[]>, reportUri: string, reportToEndpoint: string): Record<string, string[]> => {
  return {
    ...directives,
    'report-uri': [reportUri],
    'report-to': [reportToEndpoint],
  };
};
