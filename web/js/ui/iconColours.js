/*
 * Properties → Typography → Icon colours: a colour for each icon in a text
 * layer, or one for all of them.
 *
 * The colours belong to the layer (`tcgIconColors`), not to the card, so a
 * rules box that colours {element-fire} red does so on every card in the set
 * and on every row of a batch run, whichever icons that card's words happen
 * to use. The list therefore shows the icons in the text on screen *and* any
 * the layer already colours, and the select below it adds any other icon.
 */

import { el, on, toHex } from '../util/dom.js';
import { bus, EVT } from '../util/bus.js';
import { editor } from '../core/editor.js';
import { iconList } from '../core/icons.js';

const ALL = '*';
const isText = (o) => o && (o.type === 'textbox' || o.type === 'i-text' || o.type === 'text');

/* What the rows were last built from, so a colour change restyles in place
   instead of rebuilding the input being dragged. */
let shownKey = '';

export function initIconColours() {
  const rows = document.getElementById('pIconColourRows');
  const add = document.getElementById('pIconColourAdd');
  if (!rows || !add) return;

  on(rows, 'input', (e) => {
    const name = e.target?.dataset?.iconColour;
    const obj = layer();
    if (!name || !obj) return;
    editor.setIconColour(obj, name, e.target.value);
  });
  on(rows, 'click', (e) => {
    const name = e.target?.closest?.('[data-icon-colour-clear]')?.dataset.iconColourClear;
    const obj = layer();
    if (!name || !obj) return;
    editor.setIconColour(obj, name, null);
  });
  on(add, 'change', () => {
    const obj = layer();
    const name = add.value;
    add.value = '';
    if (!name || !obj) return;
    // Start from the text's own colour, so adding a row changes nothing on
    // the card until a colour is picked.
    // The change redraws the list (EVT.OBJECTS), so the new row is there.
    editor.setIconColour(obj, name, textColour(obj));
    document.querySelector(`#pIconColourRows input[data-icon-colour="${CSS.escape(name)}"]`)?.focus();
  });

  bus.on(EVT.SELECTION, sync);
  bus.on(EVT.OBJECTS, sync);
  bus.on(EVT.ICONS, () => {
    shownKey = '';
    sync();
  });
  sync();
}

/** The single text layer selected, or null. */
function layer() {
  const objs = editor.selection();
  return objs.length === 1 && isText(objs[0]) ? objs[0] : null;
}

const textColour = (obj) => toHex(typeof obj.fill === 'string' ? obj.fill : '', '#000000');

/** Icon names in the order they should be listed: all, in the text, then the rest coloured. */
function namesFor(obj, icons) {
  const byChar = new Map(icons.map((icon) => [icon.char, icon.name]));
  const names = [ALL];
  for (const char of String(obj.text || '')) {
    const name = byChar.get(char);
    if (name && !names.includes(name)) names.push(name);
  }
  for (const name of Object.keys(obj.tcgIconColors || {})) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function sync() {
  const box = document.getElementById('pIconColours');
  const rows = document.getElementById('pIconColourRows');
  const add = document.getElementById('pIconColourAdd');
  if (!box || !rows || !add) return;
  const obj = layer();
  const icons = iconList();
  box.hidden = !obj || !icons.length;
  if (box.hidden) {
    shownKey = '';
    return;
  }

  const names = namesFor(obj, icons);
  const colours = obj.tcgIconColors || {};
  const text = textColour(obj);
  const chars = new Map(icons.map((icon) => [icon.name, icon.char]));

  const key = `${obj.tcgId || ''}|${names.join(',')}`;
  if (key !== shownKey) {
    shownKey = key;
    rows.innerHTML = '';
    for (const name of names) {
      const label = name === ALL ? 'All icons' : `{${name}}`;
      const spoken = name === ALL ? 'every icon' : `the ${name} icon`;
      rows.append(
        el('div', { class: 'ic-row', dataset: { iconRow: name } }, [
          el('span', { class: 'ic-glyph', 'aria-hidden': 'true', text: name === ALL ? '✱' : chars.get(name) || '?' }),
          el('span', { class: 'ic-name', text: label }),
          el('input', { type: 'color', dataset: { iconColour: name }, 'aria-label': `Colour of ${spoken} in this layer` }),
          el('button', {
            type: 'button',
            class: 'btn tiny',
            dataset: { iconColourClear: name },
            title: 'Back to the text colour',
            'aria-label': `Give ${spoken} the text colour again`,
            text: 'Reset',
          }),
        ])
      );
    }
    const others = icons.filter((icon) => !names.includes(icon.name));
    add.innerHTML = '';
    add.append(el('option', { value: '', text: others.length ? 'Choose an icon…' : 'Every icon is listed' }));
    for (const icon of others) add.append(el('option', { value: icon.name, text: `{${icon.name}}` }));
    add.disabled = !others.length;
  }

  // Values follow the layer on every change, except the input being used.
  for (const row of rows.querySelectorAll('.ic-row')) {
    const name = row.dataset.iconRow;
    const own = colours[name];
    const shown = own || (name !== ALL && colours[ALL]) || text;
    const input = row.querySelector('input');
    if (input !== document.activeElement) input.value = toHex(shown, '#000000');
    row.classList.toggle('unset', !own);
    row.querySelector('.ic-glyph').style.color = shown;
    const reset = row.querySelector('button');
    reset.disabled = !own;
    row.title = own ? '' : name === ALL ? 'Icons take the text colour' : colours[ALL] ? 'Takes the colour for all icons' : 'Takes the text colour';
  }
}
