import { Button, Dialog } from '../../../ui/controls';
import '../paint.css';

/** "Rasterize layer?" confirmation shown when painting on a text/shape/fill layer. */
export function RasterizeDialog({
  close,
  layerName,
  kind,
  toolName,
}: {
  close: (ok?: boolean) => void;
  layerName: string;
  kind: string;
  toolName: string;
}) {
  return (
    <Dialog
      title="Rasterize layer?"
      width={380}
      onClose={() => close(false)}
      onSubmit={() => close(true)}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" autoFocus onClick={() => close(true)}>
            Rasterize
          </Button>
        </>
      }
    >
      <p className="paint-dialog-text">
        The {toolName} paints pixels, but <b>“{layerName}”</b> is a {kind} layer. Rasterize it to a pixel layer first?
      </p>
      <p className="paint-dialog-hint">
        Its {kind === 'text' ? 'text will no longer be editable' : `${kind} properties will no longer be editable`}. Layer
        styles and masks are kept.
      </p>
    </Dialog>
  );
}
