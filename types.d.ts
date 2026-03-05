export interface ConversationMeta {
  id: string
  metadata?: Record<string, unknown>
  createdAt?: Date
  updatedAt?: Date
}

export interface Conversation {
  id: string
  messages?: any[]
  metadata?: Record<string, unknown>
  createdAt?: Date
  updatedAt?: Date
}

export interface IConversationStorage {
  get(id: string): Promise<Conversation | null>
  save(conversation: Conversation): Promise<void>
  list(filter?: { userId?: string }): Promise<ConversationMeta[]>
  delete(id: string): Promise<void>
}
