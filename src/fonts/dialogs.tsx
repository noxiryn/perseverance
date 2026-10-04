/** Small dialogs of the fonts module. */
import { Button, Dialog } from '../ui/controls';
import { openDialog } from '../state/ui';
import { isFamilyInUse } from './loader';
import { removeUserFamily, useUserFonts } from './userFonts';
import './fonts.css';

function RemoveFontDialog({ close, family }: { close: (ok?: boolean) => void; family: string }) {
  const files = useUserFonts.getState().files.filter((f) => f.family === family);
  const inUse = isFamilyInUse(family);
  return (
    <Dialog
      title="Remove Font"
      width={380}
      onClose={() => close()}
      onSubmit={() => close(true)}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="danger" onClick={() => close(true)}>
            Remove
          </Button>
        </>
      }
    >
      <div className="fc-confirm">
        <p>
          Remove <b style={{ fontFamily: `"${family.replace(/"/g, '')}", var(--font-ui)` }}>{family}</b> from Perseverance?
        </p>
        {files.length > 0 && (
          <p className="fc-dim">
            {files.length === 1 ? files[0].fileName : `${files.length} font files`} will be deleted from the app's font storage
            (the original file on disk is not touched).
          </p>
        )}
        {inUse && <p className="fc-confirm-warn">An open document uses this font — its text will fall back to another font.</p>}
      </div>
    </Dialog>
  );
}

/** Ask, then remove every stored file of a user font family. */
export async function confirmRemoveUserFamily(family: string): Promise<void> {
  const ok = await openDialog<boolean, { family: string }>(RemoveFontDialog, { family });
  if (ok) await removeUserFamily(family);
}
