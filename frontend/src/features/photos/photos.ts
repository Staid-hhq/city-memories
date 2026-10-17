export type Photo = {
  id: string; album_id: string; original_filename: string; width: number; height: number
  byte_size: number; position: number; revision: number; has_note: boolean; original_url: string
}
export type PhotoPage = { items: Photo[]; next_cursor: string | null; album_revision: number; photo_count: number }
export type Detail = Photo & { note: string; album_revision: number; previous_photo_id: string | null; next_photo_id: string | null; ordinal: number; photo_count: number }
export type Note = { id: string; album_id: string; note: string; revision: number; has_note: boolean }
