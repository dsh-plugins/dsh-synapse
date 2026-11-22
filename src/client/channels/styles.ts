export const CHANNEL_CSS = `
.synapse-channels { container: syn-channels / inline-size; width: 100%; min-width: 0; }
.channel-fields, .channel-grid, .channel-name { display: grid; min-width: 0; gap: 12px; }
.channel-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }
.channel-heading { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; justify-content: space-between; }
.channel-heading h3 { margin: 0; font-size: 15px; }
.channel-name { gap: 2px; overflow-wrap: anywhere; }
.channel-name small { color: var(--dsw-alias-label-secondary); }
.channel-fields details > summary { cursor: pointer; }
.channel-fields details[open] > summary { margin-block-end: 12px; }
.channel-fields p { margin: 0; }
.synapse-channel-dialog .synapse-activity-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr)); gap:10px; }
.synapse-channel-dialog .synapse-activity-field { display:grid; gap:6px; }
.synapse-channel-dialog .synapse-activity-help { color:var(--dsw-alias-label-secondary); font-size:12px; }
@container syn-channels (max-width: 470px) { .channel-grid { grid-template-columns: 1fr; } }
.groups-form {
  container: syn-groups / inline-size;
  width: 100%;
  min-width: 0;
  display: grid;
  gap: 12px;
}
.groups-toolbar {
  display: grid;
  grid-template-columns: minmax(130px, 1fr) minmax(100px, 132px) auto;
  align-items: center;
  gap: 8px;
}
.groups-toolbar > *, .groups-table { min-width: 0; }
.groups-toolbar > button { justify-self: end; }
.groups-pagination, .groups-views, .groups-tags, .groups-row-actions, .groups-dialog-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.groups-tags { gap: 4px; }
.groups-hint, .groups-id, .groups-pagination { color: var(--muted, var(--dsw-alias-label-secondary)); }
.groups-id, .groups-hint, .groups-error { margin: 0; }
.groups-pagination, .groups-dialog-actions { justify-content: flex-end; }
.groups-dialog-actions > button:first-child { margin-right: auto; }
.groups-dialog-content { display: grid; gap: 12px; min-width: 0; }
.groups-id, .groups-number { font-variant-numeric: tabular-nums; }
.groups-number { white-space: nowrap; }
.groups-name, .groups-table .arco-table-cell { overflow-wrap: anywhere; }
.groups-row-actions { flex-wrap: nowrap; gap: 2px; }
.dsh-ui[data-theme][data-radius] .groups-row-actions > button.arco-btn { padding-inline: 6px; }
.dsh-ui[data-theme] .groups-table th.arco-table-th.arco-table-col-fixed-right {
  position: sticky;
  right: 0;
  z-index: 2;
}
.groups-bridge {
  display: grid;
  min-inline-size: 0;
  gap: 8px;
  margin: 0;
  padding: 10px;
  border: 1px solid var(--line, var(--dsw-alias-border-l1));
  border-radius: 8px;
}
.groups-bridge legend { padding: 0 4px; overflow-wrap: anywhere; }
.groups-bridge > button { justify-self: start; }
.groups-error { color: var(--dsw-alias-danger, light-dark(#ad332b, #ffaaa4)); overflow-wrap: anywhere; }
@container syn-groups (max-width: 440px) {
  .groups-toolbar { grid-template-columns: minmax(90px, 1fr) auto; }
  .groups-toolbar > :first-child { grid-column: 1 / -1; }
}

`;
