export const settingsCss = String.raw`
.syn-config {
  --surface: var(--dsw-alias-bg-base, #fff);
  --bg: var(--dsw-alias-bg-layer-1, #f6f7f9);
  --ink: var(--dsw-alias-label-primary, #252832);
  --muted: var(--dsw-alias-label-secondary, #5d6676);
  --line: var(--dsw-alias-border-l1, #dcdee4);
  --accent: var(--dsw-alias-button-primary-fill, #28645c);
  --tint: color-mix(in srgb, var(--accent) 7%, var(--surface));
  color: var(--ink);
  min-width: 0;
  container: synapse / inline-size;
  font: inherit;
  line-height: 1.5;
}
.dsh-ui[data-theme="dark"] .syn-config {
    --surface: var(--dsw-alias-bg-base, #24252a);
    --bg: var(--dsw-alias-bg-layer-1, #2b2d33);
    --ink: var(--dsw-alias-label-primary, #eaebee);
    --muted: var(--dsw-alias-label-secondary, #adb2bd);
    --line: var(--dsw-alias-border-l1, #3d4049);
    --accent: var(--dsw-alias-button-primary-fill, #94cec2);
}
.syn-config *,
.syn-config *::before,
.syn-config *::after {
  box-sizing: border-box;
}
.syn-config :where(button, input, textarea, select) {
  font: inherit;
  color: inherit;
}
.syn-config button {
  cursor: pointer;
}
.syn-config button:disabled {
  cursor: default;
}
.syn-config [hidden] {
  display: none !important;
}
.syn-config :focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.syn-config .ui-icon {
  display: block;
  flex-shrink: 0;
}
.syn-group {
  margin: 20px 0 0;
  min-width: 0;
}
.syn-group h2 {
  font-size: 13px;
  line-height: 1.4;
  font-weight: 650;
  letter-spacing: 0.02em;
  margin: 0 0 8px 2px;
}
.syn-rows {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  overflow: clip;
}
.syn-item + .syn-item {
  border-top: 1px solid var(--line);
}
.syn-symbol {
  width: 31px;
  height: 31px;
  border-radius: 7px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--muted);
  background: var(--bg);
}
.syn-qq {
  color: #4086b7;
  background: color-mix(in srgb, #5ea8dc 11%, var(--surface));
}
.syn-discord {
  color: #8780df;
  background: color-mix(in srgb, #8581db 12%, var(--surface));
}
.syn-github {
  color: var(--ink);
}
.syn-label {
  display: grid;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.syn-label strong,
.syn-matches strong {
  font-size: 14px;
  font-weight: 620;
}
.syn-label small,
.syn-matches small {
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
}
.syn-summary {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
.syn-enabled:before {
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-inline-end: 6px;
  background: var(--accent);
  vertical-align: 2px;
}
.syn-body {
  padding: 16px clamp(10px, 2.4cqi, 22px);
  border-top: 1px solid var(--line);
  min-width: 0;
}
.syn-fields {
  min-width: 0;
}
.syn-notice:not(:empty) {
  margin-top: 10px;
  font-size: 12px;
  font-weight: 550;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.syn-matches {
  margin-top: 14px;
  border: 1px solid var(--line);
  background: var(--surface);
  border-radius: 9px;
  overflow: clip;
}
.syn-matches button {
  background: transparent;
  border: 0;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 11px 14px;
  color: var(--ink);
}
.syn-matches button + button {
  border-top: 1px solid var(--line);
}
.syn-matches button:hover {
  background: var(--bg);
}
.syn-matches button small {
  margin-left: auto;
}
.syn-empty {
  color: var(--muted);
  font-size: 13px;
}
@container synapse (max-width:480px) {
  .syn-symbol {
    width: 26px;
    height: 26px;
  }
  .syn-label strong {
    font-size: 13px;
  }
  .syn-label small {
    font-size: 11px;
  }
  .syn-summary {
    font-size: 11px;
  }
  .syn-matches button {
    flex-wrap: wrap;
  }
}

/* DisclosureRow uses a compact single-line header by default. These labels include a description. */
.syn-config .syn-ui-disclosure > .dsh-disclosure__header {
  height: auto;
  min-width: 0;
  min-height: 48px;
  color: var(--ink);
}
.syn-config .syn-ui-disclosure .dsh-disclosure__header--expandable {
  min-width: 0;
  width: 100%;
  min-height: 48px;
  padding: 9px 12px;
  text-align: start;
  line-height: 1.4;
}
.syn-config .syn-ui-disclosure .dsh-disclosure__header--expandable:hover {
  background: var(--bg);
}
.syn-config
  .syn-ui-disclosure
  .dsh-disclosure__header--expandable[aria-expanded="true"] {
  background: var(--tint);
}
.syn-config
  .syn-ui-disclosure
  .dsh-disclosure__header--expandable:focus-visible {
  outline-offset: -2px;
}
.syn-config .syn-ui-disclosure .dsh-disclosure__leading:first-child {
  width: auto;
  height: auto;
}
.syn-config .syn-ui-disclosure .dsh-disclosure__title {
  flex: 1 1 0;
  min-width: 0;
  text-align: start;
}
.syn-config .syn-ui-line {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding-inline-start: 4px;
  line-height: 1.4;
}
.syn-config .syn-ui-line .syn-label {
  overflow-wrap: anywhere;
}
.syn-config .syn-ui-search {
  width: min(100%, 330px);
}
.syn-config .syn-ui-actions {
  margin-top: 12px;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}
.syn-config .syn-ui-buttons {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: end;
}
@container synapse (max-width: 480px) {
  .syn-config .syn-ui-search {
    width: 100%;
  }
  .syn-config .syn-ui-line {
    gap: 6px;
  }
  .syn-config .syn-ui-disclosure .dsh-disclosure__header--expandable {
    padding-inline: 8px;
  }
  .syn-config .syn-ui-actions {
    flex-wrap: wrap;
    gap: 6px;
  }
}

/* The actual loader draws a draggable thumb instead of a native scrollbar. */
:is(.syn-dialog,.synapse-editor) .dshl-scrollbar-thumb {
  opacity: 0;
}
:is(.syn-dialog,.synapse-editor) .dshl-scrollbar-thumb:focus-visible,
:is(.syn-dialog,.synapse-editor) .dshl-scrollbar-thumb:active {
  opacity: 1;
}
@media (hover: hover) {
  :is(.syn-dialog,.synapse-editor) .dshl-scrollbar:hover > .dshl-scrollbar-thumb {
    opacity: 1;
  }
}
@media (max-height: 640px) {
  .dsh-ui[data-theme][data-radius] .arco-modal-wrapper-align-center:has(.arco-modal.syn-dialog[role="dialog"]) {
    padding-block: min(4dvh, 18px);
  }
  .dsh-ui[data-theme][data-radius] .arco-modal.syn-dialog[role="dialog"] {
    max-height: calc(100dvh - min(8dvh, 36px));
  }
}
@media (max-width: 639px) {
  .dsh-ui[data-theme][data-radius] .arco-modal-wrapper-align-center:has(.arco-modal.syn-dialog[role="dialog"]) {
    padding-inline: 16px;
  }
}

/* The loader owns this card. Its default form has no visible fields. */
.dshl-config-form:has(> [data-config-panel="synapse-settings"]) > form,
[data-config-panel="synapse-settings"] > h3 { display: none; }
.dshl-config-form > [data-config-panel="synapse-settings"] { padding: 0; margin: 0; border: 0; }
.syn-config .syn-notice[role="alert"] { color: var(--dsw-alias-status-error, #b64545); }
`;
