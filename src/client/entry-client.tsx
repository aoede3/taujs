import React from 'react';
import { hydrateApp } from '@taujs/server/data';

import AppBootstrap from './AppBootstrap';

const sheepShit = 'LOVE ME T';

const moob = sheepShit;

hydrateApp({ appComponent: <AppBootstrap />, debug: true });
