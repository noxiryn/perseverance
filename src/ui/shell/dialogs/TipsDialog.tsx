/**
 * Help ▸ "Make your first Roblox thumbnail" — interactive step-by-step guide.
 *
 * Running a step's action closes the guide so the user can do the step; reopening it (title-bar
 * lightbulb, Help menu) resumes at the next step. The current step is remembered in localStorage;
 * "Done" starts over next time. With no document open, a remembered step that needs a canvas starts
 * over at step 1, and the start screen's "Make a Roblox thumbnail" always starts at step 1.
 */
import { useState, type ComponentType } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CloudDownload,
  Download,
  Eye,
  Image as ImageIcon,
  Layers,
  LayoutTemplate,
  Monitor,
  Palette,
  PersonStanding,
  Scissors,
  Sparkles,
  SquareDashed,
  Type,
} from 'lucide-react';
import { Button, Dialog } from '../../controls';
import { commands, runCommand } from '../../../registry';
import { useEditor } from '../../../state/editor';
import { openDialog, toast, useUI } from '../../../state/ui';
import { createBlankDocument } from '../documents';
import { revealPanel } from '../workspaces';
import { Keys } from '../Keys';

type IconType = ComponentType<{ size?: number; strokeWidth?: number }>;

interface StepAction {
  label: string;
  icon?: IconType;
  run: () => void;
  available?: () => boolean;
}

interface Step {
  title: string;
  icon: IconType;
  body: string;
  tip?: { text: string; keys?: string };
  /** First action is the primary one. */
  actions?: StepAction[];
  /** Only makes sense with a canvas open (resuming here without a document starts over). */
  needsDoc?: boolean;
}

const has = (id: string) => commands.has(id);
const needDoc = () => !!useEditor.getState().activeDocId;

const showPanel = (id: string) => revealPanel(id);

export const TIPS_STEPS: Step[] = [
  {
    title: 'Create a 1920×1080 canvas',
    icon: Monitor,
    body: 'Roblox experience thumbnails are 16:9. Start from a blank 1920×1080 document — or pick a ready-made template (gothic poster, noir newspaper, crimson film…) and swap in your own character.',
    actions: [
      {
        label: 'New Roblox Thumbnail',
        icon: Monitor,
        run: () => (has('roblox.newThumbnail') ? runCommand('roblox.newThumbnail') : createBlankDocument('Roblox Thumbnail', 1920, 1080)),
      },
      { label: 'Browse Templates', icon: LayoutTemplate, run: () => runCommand('file.newFromTemplate'), available: () => has('file.newFromTemplate') },
    ],
  },
  {
    title: 'Add your character',
    icon: PersonStanding,
    body: 'Open the Pose Studio to pose an R6/R15 avatar with toon lighting and a rim light, fetch an avatar by username, or import an OBJ/GLB exported from Roblox Studio. The render lands on its own layer with a transparent background.',
    tip: { text: 'Already have a render? Drop the PNG onto the window to place it as a layer — or, in a template, select the placeholder character and use Roblox ▸ Replace Character… (or drop it on the canvas) to swap it in.' },
    actions: [
      { label: 'Open Pose Studio', icon: PersonStanding, run: () => runCommand('roblox.poseStudio'), available: () => has('roblox.poseStudio') },
      { label: 'Fetch Roblox Avatar', icon: CloudDownload, run: () => runCommand('roblox.fetchAvatar'), available: () => has('roblox.fetchAvatar') },
    ],
  },
  {
    title: 'Cut out & style the character',
    needsDoc: true,
    icon: Scissors,
    body: 'Render or screenshot on a solid backdrop? Remove Background cuts it out (auto, color key or green screen). Then the Character Styler adds rim light, toon shading, an outline and a top shade in one place.',
    actions: [
      { label: 'Remove Background', icon: Scissors, run: () => runCommand('roblox.removeBackground'), available: () => has('roblox.removeBackground') && needDoc() },
      { label: 'Character Styler', icon: Palette, run: () => showPanel('roblox') },
    ],
  },
  {
    title: 'Build the background',
    needsDoc: true,
    icon: ImageIcon,
    body: 'Use the Libraries panel for smoke, sunburst rays, paper textures, newspaper clippings and torn borders. Every asset is procedural — tweak its parameters any time from the Properties panel.',
    actions: [{ label: 'Show Libraries', icon: ImageIcon, run: () => showPanel('libraries') }],
  },
  {
    title: 'Give it a look',
    needsDoc: true,
    icon: Sparkles,
    body: 'One-click Looks combine gradient maps, halftone, grain and overlays into a cohesive style — Crimson Film, Noir Newspaper, Sunburst Halftone, Gothic Paper and more. Select your character layer first to stylize it.',
    actions: [{ label: 'Show Looks', icon: Sparkles, run: () => showPanel('looks') }],
  },
  {
    title: 'Add a bold title',
    needsDoc: true,
    icon: Type,
    body: 'Press T and click on the canvas. Condensed fonts like Anton or Bebas Neue read well at small sizes; blackletter fonts give the gothic poster vibe. Add a stroke or drop shadow from the Effects panel.',
    tip: { text: 'Type tool', keys: 'T' },
    actions: [{ label: 'Show Character panel', icon: Type, run: () => showPanel('character') }],
  },
  {
    title: 'Check it at real size',
    needsDoc: true,
    icon: Eye,
    body: 'Thumbnails are often seen tiny. Preview your design on mock Roblox game cards (dark and light) and turn on safe zones so important details are not cropped.',
    actions: [
      { label: 'Roblox Preview', icon: Eye, run: () => runCommand('roblox.preview'), available: () => has('roblox.preview') && needDoc() },
      {
        label: 'Roblox Safe Zones',
        icon: SquareDashed,
        run: () => {
          if (!commands.get('roblox.safeZones')?.checked?.()) runCommand('roblox.safeZones');
        },
        available: () => has('roblox.safeZones') && needDoc(),
      },
    ],
  },
  {
    title: 'Organize & export',
    needsDoc: true,
    icon: Download,
    body: 'Keep layers named and grouped (Ctrl+G) so you can reuse the file. Export a PNG at 1920×1080 with File ▸ Export As, and save the .pgfx project to edit later.',
    tip: { text: 'Export As', keys: 'Alt+Shift+Ctrl+W' },
    actions: [{ label: 'Export…', icon: Download, run: () => runCommand('file.export'), available: () => has('file.export') && needDoc() }],
  },
];

