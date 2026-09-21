'use strict';
(async () => {
  const byId = id => document.getElementById(id);
  const metrics = {};
  const decodedSamples = new Map();
  const decodedRecords = new Set();
  const checks = [];
  let page = 0;
  let busy;
  let manifest;
  const assert = (value, label) => {
    checks.push({ label, passed: Boolean(value) });
    if (!value) throw new Error(label);
  };
  const imageRequests = () => performance.getEntriesByType('resource').filter(entry => entry.name.includes('/photo/'));
  async function decode(image) {
    let timeout;
    try {
      await Promise.race([
        image.decode(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('图片加载超时')), 15_000); }),
      ]);
      if (!image.complete || !image.naturalWidth || !image.naturalHeight) throw new Error('图片未正确解码');
    } finally { clearTimeout(timeout); }
  }
  async function render(target) {
    page = target;
    byId('error').textContent = '';
    const start = page * manifest.pageSize;
    const photos = manifest.photos.slice(start, start + manifest.pageSize);
    byId('page').textContent = (page + 1) + ' / ' + Math.ceil(manifest.count / manifest.pageSize);
    byId('previous').disabled = page === 0;
    byId('next').disabled = start + manifest.pageSize >= manifest.count;
    byId('grid').replaceChildren();
    const jobs = photos.map(photo => {
      const figure = document.createElement('figure');
      figure.dataset.photoId = String(photo.id);
      const button = document.createElement('button');
      button.setAttribute('aria-label', '查看第 ' + (photo.id + 1) + ' 张原图');
      const image = document.createElement('img');
      image.alt = '样本 ' + manifest.samples[photo.sample].name;
      image.src = photo.url;
      button.append(image);
      button.onclick = () => { busy = openPhoto(photo); };
      const caption = document.createElement('figcaption');
      caption.textContent = '第 ' + (photo.id + 1) + ' 张 · ' + manifest.samples[photo.sample].name;
      figure.append(button, caption);
      byId('grid').append(figure);
      return decode(image).then(() => {
        decodedSamples.set(photo.sample, { sample: photo.sample, width: image.naturalWidth, height: image.naturalHeight });
        decodedRecords.add(photo.id);
      });
    });
    await Promise.all(jobs);
    return photos.map(item => item.id);
  }
  async function openPhoto(photo) {
    const image = byId('original');
    byId('error').textContent = '';
    image.src = photo.url + '?detail=1';
    byId('viewer').showModal();
    try {
      await decode(image);
      return [image.naturalWidth, image.naturalHeight];
    } catch {
      byId('viewer').close();
      image.removeAttribute('src');
      byId('error').textContent = '照片加载失败，请重试。';
      return null;
    }
  }
  let result;
  try {
    const totalStart = performance.now();
    manifest = await (await fetch('./manifest')).json();
    // Catalog construction is metadata-only; this is not a database capacity test.
    const metadataStart = performance.now();
    const catalog = Array.from({ length: manifest.catalogCount }, (_, id) => ({ id, year: 2024, order: id }));
    metrics.metadata3000Ms = performance.now() - metadataStart;
    assert(catalog.length === 3000, '3000 条合成元数据可构造');
    byId('next').onclick = () => { busy = render(page + 1); };
    byId('previous').onclick = () => { busy = render(page - 1); };
    byId('last').onclick = () => { busy = render(Math.ceil(manifest.count / manifest.pageSize) - 1); };
    byId('close').onclick = () => { byId('viewer').close(); byId('original').removeAttribute('src'); };
    const firstStart = performance.now();
    await render(0);
    metrics.firstPageMs = performance.now() - firstStart;
    metrics.firstPagePhotoRequests = imageRequests().length;
    assert(imageRequests().length === 12, '首屏仅请求 12 张原图');
    assert(document.querySelectorAll('#grid img').length === 12, '首屏只挂载 12 张照片');
    const detailStart = performance.now();
    byId('grid').querySelector('button').click();
    await busy;
    metrics.originalOpenMs = performance.now() - detailStart;
    const detailDimensions = [byId('original').naturalWidth, byId('original').naturalHeight];
    assert(detailDimensions[0] > 0 && detailDimensions[1] > 0, '点开使用可解码的完整原图');
    byId('close').click();
    assert(!byId('viewer').open && page === 0 && byId('grid').firstChild.dataset.photoId === '0', '返回原图后保留当前页和照片位置');
    const pages = [{ page: 0, ms: metrics.firstPageMs, count: 12 }];
    const sequentialStart = performance.now();
    for (let target = 1; target < Math.ceil(manifest.count / manifest.pageSize); target++) {
      const start = performance.now();
      byId('next').click();
      await busy;
      const ids = [...document.querySelectorAll('#grid figure')].map(node => Number(node.dataset.photoId));
      const expectedIds = manifest.photos.slice(target * manifest.pageSize, (target + 1) * manifest.pageSize).map(item => item.id);
      assert(ids.join(',') === expectedIds.join(','), '第 ' + (target + 1) + ' 页完整 ID 序列正确');
      pages.push({ page: target, ms: performance.now() - start, count: ids.length });
    }
    metrics.sequentialRemainingPagesMs = performance.now() - sequentialStart;
    metrics.pageTimesMs = pages;
    metrics.all400PagesDecoded = pages.reduce((sum, item) => sum + item.count, 0);
    assert(metrics.all400PagesDecoded === 400 && decodedRecords.size === 400 &&
      manifest.photos.every(photo => decodedRecords.has(photo.id)), '400 个不同记录 ID 均已解码');
    const lastIds = [...document.querySelectorAll('#grid figure')].map(node => Number(node.dataset.photoId));
    assert(lastIds.join(',') === '396,397,398,399', '末页为第 397–400 条记录');
    assert(decodedSamples.size === manifest.samples.length, '所有 23 张源 JPG 均实际解码');
    const failedPhoto = await openPhoto({ url: './photo/999999.jpg' });
    assert(failedPhoto === null && byId('error').textContent.includes('加载失败') && !byId('viewer').open,
      '原图查看遇到 404 时显示错误并关闭失败弹窗');
    const retryDimensions = await openPhoto(manifest.photos[396]);
    assert(retryDimensions?.[0] > 0 && !byId('error').textContent, '原图失败后重新打开有效照片成功');
    byId('close').click();
    byId('previous').click();
    await busy;
    assert(!byId('error').textContent && page === 32, '失败后可继续浏览');
    await render(0);
    metrics.totalMs = performance.now() - totalStart;
    result = { passed: true, userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory, metrics, originalDimensions: detailDimensions,
      decodedSamples: [...decodedSamples.values()], checks };
    byId('status').textContent = '验证完成：23 张原图解码成功，400 条合成记录已逐页遍历。';
    byId('report').textContent = '首屏 ' + Math.round(metrics.firstPageMs) + ' ms · 原图打开 ' +
      Math.round(metrics.originalOpenMs) + ' ms · 分批遍历共 ' + Math.round(metrics.totalMs / 1000) + ' 秒\n' +
      '结果仅代表本机 Edge 无界面测试；不代表 400 张不同照片、真实桌面体验或互联网性能。';
  } catch (error) {
    result = { passed: false, error: error.message, userAgent: navigator.userAgent, metrics, checks };
    byId('status').textContent = '验证失败：' + error.message;
  }
  document.documentElement.dataset.probeStatus = result.passed ? 'passed' : 'failed';
  await fetch('./result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
})();
