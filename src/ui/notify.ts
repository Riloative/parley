// Which desktop-notification protocol to use, from the config and the terminal.
import type { Config } from '../config/config.js';
import { notifyProtocol, type NotifyProtocol } from '../term/caps.js';

export function notifier(config: Config, env: NodeJS.ProcessEnv = process.env): NotifyProtocol | undefined {
  if (config.notifications === 'off') return undefined;
  if (config.notifications === 'auto') return notifyProtocol(env);
  return config.notifications;
}
