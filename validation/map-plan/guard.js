'use strict';
window.auditErrors = [];
window.addEventListener('error', event => {
  // Do not retain provider URLs, response bodies or raw credential-bearing errors.
  if (event.message) window.auditErrors.push({ kind: 'script', message: 'A script raised an error' });
}, true);
window.addEventListener('unhandledrejection', () => window.auditErrors.push({ kind: 'unhandled-rejection' }));
