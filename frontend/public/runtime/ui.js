/**
 * UI components: custom elements rendered with lit-html.
 *
 * defineComponent(tag, options) registers a custom element whose content is
 * produced by options.render (a lit-html template). Components re-render when
 * any data component listed by options.watch changes, or when update() is
 * called manually.
 *
 * Custom elements cannot be re-registered in a realm, so applying changes to
 * a component definition requires a page reload — the editor handles that.
 */

import { render, html } from '../vendor/lit-html/lit-html.js';

export function makeDefineComponent(reportError) {
  return function defineComponent(tag, options = {}) {
    const {
      render: renderFn,
      watch,
      connected,
      disconnected,
      shadow = true,
      styles = '',
    } = options;

    const existing = customElements.get(tag);
    if (existing) {
      console.warn(`<${tag}> is already defined; reload the page to apply a new definition.`);
      return existing;
    }

    class ContraptionComponent extends HTMLElement {
      constructor() {
        super();
        this._root = shadow ? this.attachShadow({ mode: 'open' }) : this;
        this._unsubs = [];
      }

      connectedCallback() {
        if (watch) {
          try {
            const deps = typeof watch === 'function' ? watch.call(this) : watch;
            for (const dep of deps) {
              if (dep && typeof dep.observe === 'function') {
                this._unsubs.push(dep.observe(() => this.update()));
              }
            }
          } catch (err) {
            reportError(err, `watch <${tag}>`);
          }
        }
        try {
          connected?.call(this);
        } catch (err) {
          reportError(err, `connected <${tag}>`);
        }
        this.update();
      }

      disconnectedCallback() {
        for (const unsub of this._unsubs) unsub();
        this._unsubs = [];
        try {
          disconnected?.call(this);
        } catch (err) {
          reportError(err, `disconnected <${tag}>`);
        }
      }

      update() {
        if (!this.isConnected || !renderFn) return;
        try {
          let template = renderFn.call(this);
          if (styles) template = html`<style>${styles}</style>${template}`;
          render(template, this._root);
        } catch (err) {
          reportError(err, `render <${tag}>`);
        }
      }
    }

    customElements.define(tag, ContraptionComponent);
    return ContraptionComponent;
  };
}
