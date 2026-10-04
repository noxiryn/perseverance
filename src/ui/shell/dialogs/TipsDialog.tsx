/** Help ▸ "Make your first Roblox thumbnail" — interactive step-by-step guide. */
import { useState, type ComponentType } from 'react';
import { ArrowLeft, ArrowRight, Check, Download, Eye, Image as ImageIcon, Layers, Monitor, PersonStanding, Sparkles, Type } from 'lucide-react';
import { Button, Dialog } from '../../controls';
import { commands, runCommand } from '../../../registry';
import { useEditor } from '../../../state/editor';
import { toast } from '../../../state/ui';
import { createBlankDocument } from '../documents';
import { revealPanel } from '../workspaces';
import { Keys } from '../Keys';

interface Step {
  title: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  body: string;
  tip?: { text: string; keys?: string };
  action?: { label: string; run: () => void; available?: () => boolean };
}

const has = (id: string) => commands.has(id);
const needDoc = () => !!useEditor.getState().activeDocId;

const showPanel = (id: string) => revealPanel(id);

const STEPS: Step[] = [
  {
    title: 'Create a 1920×1080 canvas',
    icon: Monitor,
    body: 'Roblox experience thumbnails are 16:9. Start from a blank 1920×1080 document — or pick a ready-made template (gothic poster, noir newspaper, crimson film…) from File ▸ New from Template.',
    action: {
      label: 'New Thumbnail',
      run: () => (has('roblox.newThumbnail') ? runCommand('roblox.newThumbnail') : createBlankDocument('Roblox Thumbnail', 1920, 1080)),
    },
  },
  {
    title: 'Add your character',
    icon: PersonStanding,
    body: 'Open the Pose Studio to pose an R6/R15 avatar with toon lighting and a rim light, or import an OBJ/GLB exported from Roblox Studio. The render lands on its own layer with a transparent background.',
    tip: { text: 'Already have a render? Drop the PNG onto the window to place it as a layer.' },
    action: { label: 'Open Pose Studio', run: () => runCommand('roblox.poseStudio'), available: () => has('roblox.poseStudio') && needDoc() },
  },
  {
    title: 'Build the background',
    icon: ImageIcon,
    body: 'Use the Libraries panel for smoke, sunburst rays, paper textures, newspaper clippings and torn borders. Every asset is procedural — tweak its parameters any time from the Properties panel.',
    action: { label: 'Show Libraries', run: () => showPanel('libraries') },
  },
  {
    title: 'Give it a look',
    icon: Sparkles,
    body: 'One-click Looks combine gradient maps, halftone, grain and overlays into a cohesive style — Crimson Film, Noir Newspaper, Sunburst Halftone, Gothic Paper and more. Select your character layer first to stylize it.',
    action: { label: 'Show Looks', run: () => showPanel('looks') },
  },
  {
    title: 'Add a bold title',
    icon: Type,
    body: 'Press T and click on the canvas. Condensed fonts like Anton or Bebas Neue read well at small sizes; blackletter fonts give the gothic poster vibe. Add a stroke or drop shadow from the Effects panel.',
    tip: { text: 'Type tool', keys: 'T' },
    action: { label: 'Show Character panel', run: () => showPanel('character') },
  },
  {
    title: 'Check it at real size',
    icon: Eye,
    body: 'Thumbnails are often seen tiny. Preview your design on mock Roblox game cards (dark and light) and turn on safe zones so important details are not cropped.',
    action: { label: 'Roblox Preview', run: () => runCommand('roblox.preview'), available: () => has('roblox.preview') && needDoc() },
  },
  {
    title: 'Organize & export',
    icon: Download,
    body: 'Keep layers named and grouped (Ctrl+G) so you can reuse the file. Export a PNG at 1920×1080 with File ▸ Export As, and save the .pgfx project to edit later.',
    tip: { text: 'Export As', keys: 'Alt+Shift+Ctrl+W' },
    action: { label: 'Export…', run: () => runCommand('file.export'), available: () => has('file.export') && needDoc() },
  },
];

export function TipsDialog({ close }: { close: (r?: unknown) => void }) {
  const [i, setI] = useState(0);
  const step = STEPS[i];
  const Icon = step.icon;
  const avail = step.action ? (step.action.available ? step.action.available() : true) : false;
  return (
    <Dialog
      title="Make your first Roblox thumbnail"
      onClose={() => close()}
      width={620}
      footer={
        <>
          <span className="shell-tips-count">
            Step {i + 1} of {STEPS.length}
          </span>
          <span style={{ flex: 1 }} />
          <Button icon={ArrowLeft} disabled={i === 0} onClick={() => setI(i - 1)}>
            Back
          </Button>
          {i < STEPS.length - 1 ? (
            <Button variant="primary" onClick={() => setI(i + 1)}>
              Next <ArrowRight size={13} />
            </Button>
          ) : (
            <Button variant="primary" icon={Check} onClick={() => close()}>
              Done
            </Button>
          )}
        </>
      }
    >
      <div className="shell-tips-layout">
        <ol className="shell-tips-steps">
          {STEPS.map((s, k) => (
            <li key={k} className={k === i ? 'active' : k < i ? 'done' : ''} onClick={() => setI(k)}>
              <span className="n">{k < i ? <Check size={10} strokeWidth={3} /> : k + 1}</span>
              {s.title}
            </li>
          ))}
        </ol>
        <div className="shell-tips-detail">
          <div className="shell-tips-icon">
            <Icon size={22} strokeWidth={1.5} />
          </div>
          <h3>{step.title}</h3>
          <p>{step.body}</p>
          {step.tip && (
            <div className="shell-tips-tip">
              <Layers size={12} /> {step.tip.text} {step.tip.keys && <Keys shortcut={step.tip.keys} />}
            </div>
          )}
          {step.action && (
            <Button
              variant="primary"
              disabled={!avail}
              title={avail ? undefined : needDoc() ? 'Not available yet' : 'Create a document first'}
              onClick={() => {
                try {
                  step.action!.run();
                  close();
                } catch (e) {
                  toast(String((e as Error)?.message ?? e), 'error');
                }
              }}
            >
              {step.action.label}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
