// Filter bar in the GitLab style: one input holding a row of tokens, each a
// field, an operator and values, written one step at a time from a list under
// the caret. Typed text that is no field's searches the entry text.
//
//   Level = ERROR · tenant is one of acme, globex · contains "timeout"
//
// Clicking a token edits it, its × removes it, Backspace in the empty input
// steps back into the last one. Arrow keys move through the list, Enter
// picks, Escape cancels. "is one of" toggles values until Enter.
//
// The bar knows nothing about filters: a host lists the fields, maps tokens
// to its filter state and back, and supplies value suggestions.

import { icon, type IconName } from './icons';
import { escapeHtml, fmtNum } from './util';

export interface BarOperator {
  id: string;
  symbol: string; // as the token shows it
  description: string; // as the list explains it
  takes: 'one' | 'many';
}

export const IS: BarOperator = { id: 'is', symbol: '=', description: 'is', takes: 'one' };
export const IN: BarOperator = { id: 'in', symbol: 'is one of', description: 'any of several values', takes: 'many' };
export const CONTAINS: BarOperator = { id: 'contains', symbol: 'contains', description: 'text anywhere in the entry', takes: 'one' };

export interface BarValue {
  value: string;
  count?: number;
}

export interface BarField {
  name: string;
  title: string;
  icon: IconName;
  detail?: string;
  operators: BarOperator[];
  // 'list': chosen from suggestions (typed values allowed with typedValues);
  // 'text': typed.
  input: 'list' | 'text';
  typedValues?: boolean;
  // Suggestions for a list field, narrowed by the typed text.
  values?: (q: string) => Promise<{ values: BarValue[]; note?: string }>;
  // How a value reads in tokens and the list.
  label?: (value: string) => string;
  // Hint shown for 'text' input.
  hint?: string;
}

export interface BarToken {
  field: string;
  operator: string;
  values: string[];
}

export interface BarHost {
  fields(): BarField[];
  tokens(): BarToken[];
  onChange(tokens: BarToken[]): void;
  // Field that typed free text searches (shown as a "contains" token).
  freeText?: string;
  // Called when the bar opens, e.g. to load the field keys of the log.
  onOpen?(): void;
}

// The token being written: its field, then operator, then values.
interface Draft {
  field: string;
  operator: string | null;
  chosen: string[];
  editing: boolean; // replaces the field's existing token
}

type Option =
  | { kind: 'field'; field: BarField; used: boolean }
  | { kind: 'search'; text: string }
  | { kind: 'operator'; operator: BarOperator }
  | { kind: 'value'; value: string; count?: number; source: 'seen' | 'chosen' | 'typed' };

let barSeq = 0;

