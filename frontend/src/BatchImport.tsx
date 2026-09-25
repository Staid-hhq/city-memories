import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api, ApiError, errorMessage, isAbort, uploadFile } from './api'
import { applyBatch, canCommit, planJobs, prepare, validYear, yearLabel } from './importQueue'
import type { Draft, ImportBatch, ImportItem, ImportReceipt, Job, QueueBatch } from './importQueue'

type Props = { cityId: string; cityName: string; albumId?: string; year?: number | null }
const accept = '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp'
const stateLabels: Record<string, string> = { pending: '等待上传', receiving: '服务端接收中，请查询状态', staged: '已传输，待保存', committed: '已加入影集', failed: '失败，可重试', discarded: '已废弃' }

export function BatchImport({ cityId, cityName, albumId, year }: Props) {
  const [search, setSearch] = useSearchParams()
  const [initialQueue] = useState(search.get('queue'))
  const queueId = useRef(initialQueue ?? crypto.randomUUID())
  const jobsRef = useRef<Job[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [draft, setDraft] = useState<Draft[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [locked, setLocked] = useState(!!initialQueue)
  const [busy, setBusy] = useState<string | null>(initialQueue ? '恢复队列' : null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [page, setPage] = useState(0)
  const [allYear, setAllYear] = useState('')
  const active = useRef<AbortController | null>(null)
  const alive = useRef(true)
  const input = useRef<HTMLInputElement | null>(null)
  const publish = () => { if (alive.current) setJobs([...jobsRef.current]) }

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; active.current?.abort() }
  }, [])
  useEffect(() => {
    if (!locked && !draft.length) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [locked, draft.length])

  useEffect(() => {
    if (!initialQueue) return
    const controller = new AbortController()
    active.current = controller
    void readQueue(initialQueue, controller.signal, cityId, albumId).then((batches) => {
      const restored = batches.map((batch) => restoredJob(batch))
      jobsRef.current = restored
      setJobs(restored)
      setNotice('已恢复服务端登记的批次。未登记的文件需另开队列重选；未传完的文件可在对应行重新选择。')
    }).catch((reason) => { if (!isAbort(reason)) setError(errorMessage(reason)) })
      .finally(() => { if (!controller.signal.aborted) setBusy(null) })
    return () => controller.abort()
  }, [initialQueue, cityId, albumId])

  async function run(label: string, task: (signal: AbortSignal) => Promise<void>) {
    if (active.current && busy) return
    const controller = new AbortController()
    active.current = controller
    setBusy(label); setError(''); setNotice('')
    try { await task(controller.signal) }
    catch (reason) { if (!isAbort(reason)) setError(errorMessage(reason)) }
    finally {
      if (alive.current && active.current === controller) {
        for (const job of jobsRef.current) for (const entry of job.entries) entry.activity = undefined
        setBusy(null); publish()
        if (controller.signal.aborted) setNotice('传输已停止，暂存不等于保存。请查询状态后重试或取消批次；已保存照片不受影响。')
      }
    }
  }

  function choose(files: File[]) {
    setError(''); setNotice(''); setConfirmed(false); setPage(0)
    if (files.some((file) => !file.size || file.size > 50 * 1024 * 1024 || file.name.length > 255 || [...file.name].some((char) => char.charCodeAt(0) < 32 || '/\\:'.includes(char)))) {
      setDraft([]); setError('选择中有空文件、超过 50 MiB 的文件或不合法文件名。请修正后重新选择；没有静默跳过文件。'); return
    }
    setDraft(prepare(files, albumId ? year : undefined))
  }
  function edit(id: string, value: string) { setDraft((rows) => rows.map((row) => row.id === id ? { ...row, year: value } : row)); setConfirmed(false) }
  function move(index: number, step: number) {
    setDraft((rows) => { const next = [...rows]; [next[index], next[index + step]] = [next[index + step], next[index]]; return next })
    setConfirmed(false)
  }
  function confirmQueue() {
    const planned = planJobs(draft, albumId)
    queueId.current = crypto.randomUUID()
    jobsRef.current = planned; publish(); setLocked(true); setDraft([])
    setSearch((value) => { value.set('queue', queueId.current); return value }, { replace: true })
    setNotice('归属和顺序已固定。点击上传开始；只有保存成功才会出现在影集。')
  }
  async function ensureBatch(job: Job, signal: AbortSignal) {
    if (job.batch) return
    if (jobsRef.current.some((earlier) => earlier.index < job.index && earlier.year === job.year && !earlier.batch && !earlier.canceled)) throw new ApiError(409, 'PREVIOUS_BATCH_PENDING', '请先创建或取消同影集前批，避免刷新后遗漏顺序')
    for (const entry of job.entries) {
      signal.throwIfAborted()
      if (entry.metadata) continue
      if (!entry.file) throw new ApiError(422, 'FILE_REQUIRED', '请重新选择未上传的原文件')
      entry.activity = '正在计算内容校验值'; publish()
      const digest = await crypto.subtle.digest('SHA-256', await entry.file.arrayBuffer())
      signal.throwIfAborted()
      entry.metadata = { original_filename: entry.name, byte_size: entry.size,
        sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('') }
      entry.activity = undefined
    }
    if (!job.albumId) {
      const album = await api<{ id: string }>(`/cities/${cityId}/albums`, {
        method: 'POST', signal, body: JSON.stringify({ year: job.year }),
      })
      job.albumId = album.id
    }
    job.createAttempted = true
    const batch = await api<ImportBatch>(`/albums/${job.albumId}/imports`, {
      method: 'POST', signal, headers: { 'Idempotency-Key': `${queueId.current}_${String(job.index).padStart(6, '0')}` },
      body: JSON.stringify({ items: job.entries.map((entry) => entry.metadata) }),
    })
    applyBatch(job, batch); publish()
  }
  async function uploadJob(job: Job, signal: AbortSignal, only?: number) {
    job.error = undefined
    await ensureBatch(job, signal)
    if (job.batch!.state !== 'open') return
    const pending = job.entries.map((entry, index) => ({ entry, index })).filter(({ entry, index }) =>
      (only === undefined || only === index) && !['staged', 'committed', 'discarded'].includes(entry.item?.state ?? 'pending'))
    let cursor = 0
    const worker = async () => {
      while (cursor < pending.length) {
        signal.throwIfAborted()
        const { entry } = pending[cursor++]
        if (!entry.file) { entry.error = '请在本行重新选择同一原文件'; publish(); continue }
        entry.error = undefined; entry.progress = 0; entry.activity = '正在传输'; publish()
        try {
          const item = await uploadFile<ImportItem>(`/imports/${job.batch!.id}/items/${entry.item!.id}/content`, entry.file, signal, (percent) => {
            entry.progress = percent; entry.activity = percent === 100 ? '已发送，服务端校验中' : '正在传输'; publish()
          })
          entry.item = item
          job.batch!.items[item.item_index] = item
          entry.progress = 100; entry.file = undefined
        } catch (reason) {
          if (isAbort(reason)) throw reason
          entry.error = errorMessage(reason)
        } finally { entry.activity = undefined; publish() }
      }
    }
    // Wait for both workers to settle before unlocking controls after a stop.
    const results = await Promise.allSettled([worker(), worker()])
    signal.throwIfAborted()
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
  function uploadAll() {
    void run('上传队列', async (signal) => {
      const blockedYears = new Set<number | null>()
      for (const job of jobsRef.current) {
        signal.throwIfAborted()
        if (job.canceled || job.batch?.state === 'committed' || job.batch?.state === 'canceled' || job.batch?.state === 'expired') continue
        if (blockedYears.has(job.year)) { job.error = '同影集前批创建未确认，请先重试或取消前批'; continue }
        try { await uploadJob(job, signal) }
        catch (reason) {
          if (isAbort(reason)) throw reason
          job.error = errorMessage(reason); if (!job.batch) blockedYears.add(job.year)
        }
        publish()
      }
      setNotice('本轮上传已结束。请逐批检查结果并保存；失败项可重试，部分保存需要你明确选择。')
    })
  }
  function query() {
    void run('查询队列状态', async (signal) => {
      const batches = await readQueue(queueId.current, signal, cityId, albumId)
      for (const batch of batches) {
        const job = jobsRef.current.find((value) => value.index === batch.queue_index)
        if (job) {
          applyBatch(job, batch); job.error = undefined
          if (job.review) { job.commit = undefined; job.review = false }
        } else jobsRef.current.push(restoredJob(batch))
      }
      jobsRef.current.sort((a, b) => a.index - b.index)
      setNotice('已查询服务端状态；接收中的项可稍后查询，未完成项需重选同一文件。')
    })
  }
  function save(job: Job, partial: boolean) {
    void run('保存到影集', async (signal) => {
      try {
        const payload = job.commit ?? { expected_album_revision: job.batch!.album_revision, allow_partial: partial }
        job.commit = payload; job.error = undefined
        const result = await api<ImportReceipt>(`/imports/${job.batch!.id}/commit`, { method: 'POST', signal, body: JSON.stringify(payload) })
        job.batch!.state = 'committed'; job.batch!.result = result; job.batch!.album_revision = result.album_revision
        for (const entry of job.entries) {
          if (entry.item) entry.item.state = result.failed_item_ids.includes(entry.item.id) ? 'discarded' : 'committed'
          entry.file = undefined; entry.error = undefined
        }
        // Only our own sequential commit advances subsequent batches locally.
        for (const next of jobsRef.current) if (next.index > job.index && next.albumId === job.albumId && next.batch && !next.commit) next.batch.album_revision = result.album_revision
        setNotice('已加入影集，原图已独立保存。其他影集的失败不影响本批结果。')
      } catch (reason) {
        if (isAbort(reason)) throw reason
        job.error = errorMessage(reason) + ' 未确认保存结果时请查询或用相同参数重试，不会重复添加。'
        job.review = reason instanceof ApiError && reason.code === 'ALBUM_CHANGED'
      }
    })
  }
  function cancel(job: Job) {
    void run('取消本批', async (signal) => {
      try {
        // Resolve a possibly lost creation response using exactly the same key
        // before canceling; never claim a network-ambiguous create was canceled.
        if (!job.batch && job.createAttempted) await ensureBatch(job, signal)
        if (job.batch) {
          await api<void>(`/imports/${job.batch.id}`, { method: 'DELETE', signal })
          job.batch.state = 'canceled'
        }
        job.canceled = true; job.error = undefined
        for (const entry of job.entries) { entry.file = undefined; entry.activity = undefined; entry.error = undefined; if (entry.item) entry.item.state = 'discarded' }
        setNotice('本批已取消，未加入影集的暂存副本已请求清理；源文件和已保存照片不受影响。')
      } catch (reason) {
        if (isAbort(reason)) throw reason
        job.error = '取消尚未确认，请查询状态。' + errorMessage(reason)
      }
    })
  }
  function reselect(job: Job, index: number, file?: File) {
    const entry = job.entries[index]
    if (!file) return
    if (file.name !== entry.name || file.size !== entry.size) { entry.file = undefined; entry.error = '请选择本行同名、同大小的原文件；服务端还会核对内容'; publish(); return }
    entry.file = file; entry.error = undefined; publish()
  }
  function reselectMany(files: File[]) {
    const entries = jobsRef.current.filter((job) => !job.canceled && (!job.batch || job.batch.state === 'open')).flatMap((job) => job.entries)
      .filter((entry) => !['staged', 'committed', 'discarded'].includes(entry.item?.state ?? ''))
    let matched = 0
    for (const file of files) {
      const candidates = entries.filter((entry) => entry.name === file.name && entry.size === file.size)
      if (candidates.length !== 1 || files.filter((other) => other.name === file.name && other.size === file.size).length !== 1) continue
      candidates[0].file = file; candidates[0].error = undefined; matched++
    }
    publish(); setNotice(`已匹配 ${matched} 个文件；同名同大小存在歧义时请逐行选择，其余不匹配文件未加入。服务端仍会核对内容。`)
  }
  function reset() {
    jobsRef.current = []; publish(); setLocked(false); setDraft([]); setConfirmed(false); setError(''); setNotice(''); setPage(0)
    queueId.current = crypto.randomUUID()
    setSearch((value) => { value.delete('queue'); return value }, { replace: true })
  }

  const invalid = draft.some((row) => !validYear(row.year))
  const conflict = albumId && draft.some((row) => row.numbering && row.numbering.year !== year)
  const numbered = draft.filter((row) => row.numbering)
  const duplicates = new Set(numbered.map((row) => `${row.year}-${row.numbering!.order}`)).size !== numbered.length
  const done = jobs.length > 0 && jobs.every((job) => job.canceled || ['committed', 'canceled'].includes(job.batch?.state ?? ''))
  const total = jobs.reduce((count, job) => count + job.entries.length, 0)
  const saved = jobs.reduce((count, job) => count + (job.batch?.result?.photo_ids.length ?? 0), 0)
  return <section className="batch-import" aria-labelledby="batch-title">
    <div className="page-heading"><div><p className="eyebrow">IMPORT YOUR MEMORIES</p><h1 id="batch-title">批量导入原图</h1>
      <p className="muted">{cityName}{albumId ? ` / ${yearLabel(year ?? null)} · 固定归属` : ' · 按核对后的年份分组'}</p></div><span className="chapter-mark">核对 → 上传 → 保存</span></div>
    <p className="scope-note">JPEG、PNG、静态 WebP；单张最多 50 MiB / 8000 万像素。保留原始字节，不改源文件。每批最多 400 张，超出自动拆批；同影集依次保存，不改变已有照片顺序。</p>
    {!locked ? <>
      <div className="file-picker"><label htmlFor="batch-files">选择多张原图</label><input ref={input} id="batch-files" type="file" multiple accept={accept} onChange={(event) => choose(Array.from(event.target.files ?? []))} /></div>
      {!!draft.length && <>
        <div className="section-heading"><h2>核对 {draft.length} 张照片</h2><span>全有编号时按数字排序；其他情况保留选择顺序</span></div>
        <p className="scope-note">例如 24-1.jpg 表示 2024 年第 1 张；两位年份按 2000–2099 识别。无法识别时请指定年份或选“未标年份”，不会使用当前年份。相同编号不会合并，重名文件也独立保留。</p>
        {conflict && <p className="import-warning">文件名年份与当前影集不同，确认后仍全部加入 {yearLabel(year ?? null)}，不会自动改归属。</p>}
        {duplicates && <p className="import-warning">发现重复编号：均会保留，相同编号先沿用选择顺序，可在下方手动调整。</p>}
        {!albumId && <div className="batch-year-tools"><label>统一指定年份 <input aria-label="统一指定年份" inputMode="numeric" maxLength={4} value={allYear} onChange={(event) => setAllYear(event.target.value)} /></label>
          <button className="quiet-button" disabled={!validYear(allYear) || allYear === 'unmarked'} onClick={() => { setDraft((rows) => rows.map((row) => ({ ...row, year: allYear }))); setConfirmed(false) }}>应用到全部</button>
          <button className="quiet-button" onClick={() => { setDraft((rows) => rows.map((row) => row.year ? row : { ...row, year: 'unmarked' })); setConfirmed(false) }}>未识别项设为未标年份</button></div>}
        <div className="queue-table-wrap"><table className="queue-table"><thead><tr><th>顺序</th><th>原文件</th><th>归属年份</th><th>调整</th></tr></thead>
          <tbody>{draft.slice(page * 50, page * 50 + 50).map((row, offset) => {
            const index = page * 50 + offset
            return <tr key={row.id}><td>{index + 1}</td><td><strong>{row.file.name}</strong><small>{(row.file.size / 1024).toFixed(1)} KiB · {row.numbering ? `识别编号 ${row.numbering.order}` : '未识别编号'}</small></td>
              <td>{albumId ? yearLabel(year ?? null) : <><input aria-label={`第 ${index + 1} 项年份`} inputMode="numeric" maxLength={4} placeholder="待指定" disabled={row.year === 'unmarked'} value={row.year === 'unmarked' ? '' : row.year} onChange={(event) => edit(row.id, event.target.value)} />
                <label className="checkbox-label"><input type="checkbox" checked={row.year === 'unmarked'} onChange={(event) => edit(row.id, event.target.checked ? 'unmarked' : '')} />未标年份</label></>}</td>
              <td><div className="queue-row-actions"><button className="quiet-button" aria-label={`上移第 ${index + 1} 项`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
                <button className="quiet-button" aria-label={`下移第 ${index + 1} 项`} disabled={index === draft.length - 1} onClick={() => move(index, 1)}>↓</button>
                <button className="quiet-button" aria-label={`移除第 ${index + 1} 项`} onClick={() => { setDraft((rows) => rows.filter((item) => item.id !== row.id)); setPage(0); setConfirmed(false) }}>移除</button></div></td></tr>
          })}</tbody></table></div>
        {draft.length > 50 && <div className="upload-actions"><button className="quiet-button" disabled={!page} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {Math.ceil(draft.length / 50)}</span><button className="quiet-button" disabled={(page + 1) * 50 >= draft.length} onClick={() => setPage(page + 1)}>下一页</button></div>}
        {invalid && <p className="import-warning">仍有文件未指定有效年份（1–9999），请核对或设为未标年份。</p>}
        <label className="checkbox-label confirm-import"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已核对全部文件的城市、年份和顺序</label>
        <button className="primary-button" disabled={!confirmed || invalid} onClick={confirmQueue}>确认队列</button>
      </>}
    </> : <>
      <div className="queue-summary"><strong>共 {total} 项 · 已保存 {saved} 项</strong><span>暂存不等于保存；每个影集独立报告结果。</span></div>
      <div className="upload-actions">
        {!done && <button className="primary-button" disabled={!!busy || !jobs.length} onClick={uploadAll}>上传队列 / 重试未完成项</button>}
        <button className="quiet-button" disabled={!!busy} onClick={query}>查询队列状态{jobs.some((job) => job.review) ? ' / 重新核对影集' : ''}</button>
        {(busy === '上传队列' || busy === '重试单项') && <button className="quiet-button" onClick={() => active.current?.abort()}>停止传输</button>}
        {(done || !jobs.length) && <button className="quiet-button" disabled={!!busy} onClick={reset}>开始新队列</button>}
      </div>
      {!done && jobs.length > 0 && <div className="file-picker"><label htmlFor="reselect-files">重新选择未完成原图（可多选）</label><input id="reselect-files" type="file" multiple accept={accept} disabled={!!busy} onChange={(event) => reselectMany(Array.from(event.target.files ?? []))} /></div>}
      {!jobs.length && !busy && <p className="scope-note">没有找到本账号已登记的批次。未登记文件不在服务端，需重新选择；网络结果不明时可再次查询。</p>}
      {jobs.map((job) => {
        const staged = job.entries.filter((entry) => entry.item?.state === 'staged').length
        const receiving = job.entries.some((entry) => entry.item?.state === 'receiving')
        const receipt = job.batch?.result
        const closed = job.canceled || ['committed', 'canceled', 'expired'].includes(job.batch?.state ?? '')
        const ready = canCommit(job, jobs) && !busy && !receiving && staged > 0
        return <article className="import-job" key={job.index} data-job-index={job.index}>
          <div className="section-heading"><h2>{yearLabel(job.year)} · 第 {job.index + 1} 批</h2><span>{job.entries.length} 项 · {staged} 项待保存{receipt ? ` · 已保存 ${receipt.photo_ids.length} 项` : ''}</span></div>
          {job.albumId && <Link to={`/albums/${job.albumId}`}>查看这个影集 ↗</Link>}
          {job.batch && <p className="scope-note">{job.batch.state === 'expired' ? '本批已过期，不能继续上传或保存，可取消并清理暂存。' : `暂存截止：${new Date(job.batch.expires_at).toLocaleString()}`}</p>}
          <details open={job.entries.length <= 10}><summary>逐文件状态（{job.entries.length} 项）</summary>
            <ol className="upload-list">{job.entries.map((entry, index) => <li key={index}>
              <div><strong>{index + 1}. {entry.name}</strong><small>{entry.activity ?? stateLabels[entry.item?.state ?? 'pending']}{entry.item?.failure_code ? ` · ${entry.item.failure_code}` : ''}</small>
                {entry.activity && <><progress max={100} value={entry.progress} aria-label={`${entry.name} 传输进度`} /><small>{entry.progress}% · 100% 后仍需服务端校验</small></>}
                {entry.error && <p className="form-error" role="alert">{entry.error}</p>}
              </div>
              {!closed && !['staged', 'committed'].includes(entry.item?.state ?? '') && <div className="entry-retry">
                <input type="file" accept={accept} disabled={!!busy} aria-label={`第 ${job.index + 1} 批第 ${index + 1} 项重选原图`} onChange={(event) => reselect(job, index, event.target.files?.[0])} />
                <button className="quiet-button" disabled={!!busy || !entry.file} onClick={() => void run('重试单项', async (signal) => { try { await uploadJob(job, signal, index) } catch (reason) { if (isAbort(reason)) throw reason; job.error = errorMessage(reason) } })}>重试此项</button>
              </div>}
            </li>)}</ol>
          </details>
          {job.error && <p className="form-error" role="alert">{job.error}</p>}
          {receipt && <p className="saved-notice" role="status">已加入影集 {receipt.photo_ids.length} 项。{receipt.failed_item_ids.length > 0 && `另有 ${receipt.failed_item_ids.length} 项未保存且已废弃；可开始新队列重新导入，追加在末尾。`}</p>}
          {!closed && <div className="upload-actions">
            <button className="primary-button" disabled={!ready || (!job.commit && staged !== job.entries.length)} onClick={() => save(job, false)}>{job.commit ? '重试本批保存（相同参数）' : '保存本批全部照片'}</button>
            {staged > 0 && staged < job.entries.length && !job.commit && <button className="quiet-button" disabled={!ready} onClick={() => save(job, true)}>先保存成功项（{staged} 项），放弃其余项</button>}
            {!canCommit(job, jobs) && job.batch && <span className="scope-note">请先完成同影集前批，或查询重新核对。</span>}
          </div>}
          {!receipt && !job.canceled && job.batch?.state !== 'canceled' && <button className="quiet-button cancel-batch" disabled={!!busy} onClick={() => cancel(job)}>取消本批{job.batch?.state === 'expired' ? '并清理' : ''}</button>}
          {job.canceled || job.batch?.state === 'canceled' ? <p role="status">本批已取消。</p> : null}
        </article>
      })}
    </>}
    {busy && <p role="status">正在{busy}…</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="staged-notice" role="status">{notice}</p>}
    <p className="scope-note">地址仅保存随机队列标识，不保存文件名或照片。刷新后只恢复已登记批次；本机文件需重选，不是断点续传。上传可停止后查询/取消；保存结果不明时先查询，避免另开队列重复导入。</p>
  </section>
}

function restoredJob(batch: QueueBatch): Job {
  const job: Job = { index: batch.queue_index, year: batch.year, albumId: batch.album_id, entries: batch.items.map((item) => ({ name: item.original_filename, size: item.byte_size, progress: 0 })) }
  applyBatch(job, batch)
  return job
}

async function readQueue(id: string, signal: AbortSignal, cityId: string, albumId?: string) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new ApiError(422, 'INVALID_QUEUE', '队列标识无效，请返回正确入口')
  const batches: QueueBatch[] = []
  let after: number | null = -1
  while (after !== null) {
    const result: { items: QueueBatch[]; next_index: number | null } = await api(`/imports/queue/${id}?after=${after}`, { signal })
    if (result.items.some((batch) => batch.city_id !== cityId || (albumId && batch.album_id !== albumId))) throw new ApiError(409, 'WRONG_QUEUE', '该队列不属于本入口，请返回原城市或影集')
    batches.push(...result.items)
    after = result.next_index
  }
  return batches
}
