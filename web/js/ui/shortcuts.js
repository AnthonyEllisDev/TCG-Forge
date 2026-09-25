/* Global keyboard shortcuts. */

import { editor, isTypingTarget } from '../core/editor.js';
import { history } from '../core/history.js';
import { saveProject } from '../core/project.js';
import { openExportDialog, openProjectDialog, openShortcuts } from './toolbar.js';
import { openBatchDialog } from './batchPanel.js';
import { openPrintDialog } from './printPanel.js';
import { isModalOpen, toast } from './dialogs.js';

/* Keys whose browser default opens something of the browser's own — a save,
   print or open dialog — on top of ours. */
const BROWSER_MODIFIER_KEYS = new Set(['s', 'p', 'o']);

export function initShortcuts() {
  window.addEventListener('keydown', async (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const typing = isTypingTarget(e.target) || editor.canvas?.getActiveObject()?.isEditing;

    // A dialog owns the keyboard. Focus usually sits on one of its buttons,
    // which is not a typing target, so without this Delete removed the layer
    // selected behind the dialog, the arrows nudged it, and Ctrl+O or Ctrl+B
    // swapped the dialog for another one — leaving a confirm unanswered or a
    // running print writing into a dialog that was gone. Escape is handled by
    // the dialog itself.
    if (isModalOpen()) {
      if (mod && BROWSER_MODIFIER_KEYS.has(e.key.toLowerCase())) e.preventDefault();
      return;
    }

    if (e.key === 'Escape') {
      editor.canvas?.discardActiveObject();
      editor.canvas?.requestRenderAll();
      editor.emitSelection();
      return;
    }

    if (e.key === '?' && !typing) {
      e.preventDefault();
      openShortcuts();
      return;
    }

    if (mod) {
      switch (e.key.toLowerCase()) {
        case 'z':
          // A field in the panels owns its own undo stack. Hijacking Ctrl+Z
          // there rolls back the whole canvas while the caret is mid-word,
          // and leaves the input showing text the card no longer has.
          if (typing) return;
          e.preventDefault();
          e.shiftKey ? history.redo() : history.undo();
          return;
        case 'y':
          if (typing) return;
          e.preventDefault();
          history.redo();
          return;
        case 's':
          e.preventDefault();
          try {
            const res = await saveProject({});
            toast(res.saved === 'workspace' ? `Saved to ${res.path}` : 'Downloaded project file.', 'ok');
          } catch (err) {
            toast(`Save failed: ${err.message}`, 'err');
          }
          return;
        case 'e':
          e.preventDefault();
          openExportDialog();
          return;
        case 'o':
          e.preventDefault();
          openProjectDialog();
          return;
        case 'b':
          if (typing) return;
          e.preventDefault();
          openBatchDialog();
          return;
        case 'p':
          if (typing) return;
          e.preventDefault();
          openPrintDialog();
          return;
        case 'd':
          if (typing) return;
          e.preventDefault();
          editor.duplicate();
          return;
        case 'c':
          if (typing) return;
          // Without this the browser's own copy runs too and puts the page
          // selection on the clipboard alongside our layers.
          e.preventDefault();
          editor.copy();
          return;
        case 'v':
          if (typing) return;
          e.preventDefault();
          editor.paste();
          return;
        case 'a':
          if (typing) return;
          e.preventDefault();
          editor.selectAll();
          return;
        case 'g':
          if (typing) return;
          e.preventDefault();
          editor.toggleGroup();
          return;
        case '0':
          e.preventDefault();
          editor.fitToWindow();
          return;
        case '=':
        case '+':
          e.preventDefault();
          editor.setZoom(editor.zoom * 1.15);
          return;
        case '-':
          e.preventDefault();
          editor.setZoom(editor.zoom / 1.15);
          return;
        default:
          break;
      }
      return;
    }

    if (typing) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      editor.remove();
      return;
    }

    if (e.key === '[') {
      editor.order('down');
      return;
    }
    if (e.key === ']') {
      editor.order('up');
      return;
    }

    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') { e.preventDefault(); editor.nudge(-step, 0); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); editor.nudge(step, 0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); editor.nudge(0, -step); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); editor.nudge(0, step); }
  });
}
