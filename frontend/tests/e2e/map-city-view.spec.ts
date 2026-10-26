import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { cityView } from '../../src/features/map/mapCityView'
import { screen } from '../../src/features/map/mapGeometry'
import type { Geometry, Point, View } from '../../src/features/map/mapGeometry'

type Size = { width: number; height: number }
const asset = JSON.parse(readFileSync(new URL('../../public/map-data/china-cities.v1.json', import.meta.url), 'utf8')) as {
  regions: { name: string; center: Point; geometry: Geometry | null }[]
}

function extent(geometry: Geometry, view: View, size: Size) {
  const points = geometry.flat(2).map(point => screen(point, view, size.width, size.height))
  return { left: Math.min(...points.map(point => point[0])), right: Math.max(...points.map(point => point[0])),
    top: Math.min(...points.map(point => point[1])), bottom: Math.max(...points.map(point => point[1])) }
}

function expectVisible(geometry: Geometry, view: View, size: Size) {
  const box = extent(geometry, view, size)
  const padding = size.width < 500 ? 24 : 56, reserved = size.width < 500 ? 132 : 106
  expect(box.left).toBeGreaterThanOrEqual(padding - .001)
  expect(box.right).toBeLessThanOrEqual(size.width - padding + .001)
  expect(box.top).toBeGreaterThanOrEqual(padding - .001)
  expect(box.bottom).toBeLessThanOrEqual(size.height - reserved - padding + .001)
  return box
}

test('港澳珠海按真实几何放大，桌面及手机全境可见且避开信息卡', () => {
  for (const size of [{ width: 900, height: 640 }, { width: 290, height: 410 }]) {
    for (const name of ['香港特别行政区', '澳门特别行政区', '珠海市']) {
      const region = asset.regions.find(region => region.name === name)!
      const view = cityView(region.geometry!, size, size.width < 500 ? 2.46 : 4, region.center)
      expect(view.zoom).toBeGreaterThan(7)
      expect(view.zoom).toBeLessThanOrEqual(10)
      const box = expectVisible(region.geometry!, view, size)
      if (name === '澳门特别行政区') {
        expect(view.zoom).toBe(10)
        expect(box.right - box.left).toBeGreaterThan(35)
        expect(box.bottom - box.top).toBeGreaterThan(70)
      } else expect(box.right - box.left).toBeGreaterThan(180)
    }
  }
})

test('手机小区域定位比旧固定倍率清晰，通用于其他小城市', () => {
  const size = { width: 290, height: 410 }, minimum = 2.46
  for (const name of ['澳门特别行政区', '厦门市', '台北市', '舟山市']) {
    const region = asset.regions.find(region => region.name === name)!
    const view = cityView(region.geometry!, size, minimum, region.center)
    const before = extent(region.geometry!, { center: region.center, zoom: minimum + 2.5 }, size)
    const after = expectVisible(region.geometry!, view, size)
    expect(after.right - after.left).toBeGreaterThan((before.right - before.left) * 3)
  }
})

test('定位依据全部离岛和孔洞的真实范围，忽略偏离的目录中心且不改几何', () => {
  const geometry: Geometry = [
    [[[120, 30], [120.7, 30], [120.7, 30.5], [120, 30.5], [120, 30]],
      [[120.1, 30.1], [120.2, 30.1], [120.2, 30.2], [120.1, 30.2], [120.1, 30.1]]],
    [[[121.3, 31.1], [121.4, 31.1], [121.4, 31.2], [121.3, 31.2], [121.3, 31.1]]],
  ]
  const original = JSON.stringify(geometry), size = { width: 900, height: 640 }
  const view = cityView(geometry, size, 4, [74, 10])
  expectVisible(geometry, view, size)
  expect(view.center[0]).toBeGreaterThan(120)
  expect(view.center[0]).toBeLessThan(122)
  expect(view.center[1]).toBeGreaterThan(29)
  expect(JSON.stringify(geometry)).toBe(original)
})

test('缺失或退化市界与极小画布安全回退，缩放始终有界', () => {
  const fallback: Point = [114, 23]
  for (const geometry of [undefined, [], [[[]]], [[[[114, 23], [114, 23], [114, 23], [114, 23]]]]] as (Geometry | undefined)[]) {
    expect(cityView(geometry, { width: 900, height: 640 }, 4, fallback)).toEqual({ center: fallback, zoom: 6.5 })
    expect(cityView(geometry, { width: 900, height: 640 }, 9, fallback).zoom).toBe(10)
  }
  const geometry = asset.regions.find(region => region.name === '澳门特别行政区')!.geometry!
  for (const size of [{ width: 1, height: 1 }, { width: 0, height: 0 }, { width: NaN, height: 410 }]) {
    const view = cityView(geometry, size, 4, fallback)
    expect([...view.center, view.zoom].every(Number.isFinite)).toBe(true)
    expect(view.zoom).toBeGreaterThanOrEqual(4)
    expect(view.zoom).toBeLessThanOrEqual(10)
  }
})
