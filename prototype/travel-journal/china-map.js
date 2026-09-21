'use strict';

// SVG uses geographic coordinates directly. No bitmap enlargement or CSS rotation.
window.CityAtlas = class CityAtlas {
  constructor(container, { onCitySelect }) {
    this.container = container;
    this.onCitySelect = onCitySelect;
    this.scale = 1;
    this.offset = [0, 0];
    this.cityData = [];
    this.photoCounts = new Map();
    this.boundaries = new Map();
    this.svgNS = 'http://www.w3.org/2000/svg';
    this.svg = this.element('svg', { viewBox: '0 0 1000 710', class: 'china-atlas', 'aria-label': '中国城市地图，点击城市查看年份影集' });
    const defs = this.element('defs');
    const mainClip = this.element('clipPath', { id: 'atlas-main-clip' });
    mainClip.append(this.element('rect', { x: 0, y: 0, width: 1000, height: 710 }));
    defs.append(mainClip);
    const insetClip = this.element('clipPath', { id: 'atlas-south-clip' });
    insetClip.append(this.element('rect', { x: 845, y: 447, width: 123, height: 185 }));
    defs.append(insetClip);
    this.svg.append(defs);
    this.viewport = this.element('g', { 'clip-path': 'url(#atlas-main-clip)' });
    this.world = this.element('g');
    this.background = this.element('g');
    this.regions = this.element('g');
    this.points = this.element('g');
    this.labels = this.element('g');
    this.world.append(this.background, this.regions, this.points, this.labels);
    this.viewport.append(this.world);
    this.svg.append(this.viewport);
    this.inset = this.element('g', { 'aria-label': '南海诸岛附图' });
    this.svg.append(this.inset);
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'atlas-tooltip';
    this.tooltip.hidden = true;
    container.replaceChildren(this.svg, this.tooltip);
    this.installEvents();
    this.setProjection();
  }
  element(name, attributes = {}) {
    const element = document.createElementNS(this.svgNS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  }
  rawProject([longitude, latitude]) {
    const rad = Math.PI / 180;
    const n = (Math.sin(25 * rad) + Math.sin(47 * rad)) / 2;
    const c = Math.cos(25 * rad) ** 2 + 2 * n * Math.sin(25 * rad);
    const rho = Math.sqrt(c - 2 * n * Math.sin(latitude * rad)) / n;
    const rho0 = Math.sqrt(c - 2 * n * Math.sin(38 * rad)) / n;
    const theta = n * (longitude - 105) * rad;
    return [rho * Math.sin(theta), rho * Math.cos(theta) - rho0];
  }
  setProjection() {
    const reference = [[73, 39], [80, 49], [135, 48], [123, 54], [110, 18], [122, 23], [90, 28]];
    const points = reference.map(point => this.rawProject(point));
    const minX = Math.min(...points.map(p => p[0]));
    const maxX = Math.max(...points.map(p => p[0]));
    const minY = Math.min(...points.map(p => p[1]));
    const maxY = Math.max(...points.map(p => p[1]));
    const ratio = Math.min(900 / (maxX - minX), 590 / (maxY - minY));
    this.project = point => {
      const [x, y] = this.rawProject(point);
      return [(x - (minX + maxX) / 2) * ratio + 500, (y - (minY + maxY) / 2) * ratio + 357];
    };
  }
  pathFor(geometry, project = this.project) {
    if (!geometry) return '';
    if (geometry.type === 'Feature') return this.pathFor(geometry.geometry, project);
    if (geometry.type === 'FeatureCollection') return geometry.features.map(feature => this.pathFor(feature, project)).join('');
    if (geometry.type === 'GeometryCollection') return geometry.geometries.map(part => this.pathFor(part, project)).join('');
    const line = (points, close) => points.map((point, index) => {
      const [x, y] = project(point);
      return `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join('') + (close ? 'Z' : '');
    if (geometry.type === 'Polygon') return geometry.coordinates.map(ring => line(ring, true)).join('');
    if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(polygon => polygon.map(ring => line(ring, true)).join('')).join('');
    if (geometry.type === 'LineString') return line(geometry.coordinates, false);
    if (geometry.type === 'MultiLineString') return geometry.coordinates.map(points => line(points, false)).join('');
    return '';
  }
  setData(cities, outline) {
    this.cityData = cities;
    this.outline = outline;
    if (outline?.metadata) this.container.dataset.boundaryInfo = JSON.stringify(outline.metadata);
    this.background.replaceChildren();
    const parts = outline?.type === 'FeatureCollection' ? outline.features : outline ? [outline] : [];
    // Fill each source feature separately so overlaps do not become even-odd holes.
    for (const part of parts) this.background.append(this.element('path', { d: this.pathFor(part), class: 'country-outline', 'fill-rule': 'evenodd' }));
    this.inset.replaceChildren();
    if (outline) {
      this.inset.append(this.element('rect', { x: 839, y: 439, width: 135, height: 217, rx: 2, class: 'inset-frame' }));
      const projectInset = ([lng, lat]) => [845 + (lng - 105) / 20 * 123, 447 + (25 - lat) / 23 * 185];
      for (const part of parts) this.inset.append(this.element('path', { d: this.pathFor(part, projectInset), class: 'country-outline', 'fill-rule': 'evenodd', 'clip-path': 'url(#atlas-south-clip)' }));
      const label = this.element('text', { x: 906, y: 646, 'text-anchor': 'middle', class: 'inset-label' });
      label.textContent = '南海诸岛';
      this.inset.append(label);
    }
    this.draw();
  }
  setBoundary(id, feature) {
    if (!feature?.geometry) return;
    this.boundaries.set(id, feature);
    this.draw();
  }
  updateCounts(counts) {
    this.photoCounts = new Map(counts);
    this.draw();
  }
  draw() {
    this.regions.replaceChildren();
    this.points.replaceChildren();
    this.labels.replaceChildren();
    const labelled = [];
    // Country outlines are never treated as city album targets.
    for (const city of this.cityData) {
      const count = this.photoCounts.get(city.id) || 0;
      const feature = this.boundaries.get(city.id);
      if (count && feature) {
        this.regions.append(this.element('path', { d: this.pathFor(feature), class: 'city-region lit', 'data-city': city.id, 'fill-rule': 'evenodd', 'aria-label': `${city.name}，${count} 张照片` }));
      }
    }
    const ordered = [...this.cityData].sort((a, b) => (this.photoCounts.get(a.id) || 0) - (this.photoCounts.get(b.id) || 0));
    for (const city of ordered) {
      if (!Number.isFinite(city.lng) || !Number.isFinite(city.lat)) continue;
      const [x, y] = this.project([city.lng, city.lat]);
      const count = this.photoCounts.get(city.id) || 0;
      const group = this.element('g', { 'data-city': city.id, role: 'button', tabindex: 0, 'aria-label': `${city.name}，${count ? `${count} 张照片，已点亮` : '尚无照片'}` });
      // A small fixed-size marker helps locate compact cities without covering their area when zoomed in.
      const dot = this.element('circle', { cx: x, cy: y, r: count ? 3.5 / this.scale : 2 / Math.sqrt(this.scale), class: count ? 'photo-point' : 'unlit-point' });
      group.append(dot, this.element('circle', { cx: x, cy: y, r: 7 / this.scale, class: 'city-hit' }));
      const title = this.element('title');
      title.textContent = `${city.name} · ${count ? `${count} 张照片` : '还没有照片'}`;
      group.append(title);
      this.points.append(group);
      if (count) labelled.push({ city, x, y, count });
    }
    for (const { city, x, y, count } of labelled) {
      const label = this.element('text', { x: x + 10 / this.scale, y: y - 10 / this.scale, class: 'atlas-label photo-label', 'font-size': 14 / this.scale });
      label.style.fontSize = `${14 / this.scale}px`;
      label.textContent = `${city.name} · ${count}`;
      this.labels.append(label);
    }
    this.applyTransform();
  }
  applyTransform() {
    this.world.setAttribute('transform', `translate(${this.offset[0]},${this.offset[1]}) translate(500,355) scale(${this.scale}) translate(-500,-355)`);
  }
  reset() { this.scale = 1; this.offset = [0, 0]; this.tooltip.hidden = true; this.draw(); }
  zoom(factor) { this.scale = Math.min(8, Math.max(1, this.scale * factor)); if (this.scale === 1) this.offset = [0, 0]; this.draw(); }
  showTooltip(cityId, clientX, clientY) {
    const city = this.cityData.find(item => item.id === cityId);
    if (!city) return;
    const count = this.photoCounts.get(city.id) || 0;
    const heading = document.createElement('strong'); heading.textContent = city.name;
    const countLine = document.createElement('span'); countLine.textContent = count ? `${count} 张照片 · 已点亮` : '还没有照片 · 可以先建影集';
    const action = document.createElement('small'); action.textContent = '点击查看年份影集 ↗';
    this.tooltip.replaceChildren(heading, countLine, action);
    this.tooltip.hidden = false;
    const box = this.container.getBoundingClientRect();
    this.tooltip.style.left = `${Math.min(Math.max(10, clientX - box.left + 15), box.width - 180)}px`;
    this.tooltip.style.top = `${Math.max(12, Math.min(clientY - box.top - 100, box.height - 110))}px`;
  }
  installEvents() {
    let drag = null;
    let moved = false;
    this.svg.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      moved = false;
      drag = { x: event.clientX, y: event.clientY, offset: [...this.offset] };
      this.svg.setPointerCapture(event.pointerId);
    });
    this.svg.addEventListener('pointermove', event => {
      if (drag) {
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (Math.hypot(dx, dy) > 4) moved = true;
        if (moved && this.scale > 1) {
          const box = this.svg.getBoundingClientRect();
          const ratio = Math.max(1000 / box.width, 710 / box.height);
          this.offset = [drag.offset[0] + dx * ratio, drag.offset[1] + dy * ratio];
          this.applyTransform();
          this.tooltip.hidden = true;
        }
      } else {
        const cityId = event.target.closest('[data-city]')?.dataset.city;
        if (cityId) this.showTooltip(cityId, event.clientX, event.clientY);
        else this.tooltip.hidden = true;
      }
    });
    this.svg.addEventListener('pointerup', event => {
      if (!drag || event.button !== 0) return;
      drag = null;
      // Pointer capture redirects the event, so pick the actual city under the cursor.
      if (!moved) {
        const cityId = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-city]')?.dataset.city;
        if (cityId) { this.tooltip.hidden = true; this.onCitySelect(cityId); }
      }
    });
    this.svg.addEventListener('pointercancel', () => { drag = null; });
    this.svg.addEventListener('pointerleave', () => { if (!drag) this.tooltip.hidden = true; });
    this.svg.addEventListener('keydown', event => {
      const cityId = event.target.closest('[data-city]')?.dataset.city;
      if (cityId && ['Enter', ' '].includes(event.key)) { event.preventDefault(); this.onCitySelect(cityId); }
    });
    this.svg.addEventListener('wheel', event => { event.preventDefault(); this.zoom(event.deltaY < 0 ? 1.16 : 1 / 1.16); }, { passive: false });
  }
};
