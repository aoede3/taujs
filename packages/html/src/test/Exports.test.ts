import { describe, expect, it } from 'vitest';

import * as pkg from '../index';
import * as client from '../client';

describe('@taujs/html export hygiene', () => {
  it('the package root exports exactly createRenderer at runtime', () => {
    expect(Object.keys(pkg)).toEqual(['createRenderer']);
  });

  it('the client module exports exactly onDataReady at runtime', () => {
    expect(Object.keys(client)).toEqual(['onDataReady']);
  });

  it('the deferred carrier name is not reachable from any exported value on either module', () => {
    for (const value of [...Object.values(pkg), ...Object.values(client)]) {
      if (typeof value === 'string') expect(value).not.toContain('__TAUJS_DEFERRED_STATE__');
    }
  });
});
