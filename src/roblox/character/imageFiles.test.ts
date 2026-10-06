import { describe, expect, it } from 'vitest';
import { isReplaceableImage, mayBeReplaceableDrag, sniffImageBytes } from './imageFiles';
import { fileDropHints, registerFileDropHandler, setFileDragInfo } from '../../ui/shell/dropHooks';

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(Math.max(0, 16 - b.length)).fill(0)]).buffer;
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const GIF = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
const BMP = bytes(0x42, 0x4d);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50);
const PSD = bytes(0x38, 0x42, 0x50, 0x53, 0, 1);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>').buffer;
const TIFF = bytes(0x49, 0x49, 0x2a, 0x00);

describe('sniffImageBytes', () => {
  it('recognises the raster formats the decoder reads and PSD projects', () => {
    for (const b of [PNG, JPEG, GIF, BMP, WEBP]) expect(sniffImageBytes(b)).toBe('raster');
    expect(sniffImageBytes(PSD)).toBe('project');
    expect(sniffImageBytes(SVG)).toBeNull();
    expect(sniffImageBytes(TIFF)).toBeNull();
    expect(sniffImageBytes(new ArrayBuffer(0))).toBeNull();
  });
});

describe('isReplaceableImage (drop on a selected character)', () => {
  it('never claims a PSD, even when Chromium reports an image/ MIME type for it', () => {
    expect(isReplaceableImage('poster.psd', 'image/vnd.adobe.photoshop', PSD)).toBe(false);
    expect(isReplaceableImage('poster.psd', 'image/vnd.adobe.photoshop')).toBe(false);
    expect(isReplaceableImage('poster.PSB', '')).toBe(false);
    expect(isReplaceableImage('project.pgfx', '')).toBe(false);
    // A PSD with a misleading extension or none: its bytes decide.
    expect(isReplaceableImage('poster.png', 'image/png', PSD)).toBe(false);
    expect(isReplaceableImage('poster', 'image/vnd.adobe.photoshop', PSD)).toBe(false);
  });

  it('does not claim SVG / TIFF (the decoder cannot read them as a render)', () => {
    expect(isReplaceableImage('logo.svg', 'image/svg+xml', SVG)).toBe(false);
    expect(isReplaceableImage('logo.svg', 'image/svg+xml')).toBe(false);
    expect(isReplaceableImage('scan.tif', 'image/tiff', TIFF)).toBe(false);
    expect(isReplaceableImage('scan.tiff', 'image/tiff')).toBe(false);
    expect(isReplaceableImage('noext', 'image/svg+xml')).toBe(false);
  });

  it('claims PNG / JPEG / WebP / GIF / BMP renders', () => {
    expect(isReplaceableImage('avatar.png', 'image/png', PNG)).toBe(true);
    expect(isReplaceableImage('avatar.JPG', '', JPEG)).toBe(true);
    expect(isReplaceableImage('a.webp', 'image/webp', WEBP)).toBe(true);
    expect(isReplaceableImage('a.gif', '', GIF)).toBe(true);
    expect(isReplaceableImage('a.bmp', '', BMP)).toBe(true);
    // Bytes win over an odd extension; without bytes the extension / raster MIME decides.
    expect(isReplaceableImage('render.image', '', PNG)).toBe(true);
    expect(isReplaceableImage('C:\\renders.v2\\avatar.jpeg')).toBe(true);
    expect(isReplaceableImage('clipboard', 'image/png')).toBe(true);
    expect(isReplaceableImage('notes.txt', 'text/plain')).toBe(false);
  });
});

describe('drag hint (only MIME types are known while dragging)', () => {
  it('no Replace hint when every dragged file is a known non-raster type (PSD, SVG, TIFF, application/…)', () => {
    expect(mayBeReplaceableDrag(['image/vnd.adobe.photoshop'])).toBe(false);
    expect(mayBeReplaceableDrag(['image/svg+xml'])).toBe(false);
    expect(mayBeReplaceableDrag(['image/tiff'])).toBe(false);
    expect(mayBeReplaceableDrag(['application/octet-stream'])).toBe(false);
    expect(mayBeReplaceableDrag(['image/vnd.adobe.photoshop', 'image/svg+xml'])).toBe(false);
  });

  it('keeps it for rasters, an empty type (Windows without a registration) or unknown types', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']) expect(mayBeReplaceableDrag([t]), t).toBe(true);
    expect(mayBeReplaceableDrag([''])).toBe(true);
    expect(mayBeReplaceableDrag([])).toBe(true);
    expect(mayBeReplaceableDrag(['image/vnd.adobe.photoshop', 'image/png'])).toBe(true);
  });

  it('the drop overlay passes the dragged types to the hints', () => {
    const off = registerFileDropHandler({ id: 'test.hint', claim: () => false, hint: (d) => (mayBeReplaceableDrag(d.types) ? 'replace' : null) });
    try {
      setFileDragInfo({ types: ['image/vnd.adobe.photoshop'] });
      expect(fileDropHints()).not.toContain('replace');
      setFileDragInfo({ types: ['image/png'] });
      expect(fileDropHints()).toContain('replace');
    } finally {
      off();
      setFileDragInfo({ types: [] });
    }
  });
});
