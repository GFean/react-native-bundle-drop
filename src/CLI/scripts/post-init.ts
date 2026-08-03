import type { InitProjectOptions } from './aipowered/init-project-config';

/**
 * Kept as the post-config seam used by login/init. Setup is now one
 * project-aware AI-assisted flow instead of separate Metro/native prompts.
 */
export async function runPostInitPrompts(options: InitProjectOptions = {}): Promise<void> {
  await require('./aipowered/init-project-config').initProjectConfigAi(options);
}
