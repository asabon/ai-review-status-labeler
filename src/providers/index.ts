import { ProviderAdapter } from '../types.js';
import { CodeRabbitProvider } from './coderabbit.js';

const PROVIDERS: Record<string, () => ProviderAdapter> = {
  coderabbit: () => new CodeRabbitProvider(),
};

export function getProvider(name: string): ProviderAdapter {
  const normalized = name.trim().toLowerCase();
  const factory = PROVIDERS[normalized];
  if (!factory) {
    const supported = Object.keys(PROVIDERS).join(', ');
    throw new Error(`Unsupported provider "${name}". Supported providers: ${supported}`);
  }
  return factory();
}