export class FilterBar {
  readonly input: HTMLInputElement;
  private readonly tokensEl: HTMLElement;
  private readonly list: HTMLElement;
  private readonly listId: string;
  private draft: Draft | null = null;
  private isOpen = false;
  private active = -1; // highlighted option, -1 = none picked yet
  private options: Option[] = [];
  private seen: BarValue[] = [];
  private note = '';
  private loading = false;
  private seenKey = '';
  private fetchSeq = 0;
  private debounce = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly host: BarHost,
    opts: { inputId: string; placeholder: string; label: string }
  ) {
    this.listId = `fb-list-${++barSeq}`;
    root.classList.add('filter-bar');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Filters');
    root.innerHTML =
      `<span class="fb-icon" aria-hidden="true">${icon('filter', 14)}</span><span class="fb-tokens"></span>` +
      `<input id="${opts.inputId}" class="fb-input" type="text" autocomplete="off" spellcheck="false" role="combobox" ` +
      `aria-expanded="false" aria-controls="${this.listId}" aria-autocomplete="list" aria-label="${escapeHtml(opts.label)}" ` +
      `placeholder="${escapeHtml(opts.placeholder)}" />` +
      `<div class="fb-list" id="${this.listId}" role="listbox" hidden></div>`;
    this.tokensEl = root.querySelector('.fb-tokens') as HTMLElement;
    this.input = root.querySelector('.fb-input') as HTMLInputElement;
    this.list = root.querySelector('.fb-list') as HTMLElement;
    this.placeholder = opts.placeholder;

    // Presses inside the bar keep focus in the input, so clicking a token or
    // an option isn't "leaving" it; a press on the background focuses it.
    root.addEventListener('mousedown', (ev) => {
      if (ev.target === this.input) return;
      ev.preventDefault();
      if (ev.target === root || (ev.target as HTMLElement).closest('.fb-icon')) {
        this.input.focus();
        this.openList();
      }
    });
    this.input.addEventListener('focus', () => this.openList());
    this.input.addEventListener('click', () => this.openList());
    this.input.addEventListener('blur', () => {
      this.finish();
      this.closeList();
    });
    this.input.addEventListener('input', () => {
      this.active = -1;
      this.openList();
      this.scheduleValues();
      this.renderList();
    });
    this.input.addEventListener('keydown', (ev) => this.onKey(ev));
    this.render();
  }

  private readonly placeholder: string;

  // Re-renders from the host's tokens (call after the filter state changed).
  refresh() {
    this.render();
    if (this.isOpen) this.renderList();
  }

  focus() {
    this.input.focus();
  }

  private field(name: string): BarField | null {
    return this.host.fields().find((f) => f.name === name) ?? null;
  }

  private operatorOf(field: BarField, id: string | null): BarOperator | null {
    return field.operators.find((o) => o.id === id) ?? null;
  }

  private label(field: BarField | null, value: string): string {
    return field?.label ? field.label(value) : value;
  }

  private stage(): 'field' | 'operator' | 'value' {
    return !this.draft ? 'field' : this.draft.operator === null ? 'operator' : 'value';
  }

  // ---- rendering --------------------------------------------------------------

  private render() {
    const tokens = this.host.tokens();
    const parts: string[] = [];
    tokens.forEach((t, i) => {
      if (this.draft?.editing && this.draft.field === t.field) return;
      const field = this.field(t.field);
      const title = field?.title ?? t.field;
      const symbol = (field && this.operatorOf(field, t.operator)?.symbol) ?? t.operator;
      const words =
        field?.input === 'text'
          ? t.values.map((v) => `“${this.label(field, v)}”`).join(' … ')
          : t.values.map((v) => this.label(field, v)).join(', ');
      parts.push(
        `<span class="fb-token" data-i="${i}">` +
          `<span class="fb-field" data-edit="value">${escapeHtml(title)}</span>` +
          `<span class="fb-op" data-edit="operator">${escapeHtml(symbol)}</span>` +
          `<button type="button" class="fb-value" data-edit="value" title="${escapeHtml(words)}" aria-label="Edit filter ${escapeHtml(title)} ${escapeHtml(symbol)} ${escapeHtml(words)}">${escapeHtml(words)}</button>` +
          `<button type="button" class="fb-remove" aria-label="Remove filter ${escapeHtml(title)}">${icon('close', 12)}</button>` +
          `</span>`
      );
    });
    if (this.draft) {
      const field = this.field(this.draft.field);
      const op = field ? this.operatorOf(field, this.draft.operator) : null;
      parts.push(
        `<span class="fb-token draft" aria-hidden="true"><span class="fb-field">${escapeHtml(field?.title ?? this.draft.field)}</span>` +
          (op ? `<span class="fb-op">${escapeHtml(op.symbol)}</span>` : '') +
          (op?.takes === 'many' && this.draft.chosen.length
            ? `<span class="fb-value">${escapeHtml(this.draft.chosen.map((v) => this.label(field, v)).join(', '))}</span>`
            : '') +
          `</span>`
      );
    }
    this.tokensEl.innerHTML = parts.join('');
    this.tokensEl.querySelectorAll<HTMLElement>('.fb-token[data-i]').forEach((tokenEl) => {
      const token = tokens[Number(tokenEl.dataset.i)];
      tokenEl.querySelectorAll<HTMLElement>('[data-edit]').forEach((part) => {
        part.addEventListener('click', () => this.edit(token, part.dataset.edit as 'value' | 'operator'));
      });
      tokenEl.querySelector('.fb-remove')!.addEventListener('click', () => this.remove(token));
    });
    this.input.placeholder = tokens.length === 0 && !this.draft ? this.placeholder : '';
    const stage = this.stage();
    const title = this.draft ? (this.field(this.draft.field)?.title ?? this.draft.field) : '';
    this.input.setAttribute(
      'aria-label',
      stage === 'field' ? 'Filter: type a field or text' : stage === 'operator' ? `How ${title} matches` : `${title} values`
    );
  }

  private computeOptions(): Option[] {
    const text = this.input.value.trim();
    const needle = text.toLowerCase();
    const tokens = this.host.tokens();
    const draft = this.draft;
    if (!draft) {
      const fields: Option[] = this.host
        .fields()
        .filter((f) => !needle || f.title.toLowerCase().includes(needle) || f.name.toLowerCase().includes(needle))
        .map((f) => ({ kind: 'field', field: f, used: tokens.some((t) => t.field === f.name) }));
      // Free text first when it matches no field, so Enter searches it.
      if (this.host.freeText && text) {
        const search: Option = { kind: 'search', text };
        return fields.length ? [...fields, search] : [search];
      }
      return fields;
    }
    const field = this.field(draft.field);
    if (!field) return [];
    if (draft.operator === null) {
      return field.operators
        .filter((o) => !needle || o.symbol.includes(needle) || o.description.includes(needle))
        .map((o) => ({ kind: 'operator', operator: o }));
    }
    if (field.input === 'text') return text ? [{ kind: 'value', value: text, source: 'typed' }] : [];
    // Values already chosen stay listed (to uncheck them) when not suggested.
    const chosen: Option[] = draft.chosen
      .filter((v) => !this.seen.some((s) => s.value === v) && (!needle || v.toLowerCase().includes(needle)))
      .map((v) => ({ kind: 'value', value: v, source: 'chosen' }));
    const seen: Option[] = this.seen
      .filter((s) => !needle || `${s.value} ${this.label(field, s.value)}`.toLowerCase().includes(needle))
      .map((s) => ({ kind: 'value', value: s.value, count: s.count, source: 'seen' }));
    const options = [...chosen, ...seen];
    if (text && field.typedValues && !options.some((o) => o.kind === 'value' && o.value === text)) {
      options.push({ kind: 'value', value: text, source: 'typed' });
    }
    return options;
  }

  private renderList() {
    if (!this.isOpen) return;
    this.options = this.computeOptions();
    const stage = this.stage();
    const field = this.draft ? this.field(this.draft.field) : null;
    const op = field && this.draft ? this.operatorOf(field, this.draft.operator) : null;
    const many = op?.takes === 'many';
    if (this.active >= this.options.length) this.active = -1;
    const shown = this.active >= 0 ? this.active : this.options.length ? 0 : -1;
    const head =
      stage === 'field'
        ? 'Filter by'
        : stage === 'operator'
          ? `How ${field?.title ?? ''} matches`
          : many
            ? 'Choose values, then Enter'
            : `${field?.title ?? ''} value`;
    const rows = this.options.map((o, i) => {
      const id = `${this.listId}-${i}`;
      const cls = `fb-option${i === shown ? ' active' : ''}`;
      const selected = o.kind === 'value' && !!this.draft?.chosen.includes(o.value);
      let inner = '';
      if (o.kind === 'field') {
        inner =
          `${icon(o.field.icon, 14)}<span class="fb-name">${escapeHtml(o.field.title)}</span>` +
          `<span class="fb-detail">${escapeHtml(o.used ? 'Edit filter' : (o.field.detail ?? ''))}</span>`;
      } else if (o.kind === 'search') {
        inner = `${icon('search', 14)}<span class="fb-name">Search for “${escapeHtml(o.text)}”</span>`;
      } else if (o.kind === 'operator') {
        inner = `<span class="fb-name fb-opname">${escapeHtml(o.operator.symbol)}</span><span class="fb-detail">${escapeHtml(o.operator.description)}</span>`;
      } else {
        const check = many ? `<span class="fb-check" aria-hidden="true">${selected ? icon('check', 14) : ''}</span>` : '';
        const name =
          o.source === 'typed'
            ? `Use “${escapeHtml(o.value)}”`
            : escapeHtml(this.label(field, o.value)) || '<span class="fb-detail">(empty)</span>';
        inner = `${check}<span class="fb-name">${name}</span>${o.count !== undefined ? `<span class="fb-detail">${fmtNum(o.count)}</span>` : ''}`;
      }
      return `<div class="${cls}" id="${id}" role="option" aria-selected="${selected || i === shown}" data-i="${i}">${inner}</div>`;
    });
    let empty = '';
    if (!rows.length) {
      empty =
        stage === 'value' && field?.input === 'text'
          ? escapeHtml(field.hint ?? 'Type a value, then Enter')
          : this.loading
            ? 'Loading values…'
            : stage === 'field'
              ? 'No field matches'
              : 'No values';
    }
    this.list.innerHTML =
      `<div class="fb-head">${escapeHtml(head)}</div>` +
      rows.join('') +
      (empty ? `<div class="fb-empty">${empty}</div>` : '') +
      (this.note && stage === 'value' ? `<div class="fb-note">${escapeHtml(this.note)}</div>` : '');
    this.list.querySelectorAll<HTMLElement>('.fb-option').forEach((row) => {
      row.addEventListener('mousedown', (ev) => ev.preventDefault());
      row.addEventListener('click', () => this.choose(this.options[Number(row.dataset.i)]));
      row.addEventListener('mousemove', () => {
        const i = Number(row.dataset.i);
        if (i !== this.active) {
          this.active = i;
          this.renderList();
        }
      });
    });
    if (shown >= 0) {
      this.input.setAttribute('aria-activedescendant', `${this.listId}-${shown}`);
      this.list.querySelector(`#${this.listId}-${shown}`)?.scrollIntoView({ block: 'nearest' });
    } else this.input.removeAttribute('aria-activedescendant');
    this.list.setAttribute('aria-multiselectable', String(many));
  }

  // ---- list lifecycle ---------------------------------------------------------

  private openList() {
    if (!this.isOpen) {
      this.isOpen = true;
      this.list.hidden = false;
      this.input.setAttribute('aria-expanded', 'true');
      this.host.onOpen?.();
      this.scheduleValues(true);
    }
    this.renderList();
  }

  private closeList() {
    this.isOpen = false;
    this.list.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  // Loads suggestions for the value step of a list field (debounced on typing).
  private scheduleValues(now = false) {
    const field = this.draft && this.stage() === 'value' ? this.field(this.draft.field) : null;
    if (!field?.values) {
      this.seen = [];
      this.note = '';
      this.loading = false;
      return;
    }
    const q = this.input.value.trim();
    const key = `${field.name}\u0000${q}`;
    if (key === this.seenKey) return;
    window.clearTimeout(this.debounce);
    const run = () => {
      const seq = ++this.fetchSeq;
      this.loading = true;
      this.renderList();
      field.values!(q)
        .then((r) => {
          if (seq !== this.fetchSeq) return;
          this.seen = r.values;
          this.note = r.note ?? '';
          this.seenKey = key;
        })
        .catch(() => {
          if (seq === this.fetchSeq) this.seen = [];
        })
        .finally(() => {
          if (seq !== this.fetchSeq) return;
          this.loading = false;
          this.renderList();
        });
    };
    if (now) run();
    else this.debounce = window.setTimeout(run, 150);
  }

  // ---- editing ----------------------------------------------------------------

  private step(next: Draft | null) {
    this.draft = next;
    this.input.value = '';
    this.active = -1;
    this.seenKey = '';
    this.seen = [];
    this.render();
    this.scheduleValues(true);
    this.renderList();
  }

  // The tokens with the draft written in (replacing the field's token), or
  // null while incomplete. An emptied "is one of" removes the token.
  private settled(draft: Draft): BarToken[] | null {
    const field = this.field(draft.field);
    const op = field ? this.operatorOf(field, draft.operator) : null;
    if (!field || !op) return null;
    const tokens = this.host.tokens();
    const at = tokens.findIndex((t) => t.field === draft.field);
    if (draft.chosen.length === 0) return op.takes === 'many' && at >= 0 ? tokens.filter((_, i) => i !== at) : null;
    const token: BarToken = { field: draft.field, operator: op.id, values: draft.chosen };
    return at >= 0 ? tokens.map((t, i) => (i === at ? token : t)) : [...tokens, token];
  }

  private commit(draft: Draft) {
    const next = this.settled(draft);
    this.draft = null;
    if (next) this.host.onChange(next);
    this.step(null);
  }

  // Writes an unfinished "is one of" draft (blur, or Enter in the empty input).
  private finish() {
    if (!this.draft) return;
    const field = this.field(this.draft.field);
    const op = field ? this.operatorOf(field, this.draft.operator) : null;
    if (op?.takes === 'many') this.commit(this.draft);
    else this.step(null);
  }

  private edit(token: BarToken, at: 'value' | 'operator') {
    const field = this.field(token.field);
    if (!field) return;
    this.step({
      field: token.field,
      operator: at === 'operator' && field.operators.length > 1 ? null : token.operator,
      chosen: [...token.values],
      editing: true,
    });
    this.input.focus();
    this.openList();
  }

  private remove(token: BarToken) {
    this.host.onChange(this.host.tokens().filter((t) => t.field !== token.field));
    this.step(null);
  }

  private choose(option: Option | undefined) {
    if (!option) return;
    const draft = this.draft;
    if (option.kind === 'field') {
      const existing = this.host.tokens().find((t) => t.field === option.field.name);
      if (existing) return this.edit(existing, 'value');
      const only = option.field.operators.length === 1 ? option.field.operators[0].id : null;
      return this.step({ field: option.field.name, operator: only, chosen: [], editing: false });
    }
    if (option.kind === 'search') {
      const name = this.host.freeText!;
      const field = this.field(name);
      return this.commit({ field: name, operator: field?.operators[0]?.id ?? 'contains', chosen: [option.text], editing: false });
    }
    if (!draft) return;
    if (option.kind === 'operator') {
      const chosen = option.operator.takes === 'one' ? draft.chosen.slice(0, 1) : draft.chosen;
      return this.step({ ...draft, operator: option.operator.id, chosen });
    }
    const field = this.field(draft.field);
    const op = field ? this.operatorOf(field, draft.operator) : null;
    if (op?.takes !== 'many') return this.commit({ ...draft, chosen: [option.value] });
    const has = draft.chosen.includes(option.value);
    const chosen = has ? draft.chosen.filter((v) => v !== option.value) : [...draft.chosen, option.value];
    this.draft = { ...draft, chosen };
    this.input.value = '';
    this.render();
    this.renderList();
  }

  // Backspace in the empty input: one step back.
  private back() {
    const stage = this.stage();
    const draft = this.draft;
    if (stage === 'value' && draft) {
      const field = this.field(draft.field);
      if (field && field.operators.length > 1) return this.step({ ...draft, operator: null });
      return this.step(null);
    }
    if (stage === 'operator') return this.step(null);
    const last = this.host.tokens().at(-1);
    if (last) this.edit(last, 'value');
  }

  private onKey(ev: KeyboardEvent) {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!this.isOpen) return this.openList();
      const n = this.options.length;
      if (!n) return;
      const cur = this.active >= 0 ? this.active : ev.key === 'ArrowDown' ? -1 : 0;
      this.active = (cur + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n;
      this.renderList();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const field = this.draft ? this.field(this.draft.field) : null;
      const op = field && this.draft ? this.operatorOf(field, this.draft.operator) : null;
      // Several values are done with Enter in the empty input.
      if (op?.takes === 'many' && !this.input.value.trim() && this.active < 0 && this.draft!.chosen.length) {
        return this.commit(this.draft!);
      }
      if (!this.isOpen) return this.openList();
      this.choose(this.options[this.active >= 0 ? this.active : 0]);
    } else if (ev.key === 'Backspace' && this.input.value === '') {
      ev.preventDefault();
      this.back();
    } else if (ev.key === 'Escape' && (this.isOpen || this.draft)) {
      ev.preventDefault();
      ev.stopPropagation();
      this.draft = null;
      this.step(null);
      this.closeList();
    }
  }
}
