// Which strategy the service worker uses for a request. Pure on purpose: sw.js loads this file
// with importScripts, and the unit tests evaluate this same file, so what is tested is what ships.
(function (root) {
  'use strict';

  // Live data and auth. The worker must never see, cache or delay these.
  var NEVER = ['/api', '/auth', '/omp-ws', '/healthz', '/.well-known', '/classic', '/static'];

  function underPrefix(path, prefix) {
    return path === prefix || path.indexOf(prefix + '/') === 0;
  }

  /**
   * @param {{ method: string, url: string, mode?: string, range?: boolean }} req
   * @param {string} origin the worker's own origin
   * @returns {'navigate' | 'asset' | 'bypass'}
   */
  function route(req, origin) {
    if (req.method !== 'GET') return 'bypass';
    if (req.range) return 'bypass';
    var url;
    try {
      url = new URL(req.url, origin);
    } catch (e) {
      return 'bypass';
    }
    if (url.origin !== origin) return 'bypass';
    var path = url.pathname;
    for (var i = 0; i < NEVER.length; i++) if (underPrefix(path, NEVER[i])) return 'bypass';
    if (req.mode === 'navigate') return 'navigate';
    if (path.indexOf('/assets/') === 0) return 'asset';
    return 'bypass';
  }

  root.ompSwRouting = { route: route };
})(typeof self !== 'undefined' ? self : globalThis);
