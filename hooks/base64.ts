// Base64 for byte arrays: the environment's Uint8Array.fromBase64 and
// toBase64 where it has them, atob and btoa where it does not.

type WithFromBase64 = { fromBase64?: (text: string) => Uint8Array }
type WithToBase64 = { toBase64?: () => string }

export function fromBase64(text: string): Uint8Array {
  const native = (Uint8Array as unknown as WithFromBase64).fromBase64
  if (native !== undefined) return native.call(Uint8Array, text)
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as unknown as WithToBase64).toBase64
  if (native !== undefined) return native.call(bytes)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x2000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000))
  }
  return btoa(binary)
}
