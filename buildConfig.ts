import { pluginReact } from '@taujs/react/plugin';

export const configs = [
  { appId: 'root', entryPoint: '', plugins: [pluginReact()] },
  { appId: 'mfe', entryPoint: '@admin', plugins: [pluginReact()] },
];
