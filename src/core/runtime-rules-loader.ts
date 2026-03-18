import { DEFAULT_RUNTIME_RULES, DEFAULT_RUNTIME_RULES_PATH } from '../policy/default-rules';

export function loadRuntimeRules() {
  return {
    path: DEFAULT_RUNTIME_RULES_PATH,
    text: DEFAULT_RUNTIME_RULES,
  };
}
