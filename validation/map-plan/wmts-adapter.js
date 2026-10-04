'use strict';
(() => {
  const size = 256;
  class LngLat {
    constructor(lng, lat) { this.lng = lng; this.lat = lat; }
    getLng() { return this.lng; }
    getLat() { return this.lat; }
  }
  function project({ lng, lat }, zoom) {
    const scale = size * 2 ** zoom;
    const phi = lat * Math.PI / 180;
    return [(lng + 180) / 360 * scale,
      (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2 * scale];
  }
  function unproject([x, y], zoom) {
    const scale = size * 2 ** zoom;
    return new LngLat(x / scale * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / scale))) * 180 / Math.PI);
  }
  class Map {
    constructor(id, key) {
      this.element = document.getElementById(id);
      this.key = key;
      this.element.style.position = 'relative';
      this.element.style.overflow = 'hidden';
    }
    centerAndZoom(center, zoom) {
      if (!Number.isInteger(zoom) || zoom < 3 || zoom > 9 || Math.abs(center.lat) > 80) throw new Error('Audit viewport out of bounds');
      this.center = center; this.zoom = zoom;
      const [x, y] = project(center, zoom);
      const width = this.element.clientWidth, height = this.element.clientHeight;
      const left = x - width / 2, top = y - height / 2;
      const columns = [Math.floor(left / size), Math.floor((left + width - 1) / size)];
      const rows = [Math.max(0, Math.floor(top / size)), Math.min(2 ** zoom - 1, Math.floor((top + height - 1) / size))];
      if ((columns[1] - columns[0] + 1) * (rows[1] - rows[0] + 1) * 2 > 100) throw new Error('Audit viewport tile budget exceeded');
      const content = document.createDocumentFragment();
      for (const layer of ['vec', 'cva']) {
        for (let column = columns[0]; column <= columns[1]; column++) {
          for (let row = rows[0]; row <= rows[1]; row++) {
            const url = new URL('https://t0.tianditu.gov.cn/' + layer + '_w/wmts');
            url.search = new URLSearchParams({ SERVICE: 'WMTS', REQUEST: 'GetTile', VERSION: '1.0.0',
              LAYER: layer, STYLE: 'default', TILEMATRIXSET: 'w', FORMAT: 'tiles',
              TILEMATRIX: String(zoom), TILEROW: String(row), TILECOL: String((column + 2 ** zoom) % 2 ** zoom), tk: this.key });
            const image = document.createElement('img');
            image.alt = '';
            image.width = size; image.height = size;
            image.style.cssText = 'position:absolute;width:256px;height:256px;max-width:none;left:' + (column * size - left)
              + 'px;top:' + (row * size - top) + 'px;z-index:' + (layer === 'cva' ? 1 : 0);
            image.src = url.href;
            content.append(image);
          }
        }
      }
      const attribution = document.createElement('div');
      attribution.className = 'tdt-control-copyright';
      attribution.style.cssText = 'position:absolute;bottom:0;left:0;z-index:2;background:#fff;padding:2px 6px;font-size:12px';
      // Observed in the official SDK on 2026-10-04. This audit-only label must not
      // be copied as a permanent production approval number.
      attribution.textContent = '来源：天地图 · 底图 GS (2026) 4921号（2026-10-04 核对，仅测试）';
      content.append(attribution);
      this.element.replaceChildren(content);
    }
    getCenter() { return this.center; }
    getZoom() { return this.zoom; }
    getBounds() {
      const [x, y] = project(this.center, this.zoom);
      const w = this.element.clientWidth / 2, h = this.element.clientHeight / 2;
      return { getSouthWest: () => unproject([x - w, y + h], this.zoom),
        getNorthEast: () => unproject([x + w, y - h], this.zoom) };
    }
  }
  window.MapAuditWmts = {
    LngLat,
    async create(id) {
      const response = await fetch('./map-config', { cache: 'no-store' });
      const config = await response.json();
      if (!response.ok || !/^[a-f\d]{32}$/i.test(config.key || '')) throw new Error('Map configuration unavailable');
      return new Map(id, config.key);
    },
  };
})();
