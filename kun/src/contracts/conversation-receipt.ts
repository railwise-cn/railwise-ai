type ConversationReceiptCandidate = {
  id: string
  turnId: string
  kind: string
  conversationReceiptId?: string
}

/** Recognizes confirmed local receipts and the exact pre-marker legacy shape. */
export function isConversationReceiptItem(item: ConversationReceiptCandidate): boolean {
  const marked = item.conversationReceiptId === item.turnId && /^command_[a-z0-9_-]{1,256}$/i.test(item.turnId)
  const legacy = item.conversationReceiptId === undefined && /^command_[a-f0-9]{32}$/.test(item.turnId)
  if (!marked && !legacy) return false
  return item.kind === 'user_message' && item.id === `item_${item.turnId}_user` ||
    item.kind === 'assistant_text' && item.id === `item_${item.turnId}_receipt`
}
