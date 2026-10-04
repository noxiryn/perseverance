/** Document composite used as the Pose Studio / importer preview backdrop. */
import { activeDoc } from '../../state/editor';
import { renderDocument } from '../../render/compositor';

export function documentBackdrop(excludeLayerId?: string | null, maxSide = 1280): string | null {
  const doc = activeDoc();
  if (!doc) return null;
  try {
    const scale = Math.min(1, maxSide / Math.max(doc.width, doc.height));
    const c = renderDocument(doc, {
      scale,
      background: true,
      hidden: excludeLayerId ? new Set([excludeLayerId]) : undefined,
    });
    return c.toDataURL('image/png');
  } catch (err) {
    console.warn('Pose Studio: could not render document backdrop', err);
    return null;
  }
}
