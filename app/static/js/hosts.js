// hosts.js — compatibility shim
// Evita doble bootstrap cuando index.html carga app.js y hosts.js a la vez.
// app.js ya inicializa DataTables, filtros, WoL y resto del bloque Hosts.

(function () {
  if (window.__AUDITOR_HOSTS_COMPAT_SHIM__) return;
  window.__AUDITOR_HOSTS_COMPAT_SHIM__ = true;

  const hasDT = !!(window.jQuery && jQuery.fn && jQuery.fn.DataTable);
  const hostsReady = !!window.hostsTable || (hasDT && jQuery.fn.DataTable.isDataTable('#hosts'));
  const scansReady = !!window.scansTable || (hasDT && jQuery.fn.DataTable.isDataTable('#scans'));

  if (hostsReady || scansReady) {
    console.info('[hosts.js] Compat shim activo: app.js ya bootstrapó la vista Hosts. Se omite el bootstrap legado duplicado.');
    return;
  }

  //console.warn('[hosts.js] Compat shim cargado sin bootstrap previo de app.js. No se ejecuta bootstrap legado para evitar dobles inicializaciones.');
})();
