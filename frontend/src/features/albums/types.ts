export type City = { id: string; name: string; parent_name: string | null; unit_kind: string; can_create: boolean }
export type Album = {
  id: string; city: City; year: number | null; revision: number; photo_count: number
  cover_photo_id: string | null; original_url: string | null
}
export type CityAlbum = {
  city: City; album_count: number; photo_count: number; latest_year: number | null
  has_unmarked: boolean; cover_photo_id: string | null; original_url: string | null
}
export type Atlas = { items: { city: City; album_count: number; photo_count: number; lit: boolean }[]; album_count: number; photo_count: number }
