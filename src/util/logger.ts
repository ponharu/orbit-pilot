import type { Logger } from '../core/types';

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, message: string, context?: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...context,
  };

  console.log(JSON.stringify(payload));
}

export function createLogger(baseContext: Record<string, unknown> = {}): Logger {
  return {
    debug(message, context) {
      emit('debug', message, { ...baseContext, ...context });
    },
    info(message, context) {
      emit('info', message, { ...baseContext, ...context });
    },
    warn(message, context) {
      emit('warn', message, { ...baseContext, ...context });
    },
    error(message, context) {
      emit('error', message, { ...baseContext, ...context });
    },
  };
}
