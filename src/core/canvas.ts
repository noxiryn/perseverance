/** Canvas helpers. The app targets Chromium (Electron), so modern canvas APIs are available. */

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type Ctx2D = CanvasRenderingContext2D;

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

export function ctx2d(c: HTMLCanvasElement, opts?: CanvasRenderingContext2DSettings): Ctx2D {
  const ctx = c.getContext('2d', { willReadFrequently: false, ...opts });
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

/** Context that is optimized for frequent getImageData (CPU-backed). */
export function ctxRead(c: HTMLCanvasElement): Ctx2D {
  return ctx2d(c, { willReadFrequently: true });
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = createCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

export function canvasFromImageData(img: ImageData): HTMLCanvasElement {
  const c = createCanvas(img.width, img.height);
  ctx2d(c).putImageData(img, 0, 0);
  return c;
}

export function getImageData(c: HTMLCanvasElement, x = 0, y = 0, w = c.width, h = c.height): ImageData {
  return ctx2d(c).getImageData(x, y, w, h);
}

export function clearCanvas(c: HTMLCanvasElement) {
  const ctx = ctx2d(c);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.restore();
}

export async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src.slice(0, 80)}`));
    img.src = src;
  });
}

export async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(blob);
  const c = createCanvas(bmp.width, bmp.height);
  ctx2d(c).drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality),
  );
}

/** Bounding box of non-transparent pixels (alpha > threshold), or null if empty. */
export function opaqueBounds(c: HTMLCanvasElement, threshold = 0): { x: number; y: number; width: number; height: number } | null {
  const { width, height } = c;
  const data = ctxRead(c).getImageData(0, 0, width, height).data;
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

let checkerPattern: CanvasPattern | null = null;
/** Transparency checkerboard pattern for a given context. */
export function checkerboard(ctx: Ctx2D, size = 8, light = '#ffffff', dark = '#e3e3e3'): CanvasPattern {
  if (checkerPattern) return checkerPattern;
  const c = createCanvas(size * 2, size * 2);
  const g = ctx2d(c);
  g.fillStyle = light;
  g.fillRect(0, 0, size * 2, size * 2);
  g.fillStyle = dark;
  g.fillRect(0, 0, size, size);
  g.fillRect(size, size, size, size);
  checkerPattern = ctx.createPattern(c, 'repeat')!;
  return checkerPattern;
}
