import { z } from 'zod';

import type { DevJson, EpisodeRecord, LogAnnexRecord } from './types';

// Zod schemas for the on-disk shapes declared in types.ts. Each is annotated as z.ZodType<...>
// so a schema that drifts from its type - missing a field the type declares - fails `tsc`, not a
// runtime surprise discovered later. Every object level is loose (z.looseObject / .loose()): the
// substrate spec permits additive-optional fields (spec 03 §4/§5), and this reader must never
// count a future field as malformed.

export const DevJsonSchema: z.ZodType<DevJson> = z.looseObject({
  // Non-empty: the bootId is the filter that keeps a previous boot's records out of this boot's
  // answers, and an empty string must not be able to weaken it.
  bootId: z.string().min(1),
  token: z.string(),
  pid: z.number().int().positive(),
  startedAt: z.string(),
  host: z.string().nullable(),
  port: z.number().nullable(),
  graph: z.string(),
  episodes: z.string(),
  logs: z.string(),
  observations: z.string(),
});

const ServiceCallSchema = z.looseObject({
  service: z.string(),
  method: z.string(),
  ms: z.number(),
  ok: z.boolean(),
});

const UrlSchema = z.looseObject({
  pathname: z.string(),
  queryKeys: z.array(z.string()),
  queryValuesRedacted: z.literal(true),
});

const TimelineSchema = z.looseObject({
  matched: z.number().optional(),
  dataStart: z.number().optional(),
  dataEnd: z.number().optional(),
  head: z.number().optional(),
  shellReady: z.number().optional(),
  allReady: z.number().optional(),
});

const DeferredEntrySchema = z.looseObject({
  key: z.string(),
  outcome: z.enum(['complete', 'failed', 'aborted']),
  ms: z.number(),
});

const ClientSchema = z.looseObject({
  hydrated: z.boolean(),
  hydrationMs: z.number().nullable(),
  error: z.string().nullable(),
});

const ErrorSchema = z.looseObject({
  kind: z.string(),
  message: z.string(),
});

export const EpisodeRecordSchema: z.ZodType<EpisodeRecord> = z.looseObject({
  requestId: z.string(),
  bootId: z.string(),
  at: z.string(),
  route: z.string().nullable(),
  appId: z.string().nullable(),
  mode: z.enum(['ssr', 'streaming', 'fallthrough']).nullable(),
  outcome: z.enum(['complete', 'failed', 'aborted']),
  status: z.number().nullable(),
  url: UrlSchema,
  timeline: TimelineSchema,
  serviceCalls: z.array(ServiceCallSchema),
  deferredData: z.array(DeferredEntrySchema).optional(),
  client: ClientSchema.nullable(),
  error: ErrorSchema.nullable(),
});

export const LogAnnexRecordSchema: z.ZodType<LogAnnexRecord> = z.looseObject({
  requestId: z.string(),
  bootId: z.string(),
  at: z.string(),
  level: z.enum(['info', 'warn', 'error']),
  msg: z.string(),
  meta: z.unknown().optional(),
});
