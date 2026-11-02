export function isValidEmail(value: string): boolean {
  const trimmed = value.trim()
  const at = trimmed.indexOf('@')
  if (at <= 0) return false
  const afterAt = trimmed.slice(at + 1)
  const dot = afterAt.lastIndexOf('.')
  if (dot < 0 || afterAt.length - dot <= 1) return false
  return !trimmed.includes(' ')
}
