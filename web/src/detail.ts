// Detail pane: full entry text with light XML/JSON syntax highlighting.

import type { EntryOut } from './types';
import { escapeHtml } from './util';

function highlight(raw: string): string {
  let text = raw;
  // Pretty-print pure JSON entries.
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      text = JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      /* not valid JSON, leave as-is */
    }
  }
  let html = escapeHtml(text);
  html = html.replace(
    /(&lt;\/?)([\w:.-]+)((?:\s[^&]*?)?)(\/?&gt;)/g,
    (_m, a: string, tag: string, attrs: string, b: string) =>
      `<span class="x-b">${a}</span><span class="x-t">${tag}</span><span class="x-a">${attrs}</span><span class="x-b">${b}</span>`
  );
  html = html.replace(/&quot;([\w@$.\- ]+)&quot;(\s*):/g, '<span class="j-k">&quot;$1&quot;</span>$2:');
  html = html.replace(/:(\s*)&quot;([^&]*?)&quot;/g, ':$1<span class="j-s">&quot;$2&quot;</span>');
  return html;
}

// Last entry rendered into each detail element. Selection events can repeat
// for the same entry (arrow-key hold re-render, late page load re-select);
// highlight() is pure, so re-rendering the same object would produce identical
// HTML — skip it.
const lastRendered = new WeakMap<HTMLElement, EntryOut | null>();

export interface DetailOptions {
  // Makes field chips clickable: called with the chip's key and value.
  onField?: (key: string, value: string) => void;
}

// Structured fields as key = value chips above the entry text.
function fieldsHtml(fields: Record<string, string> | undefined, clickable: boolean): string {
  const entries = Object.entries(fields ?? {});
  if (!entries.length) return '';
  const chips = entries
    .map(([k, v]) => {
      const inner = `<span class="fk">${escapeHtml(k)}</span><span class="fv">${escapeHtml(v)}</span>`;
      return clickable
        ? `<button type="button" class="field-chip" data-k="${escapeHtml(k)}" data-v="${escapeHtml(v)}" title="Filter by ${escapeHtml(k)} = ${escapeHtml(v)}">${inner}</button>`
        : `<span class="field-chip">${inner}</span>`;
    })
    .join('');
  return `<div class="detail-fields" aria-label="Fields">${chips}</div>`;
}

export function renderDetail(el: HTMLElement, e: EntryOut | null, opts: DetailOptions = {}) {
  if (lastRendered.has(el) && lastRendered.get(el) === e) return;
  lastRendered.set(el, e);
  if (!e) {
    el.innerHTML = '<div class="detail-empty">Select a log entry to see its full text.</div>';
    return;
  }
  el.innerHTML = fieldsHtml(e.fields, !!opts.onField) + `<pre class="detail-pre">${highlight(e.raw)}</pre>`;
  if (opts.onField) {
    el.querySelectorAll<HTMLElement>('button.field-chip').forEach((chip) => {
      chip.onclick = () => opts.onField!(chip.dataset.k!, chip.dataset.v!);
    });
  }
}
