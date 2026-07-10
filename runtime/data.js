/**
 * Data components: named observable values.
 *
 * Observation is shallow — a change event fires when the value is replaced
 * via set()/update(), compared with Object.is. Mutating a value in place does
 * not notify; replace it (or call touch()) instead. This keeps "what
 * triggered this change?" answerable.
 */

export class DataComponent {
  constructor(name, initial) {
    this.name = name;
    this._value = initial;
    this._listeners = new Set();
  }

  get value() {
    return this._value;
  }

  set value(v) {
    this.set(v);
  }

  set(value) {
    const oldValue = this._value;
    if (Object.is(oldValue, value)) return value;
    this._value = value;
    this._notify(oldValue);
    return value;
  }

  /** Replace the value as a function of the current value. */
  update(fn) {
    return this.set(fn(this._value));
  }

  /** Force a change event without replacing the value (after in-place mutation). */
  touch() {
    this._notify(this._value);
    return this._value;
  }

  observe(fn, { immediate = false } = {}) {
    this._listeners.add(fn);
    if (immediate) fn({ target: this, name: this.name, value: this._value, oldValue: undefined });
    return () => this._listeners.delete(fn);
  }

  _notify(oldValue) {
    const event = { target: this, name: this.name, value: this._value, oldValue };
    for (const fn of [...this._listeners]) {
      try {
        fn(event);
      } catch (err) {
        DataComponent.onListenerError?.(err, this);
      }
    }
    DataComponent.onAnyChange?.(event);
  }

  toJSON() {
    return this._value;
  }
}

// Hooks installed by the runtime (change inspector, error reporting).
DataComponent.onAnyChange = null;
DataComponent.onListenerError = null;

export class DataRegistry {
  constructor() {
    this.map = new Map();
  }

  /** Idempotent: returns the existing component if the name is taken. */
  define(name, initial) {
    let d = this.map.get(name);
    if (!d) {
      d = new DataComponent(name, initial);
      this.map.set(name, d);
      DataRegistry.onDefine?.(d);
    }
    return d;
  }

  /**
   * A data component whose value is derived from others and recomputed
   * whenever any dependency changes.
   */
  computed(name, deps, fn) {
    const d = this.define(name, fn(...deps.map((dep) => dep.value)));
    for (const dep of deps) {
      dep.observe(() => d.set(fn(...deps.map((x) => x.value))));
    }
    return d;
  }

  get(name) {
    return this.map.get(name);
  }

  snapshot() {
    const out = {};
    for (const [name, d] of this.map) out[name] = d.value;
    return out;
  }
}

DataRegistry.onDefine = null;
