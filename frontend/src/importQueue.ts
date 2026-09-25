export type Numbering = { year: number; order: number }
export type Draft = { id: string; file: File; year: string; numbering: Numbering | null }
export type Metadata = { original_filename: string; byte_size: number; sha256: string }
export type ImportItem = { id: string; item_index: number; original_filename: string; byte_size: number; state: string; failure_code: string | null }
export type ImportReceipt = { batch_id: string; album_id: string; photo_ids: string[]; failed_item_ids: string[]; album_revision: number }
export type ImportBatch = { id: string; album_id: string; album_revision: number; state: string; expires_at: string; items: ImportItem[]; result: ImportReceipt | null }
export type QueueBatch = ImportBatch & { queue_index: number; city_id: string; year: number | null }
export type Entry = { name: string; size: number; file?: File; metadata?: Metadata; item?: ImportItem; progress: number; activity?: string; error?: string }
export type Job = { index: number; year: number | null; albumId?: string; entries: Entry[]; batch?: ImportBatch; createAttempted?: boolean; error?: string; review?: boolean; canceled?: boolean; commit?: { expected_album_revision: number; allow_partial: boolean } }

export function filenameNumbering(name: string): Numbering | null {
  const match = name.match(/^(\d{4}|\d{2})-(\d+)(?=\D|$)/)
  if (!match) return null
  const year = match[1].length === 2 ? 2000 + Number(match[1]) : Number(match[1])
  const order = Number(match[2])
  return year >= 1 && Number.isSafeInteger(order) ? { year, order } : null
}

export function validYear(year: string) { return year === 'unmarked' || (/^\d{1,4}$/.test(year) && Number(year) >= 1) }
export function yearLabel(year: number | null) { return year === null ? '未标年份' : `${year} 年` }

// Stable numeric order is only an initial suggestion. A mixed unnumbered
// selection keeps its chosen order; subsequent user moves are never re-sorted.
export function prepare(files: File[], fixedYear?: number | null): Draft[] {
  const rows = files.map((file) => {
    const numbering = filenameNumbering(file.name)
    return { id: crypto.randomUUID(), file, numbering, year: fixedYear !== undefined ? String(fixedYear ?? 'unmarked') : numbering ? String(numbering.year) : '' }
  })
  return rows.every((row) => row.numbering) ? rows.sort((a, b) =>
    (fixedYear === undefined ? a.numbering!.year - b.numbering!.year : 0) || a.numbering!.order - b.numbering!.order) : rows
}

export function planJobs(rows: Draft[], albumId?: string): Job[] {
  const groups = new Map<string, Draft[]>()
  for (const row of rows) {
    if (!validYear(row.year)) throw new Error('请为每个文件核对年份或选择未标年份')
    const key = row.year === 'unmarked' ? row.year : String(Number(row.year))
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }
  const jobs: Job[] = []
  for (const [year, entries] of groups) {
    for (let offset = 0; offset < entries.length; offset += 400) {
      jobs.push({ index: jobs.length, year: year === 'unmarked' ? null : Number(year), albumId,
        entries: entries.slice(offset, offset + 400).map(({ file }) => ({ name: file.name, size: file.size, file, progress: 0 })) })
    }
  }
  return jobs
}

export function applyBatch(job: Job, batch: ImportBatch) {
  job.batch = batch
  job.albumId = batch.album_id
  job.canceled = batch.state === 'canceled' || (batch.state === 'expired' && batch.items.every((item) => item.state === 'discarded'))
  batch.items.forEach((item, index) => {
    const entry = job.entries[index]
    entry.item = item
    if (['staged', 'committed'].includes(item.state)) { entry.progress = 100; entry.file = undefined; entry.error = undefined }
  })
}

export function canCommit(job: Job, jobs: Job[]) {
  return !!job.batch && job.batch.state === 'open' && !job.review && !job.canceled && !jobs.some((earlier) =>
    earlier.index < job.index && earlier.year === job.year && !earlier.canceled && earlier.batch?.state !== 'committed' && earlier.batch?.state !== 'canceled')
}
