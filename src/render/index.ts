/**
 * Renderer module entry (imported by src/features.ts): registers the layer effects. The
 * compositor itself is used through src/render/compositor.ts.
 */
import { registerEffects } from './effects';

registerEffects();

export {};
