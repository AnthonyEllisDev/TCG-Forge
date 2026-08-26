/* Global keyboard shortcuts. */

import { editor, isTypingTarget } from '../core/editor.js';
import { history } from '../core/history.js';
import { saveProject } from '../core/project.js';
import { openExportDialog, openShortcuts } from './toolbar.js';
import { toast } from './dialogs.js';

export function initShortcuts() {
  window.addEventListener('keydown', async (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const typing = isTypingTarget(e.target) || editor.canvas?.getActiveObject()?.isEditing;

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
          e.preventDefault();
          e.shiftKey ? history.redo() : history.undo();
          return;
        case 'y':
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
        case 'd':
          if (typing) return;
          e.preventDefault();
          editor.duplicate();
          return;
        case 'c':
          if (typing) return;
          editor.copy();
          return;
        case 'v':
          if (typing) return;
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
