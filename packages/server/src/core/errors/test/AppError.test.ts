// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { AppError, normaliseError, toReason } from '../../core/errors/AppError';

describe('AppError – constructor & basics', () => {
  it('sets name, kind, httpStatus (defaults), details, safeMessage, code', () => {
    const err = new AppError('boom', 'infra', { details: { a: 1 }, code: 'E_X' });
    expect(err.name).toBe('AppError');
    expect(err.kind).toBe('infra');
    expect(err.httpStatus).toBe(500);
    expect(err.details).toEqual({ a: 1 });
    expect(err.safeMessage).toBe('Internal Server Error');
    expect(err.code).toBe('E_X');
    expect(err).toBeInstanceOf(Error);
  });

  it('respects explicit httpStatus override', () => {
    const err = new AppError('custom', 'infra', { httpStatus: 503 });
    expect(err.httpStatus).toBe(503);
  });

  it('getSafeMessage returns original for domain/validation/auth', () => {
    expect(new AppError('not found', 'domain').safeMessage).toBe('not found');
    expect(new AppError('bad', 'validation').safeMessage).toBe('bad');
    expect(new AppError('denied', 'auth').safeMessage).toBe('denied');
  });

  it('cause is defined and non-enumerable', () => {
    const cause = new Error('root cause');
    const err = new AppError('wrap', 'infra', { cause });
    expect((err as any).cause).toBe(cause);
    expect(Object.keys(err)).not.toContain('cause');
  });
});

describe('AppError – static helpers', () => {
  it('notFound / forbidden / badRequest / unprocessable set expected kinds and status', () => {
    const nf = AppError.notFound('nope');
    expect(nf.kind).toBe('domain');
    expect(nf.httpStatus).toBe(404);

    const fb = AppError.forbidden('nope');
    expect(fb.kind).toBe('auth');
    expect(fb.httpStatus).toBe(403);

    const br = AppError.badRequest('bad');
    expect(br.kind).toBe('validation');
    expect(br.httpStatus).toBe(400);

    const unp = AppError.unprocessable('bad');
    expect(unp.kind).toBe('validation');
    expect(unp.httpStatus).toBe(422);
  });

  it('timeout / canceled map to their statuses', () => {
    const t = AppError.timeout('late');
    expect(t.kind).toBe('timeout');
    expect(t.httpStatus).toBe(504);

    const c = AppError.canceled('bye');
    expect(c.kind).toBe('canceled');
    expect(c.httpStatus).toBe(499);
  });

  it('internal / upstream set infra/upstream and keep cause', () => {
    const cause = new Error('up');
    const i = AppError.internal('x', cause, { foo: 1 });
    expect(i.kind).toBe('infra');
    expect(i.httpStatus).toBe(500);
    expect(i.cause).toBe(cause);
    expect(i.details).toEqual({ foo: 1 });

    const u = AppError.upstream('y', cause, { bar: 2 });
    expect(u.kind).toBe('upstream');
    expect(u.httpStatus).toBe(502);
    expect(u.cause).toBe(cause);
    expect(u.details).toEqual({ bar: 2 });
  });

  it('serviceUnavailable maps to 503', () => {
    const e = AppError.serviceUnavailable('down');
    expect(e.kind).toBe('infra');
    expect(e.httpStatus).toBe(503);
  });

  it('from returns the same AppError, or wraps others with internal', () => {
    const original = AppError.badRequest('bad');
    expect(AppError.from(original)).toBe(original);

    const other = new Error('nope');
    const wrapped = AppError.from(other);
    expect(wrapped).toBeInstanceOf(AppError);
    expect(wrapped.kind).toBe('infra');
    expect(wrapped.cause).toBe(other);
    expect(wrapped.message).toBe('nope');
  });

  it('from uses fallback when other has no message', () => {
    const wrapped = AppError.from({} as any, 'Internal error');
    expect(wrapped.message).toBe('Internal error');
  });
});

