/**
 * τjs [ taujs ] Orchestration System
 * (c) 2024-present Aoede Ltd
 * Author: John Smith
 *
 * Licensed under the MIT License - attribution appreciated.
 * Part of the τjs [ taujs ] system for declarative, build-time orchestration of microfrontend applications,
 * including CSR, SSR, streaming, and middleware composition.
 */

import type { CoreTaujsConfig } from './types';

export { callServiceMethod, defineService, defineServiceRegistry, withDeadline } from '../services/DataServices';

export type { RegistryCaller, ServiceContext } from '../services/DataServices';

export { AppError } from '../errors/AppError';

export function defineConfig<const C>(config: C & CoreTaujsConfig): C {
  if (!config.apps || config.apps.length === 0) throw new Error('At least one app must be configured');
  return config;
}