export const TIPS_STEP_KEY = 'perseverance.tips.step';

/** Sanitize a stored step index. */
export function resumeStep(raw: unknown, count: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < count ? n : 0;
}

/** Step to reopen at after running step `i`'s action (the next one; the last stays put). */
export function stepAfterAction(i: number, count: number): number {
  return Math.min(i + 1, count - 1);
}

/**
 * Step the guide opens at: the remembered one, except that a step needing a canvas starts over
 * when no document is open (there is nothing to cut out, style or export yet), and `restart`
 * (start screen) always begins at the first step.
 */
export function initialStep(raw: unknown, steps: readonly { needsDoc?: boolean }[], hasDoc: boolean, restart = false): number {
  if (restart) return 0;
  const saved = resumeStep(raw, steps.length);
  return !hasDoc && steps[saved]?.needsDoc ? 0 : saved;
}

function readStep(restart: boolean): number {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(TIPS_STEP_KEY);
  } catch {
    /* storage unavailable */
  }
  return initialStep(raw, TIPS_STEPS, needDoc(), restart);
}

function writeStep(i: number) {
  try {
    localStorage.setItem(TIPS_STEP_KEY, String(i));
  } catch {
    /* storage unavailable */
  }
}

/** Open the guide once (re-opening while it is open does nothing). `restart` begins at step 1. */
export function openTipsGuide(opts: { restart?: boolean } = {}) {
  if (useUI.getState().dialogs.some((d) => d.component === (TipsDialog as unknown))) return;
  void openDialog(TipsDialog, { restart: !!opts.restart });
}

export function TipsDialog({ close, restart = false }: { close: (r?: unknown) => void; restart?: boolean }) {
  const [i, setIState] = useState(() => {
    const n = readStep(restart);
    if (restart) writeStep(n);
    return n;
  });
  const setI = (n: number) => {
    setIState(n);
    writeStep(n);
  };
  const step = TIPS_STEPS[i];
  const Icon = step.icon;
  const runAction = (a: StepAction) => {
    try {
      // Reopening the guide continues with the next step.
      writeStep(stepAfterAction(i, TIPS_STEPS.length));
      close();
      a.run();
    } catch (e) {
      toast(String((e as Error)?.message ?? e), 'error');
    }
  };
  return (
    <Dialog
      title="Make your first Roblox thumbnail"
      onClose={() => close()}
      width={640}
      footer={
        <>
          <span className="shell-tips-count">
            Step {i + 1} of {TIPS_STEPS.length}
          </span>
          <span style={{ flex: 1 }} />
          <Button icon={ArrowLeft} disabled={i === 0} onClick={() => setI(i - 1)}>
            Back
          </Button>
          {i < TIPS_STEPS.length - 1 ? (
            <Button variant="primary" onClick={() => setI(i + 1)}>
              Next <ArrowRight size={13} />
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={Check}
              onClick={() => {
                writeStep(0);
                close();
              }}
            >
              Done
            </Button>
          )}
        </>
      }
    >
      <div className="shell-tips-layout">
        <ol className="shell-tips-steps">
          {TIPS_STEPS.map((s, k) => (
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
          {step.actions?.length ? (
            <div className="shell-tips-actions">
              {step.actions.map((a, k) => {
                const avail = a.available ? a.available() : true;
                return (
                  <Button
                    key={a.label}
                    variant={k === 0 ? 'primary' : undefined}
                    icon={a.icon}
                    disabled={!avail}
                    title={avail ? undefined : needDoc() ? 'Not available yet' : 'Create a document first'}
                    onClick={() => runAction(a)}
                  >
                    {a.label}
                  </Button>
                );
              })}
            </div>
          ) : null}
          <div className="shell-tips-hint">The guide closes while you try a step — reopen it from the lightbulb in the title bar to continue.</div>
        </div>
      </div>
    </Dialog>
  );
}