describe('AppError – toJSON & serialiseValue', () => {
  it('serialises primitive fields and omits code when undefined', () => {
    const e = new AppError('boom', 'infra', { details: { a: 1 } });
    const j = e.toJSON();
    expect(j).toMatchObject({
      name: 'AppError',
      kind: 'infra',
      message: 'boom',
      safeMessage: 'Internal Server Error',
      httpStatus: 500,
      details: { a: 1 },
    });
    expect('code' in j).toBe(false);
  });

  it('includes code when provided', () => {
    const e = new AppError('boom', 'infra', { code: 'E_X' });
    const j = e.toJSON();
    expect(j.code).toBe('E_X');
  });

  it('serialses nested Error and AppError details including their fields', () => {
    const nested = new Error('child');
    const nestedApp = AppError.badRequest('bad child', { x: 1 }, 'C_CODE');
    const parent = new AppError('parent', 'infra', { details: { nested, nestedApp } });
    const j = parent.toJSON();

    expect(j.details).toMatchObject({
      nested: { name: 'Error', message: 'child' },
      nestedApp: {
        name: 'AppError',
        message: 'bad child',
        kind: 'validation',
        httpStatus: 400,
        code: 'C_CODE',
      },
    });
  });

  it('serialses cause via toJSON with Error shape', () => {
    const cause = new Error('root');
    const e = new AppError('top', 'infra', { cause });
    const j = e.toJSON();
    expect(j).toHaveProperty('cause');
    expect(j.cause).toMatchObject({ name: 'Error', message: 'root' });
  });

  it('handles arrays and circular references in details', () => {
    const a: any = { id: 1 };
    const b: any = { ref: a };
    a.self = a; // circular
    a.list = [a, b]; // array containing circular + object

    const e = new AppError('x', 'infra', { details: a });
    const j = e.toJSON();

    // array preserved and circulars marked
    expect(Array.isArray((j.details as any).list)).toBe(true);
    const [first, second] = (j.details as any).list as any[];
    expect(first).toBe('[circular]');
    expect(second).toEqual({ ref: '[circular]' });
    expect((j.details as any).self).toBe('[circular]');
  });
});

describe('normaliseError', () => {
  it.each([
    { label: 'Error', val: new Error('boom'), exp: { name: 'Error', msg: 'boom' } },
    { label: 'string', val: 'aborted', exp: { name: 'Error', msg: 'aborted' } },
    { label: 'number', val: 404, exp: { name: 'Error', msg: '404' } },
    { label: 'object with message', val: { message: 'socket hang up' }, exp: { name: 'Error', msg: 'socket hang up' } },
    { label: 'object without message', val: { foo: 1 }, exp: { name: 'Error', msg: '[object Object]' } },
    { label: 'null', val: null, exp: { name: 'Error', msg: 'null' } },
    { label: 'undefined', val: undefined, exp: { name: 'Error', msg: 'undefined' } },
    { label: 'symbol', val: Symbol('x'), exp: { name: 'Error', msg: 'Symbol(x)' } },
    { label: 'array', val: [1, 2], exp: { name: 'Error', msg: '1,2' } },
  ])('produces stable shape for $label', ({ val, exp }) => {
    const out = normaliseError(val);
    expect(out.name).toBe(exp.name);
    expect(out.message).toBe(exp.msg);
    if (val instanceof Error) expect(out.stack).toMatch(/Error: boom/);
  });
});

describe('toReason', () => {
  it.each([
    { label: 'Error', val: new Error('boom'), msg: 'boom' },
    { label: 'string', val: 'aborted', msg: 'aborted' },
    { label: 'number', val: 404, msg: '404' },
    { label: 'object with message', val: { message: 'socket hang up' }, msg: 'socket hang up' },
    { label: 'object without message', val: { foo: 1 }, msg: '[object Object]' },
    { label: 'null', val: null, msg: 'null' },
    { label: 'undefined', val: undefined, msg: 'Unknown render error' },
  ])('returns an Error for $label', ({ val, msg }) => {
    const err = toReason(val);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(msg);
  });
});
