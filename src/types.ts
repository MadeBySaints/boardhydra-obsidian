// The parts of the BoardHydra API (/api/v1) the plugin uses.

export interface BHBoard { id: string; name: string; role?: string }

export interface BHList { id: string; idBoard: string; name: string; pos: number; closed: boolean }

export interface BHLabel { id: string; idBoard: string; name: string; color: string | null; pos: number }

export interface BHMember { id: string; fullName: string; username: string }

export interface BHCheckItem {
  id: string
  name: string
  state: 'complete' | 'incomplete'
  pos: number
  children?: BHCheckItem[]
}

export interface BHChecklist { id: string; idCard: string; name: string; checkItems: BHCheckItem[] }

export interface BHLink { id?: string; url: string; title?: string }

export interface BHCard {
  id: string
  idBoard: string
  idList: string
  name: string
  desc: string
  pos: number
  closed: boolean
  idLabels: string[]
  idMembers: string[]
  start: string | null
  due: string | null
  dueComplete: boolean
  checklists: BHChecklist[] | null
  links: BHLink[] | null
  dateLastActivity: string
}

export interface BHSnapshot {
  board: BHBoard
  lists: BHList[]
  cards: BHCard[]
  labels: BHLabel[]
  members: BHMember[]
}

export interface BHEvent { type: string; op: 'upsert' | 'delete'; data: any; origin?: string }

/** The fields of a card a note can change (sent as a PATCH). */
export interface CardPatch {
  idList?: string
  name?: string
  desc?: string
  pos?: number
  closed?: boolean
  idLabels?: string[]
  idMembers?: string[]
  start?: string | null
  due?: string | null
  dueComplete?: boolean
  checklists?: BHChecklist[]
  links?: BHLink[]
  ifUpdatedAt?: string
}
