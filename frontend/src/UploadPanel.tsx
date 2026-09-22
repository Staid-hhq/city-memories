import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api, ApiError, errorMessage, isAbort } from './api'

type Item = { id: string; original_filename: string; byte_size: number; state: string; failure_code: string | null }
type Receipt = { photo_ids: string[]; album_revision: number; album_id: string }
type Batch = { id: string; album_id: string; album_revision: number; state: string; items: Item[]; result: Receipt | null }
type Props = { albumId: string; cityName: string; year: number | null; onSaved: (photoId: string) => void }

export function UploadPanel({ albumId, cityName, year, onSaved }: Props) {
  const [search, setSearch] = useSearchParams()
  const [resumeId, setResumeId] = useState(search.get('import'))
  const [file, setFile] = useState<File | null>(null)
  const [batch, setBatch] = useState<Batch | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [revision, setRevision] = useState(0)
  const [working, setWorking] = useState<string | null>(resumeId ? '正在查询上次导入…' : null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [review, setReview] = useState(false)
  const [unresolved, setUnresolved] = useState(!!resumeId)
  const active = useRef<AbortController | null>(null)
  const requestKey = useRef(crypto.randomUUID())
  const input = useRef<HTMLInputElement | null>(null)
  const applyBatch = useCallback((value: Batch) => {
    if (value.album_id !== albumId || value.items.length !== 1) {
      throw new ApiError(409, 'WRONG_IMPORT', '该导入不属于本影集的单张添加流程，请返回正确入口。')
    }
    setBatch(value); setRevision(value.album_revision); setUnresolved(false)
    if (value.result) { setReceipt(value.result); onSaved(value.result.photo_ids[0]) }
  }, [albumId, onSaved])

  useEffect(() => {
    if (!resumeId) return
    const controller = new AbortController()
    active.current = controller
    void api<Batch>(`/imports/${encodeURIComponent(resumeId)}`, { signal: controller.signal })
      .then(applyBatch).catch((reason) => { if (!isAbort(reason)) setError(errorMessage(reason)) })
      .finally(() => { if (!controller.signal.aborted) setWorking(null) })
    return () => controller.abort()
  }, [resumeId, applyBatch])
  useEffect(() => () => active.current?.abort(), [])

  function begin(message: string) {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setWorking(message); setError(''); setNotice('')
    return controller
  }
  function finish(controller: AbortController) {
    if (active.current === controller && !controller.signal.aborted) setWorking(null)
  }
  function choose(selected: File | undefined) {
    setError(''); setNotice('')
    if (!selected) { setFile(null); return }
    if (selected.size === 0 || selected.size > 50 * 1024 * 1024) {
      setFile(null); setError('请选择非空图片，单张不超过 50 MiB。'); return
    }
    if (batch && (selected.name !== batch.items[0].original_filename || selected.size !== batch.items[0].byte_size)) {
      setFile(null); setError('请重新选择这次导入的同一文件，或先取消本次导入。'); return
    }
    if (!batch) requestKey.current = crypto.randomUUID()
    setFile(selected)
  }
  async function upload() {
    if (!file) { setError('请先选择一张图片。'); return }
    const controller = begin('正在校验文件内容…')
    try {
      let current = batch
      if (!current) {
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
        controller.signal.throwIfAborted()
        const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
        current = await api<Batch>(`/albums/${albumId}/imports`, {
          method: 'POST', signal: controller.signal, headers: { 'Idempotency-Key': requestKey.current },
          body: JSON.stringify({ items: [{ original_filename: file.name, byte_size: file.size, sha256 }] }),
        })
        applyBatch(current)
        const createdId = current.id
        setSearch((value) => { value.set('import', createdId); return value }, { replace: true })
      }
      setWorking('正在传输并校验原图…')
      const body = new FormData()
      body.append('file', file)
      const item = await api<Item>(`/imports/${current.id}/items/${current.items[0].id}/content`, {
        method: 'PUT', signal: controller.signal, body,
      })
      setBatch({ ...current, items: [item] })
      setFile(null)
      if (input.current) input.current.value = ''
      setNotice('已传输并校验，尚未加入影集。请确认归属后保存。')
    } catch (reason) { if (!isAbort(reason)) setError(errorMessage(reason)) }
    finally { finish(controller) }
  }
  async function save() {
    if (!batch) return
    const controller = begin('正在保存到影集…')
    try {
      const result = await api<Receipt>(`/imports/${batch.id}/commit`, {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({ expected_album_revision: revision, allow_partial: false }),
      })
      setReceipt(result); setFile(null); setNotice('已加入影集，原图已独立保存。')
      onSaved(result.photo_ids[0])
    } catch (reason) {
      if (!isAbort(reason)) {
        setError(errorMessage(reason) + ' 未确认保存结果时可查询状态，或重试保存，不会重复添加。')
        setReview(reason instanceof ApiError && reason.code === 'ALBUM_CHANGED')
      }
    } finally { finish(controller) }
  }
  async function status() {
    const id = batch?.id ?? resumeId
    if (!id) return
    const controller = begin('正在重新核对…')
    try {
      applyBatch(await api<Batch>(`/imports/${encodeURIComponent(id)}`, { signal: controller.signal }))
      setReview(false)
    } catch (reason) { if (!isAbort(reason)) setError(errorMessage(reason)) }
    finally { finish(controller) }
  }
  function reset() {
    setResumeId(null)
    setBatch(null); setReceipt(null); setFile(null); setError(''); setReview(false); setUnresolved(false)
    requestKey.current = crypto.randomUUID()
    if (input.current) input.current.value = ''
    setSearch((value) => { value.delete('import'); return value }, { replace: true })
  }
  async function cancel() {
    if (!batch) { reset(); setNotice('已清除本页的导入入口。'); return }
    const controller = begin('正在取消本次导入…')
    try {
      await api<void>(`/imports/${batch.id}`, { method: 'DELETE', signal: controller.signal })
      reset(); setNotice('已取消，未加入影集；电脑上的源文件没有改变。')
    } catch (reason) { if (!isAbort(reason)) setError('取消尚未完成。' + errorMessage(reason)) }
    finally { finish(controller) }
  }
  const staged = batch?.items[0].state === 'staged'
  const closed = batch && batch.state !== 'open' && !receipt
  return <section className="upload-panel" aria-labelledby="upload-title" aria-busy={!!working}>
    <div className="section-heading"><h2 id="upload-title">添加一张原图</h2><span>保留原始字节 · 不压缩</span></div>
    <p className="upload-destination">保存到：<strong>{cityName} / {year === null ? '未标年份' : `${year} 年`}</strong></p>
    <p className="muted">支持 JPEG、PNG、静态 WebP；单张最多 50 MiB、8000 万像素。只保存独立副本，不移动或改写源文件。</p>
    {!receipt && !closed && <>
      {!staged && <div className="file-picker"><label htmlFor="original-file">选择原图</label>
        <input ref={input} id="original-file" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" disabled={!!working || unresolved} onChange={(event) => choose(event.target.files?.[0])} />
      </div>}
      {(file || batch) && <p className="file-summary">{batch?.items[0].original_filename ?? file?.name} · {((batch?.items[0].byte_size ?? file?.size ?? 0) / 1024).toFixed(1)} KiB</p>}
      {batch && !staged && !working && <p className="field-help">当前状态：{batch.items[0].state === 'receiving' ? '正在接收，可稍后查询状态' : '待重新选择同一文件并上传'}。</p>}
      {staged && <p className="staged-notice" role="status">已传输，待保存到影集。</p>}
      <div className="upload-actions">
        {!staged && <button className="primary-button" disabled={!!working || !file || unresolved} onClick={() => void upload()}>上传并校验</button>}
        {staged && <button className="primary-button" disabled={!!working || review} onClick={() => void save()}>保存到影集</button>}
        {(batch || resumeId) && <button className="quiet-button" disabled={!!working} onClick={() => void status()}>{review ? '重新核对影集' : '查询导入状态'}</button>}
        {(batch || resumeId) && <button className="quiet-button" disabled={!!working} onClick={() => void cancel()}>取消本次导入</button>}
      </div>
    </>}
    {receipt && <div className="saved-notice"><p role="status">已加入影集，原图已独立保存。</p><button className="quiet-button" onClick={() => { reset(); setNotice('可以继续选择下一张图片。') }}>继续添加一张</button></div>}
    {closed && <p>这次导入已结束。<button className="quiet-button" onClick={() => { reset(); setNotice('可以重新选择图片。') }}>开始新的导入</button></p>}
    {working && <p role="status">{working}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && !receipt && <p role="status">{notice}</p>}
    <p className="scope-note">重新打开本页可查询此次导入；未传完的文件需重新选择。当前每次添加一张，批量队列将在后续开放。</p>
  </section>
}
