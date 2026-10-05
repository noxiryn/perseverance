/**
 * Renderer module entry (imported by src/features.ts): registers the layer effects and the
 * cache lifecycle hooks. The compositor itself is used through src/render/compositor.ts.
 */
import { registerEffects } from './effects';
import { installCacheLifecycle } from './lifecycle';

registerEffects();
installCacheLifecycle();

export {};
